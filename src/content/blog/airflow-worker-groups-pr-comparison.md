---
title: "[InInput] 從我的 Airflow PR 到更好的解法：Celery Worker Groups 的設計比較"
date: 2025-11-01
lang: zh
category: work
---

## Overview

### 讓不同 queue 使用不同的 Worker

使用 Airflow CeleryExecutor 時，我們遇到一個需求：讓不同 queue 的任務交給不同的 Worker，並把這些 Worker 安排到適合的 Kubernetes 節點。

這個需求主要想解決: 我們有一組跑在特定 queue 上的 DAG，他會有落檔到實體 VM 上的需求，上一個 Task 處理完檔案後並交由下一個 task 進一步處理。<br>
前後的兩個 Task 雖然都在同跑在同一個 queue，但可能因為無法指定要跑在同一個 Worker Node 上，導致下一個 Task 跑在另外一個 Worker Node，因而無法處理上一個 Task 落檔的檔案． 

這裡有兩層分工：Celery queue 決定 Worker 消費哪些任務，Kubernetes 的排程設定決定 Worker Pod 可以落在哪些節點。只設定 queue，並不會自動讓任務跑到特定節點。

我因此提出 [issue #56591](https://github.com/apache/airflow/issues/56591)，並提交 [PR #56589](https://github.com/apache/airflow/pull/56589)。後來社群出現另一個解法：[PR #58547](https://github.com/apache/airflow/pull/58547)。兩者都要讓 Helm Chart 支援多組 Celery Worker，但組織模板的方式不同。

重新對照程式碼後，我認為最值得學習的地方，是如何讓新增群組沿用既有的 Worker 渲染邏輯，以及這個選擇如何影響 autoscaling、設定繼承與 review 成本。

## chart/values.yaml

### 我的版本：queueGroups 取代預設 Worker

我的 PR 最早使用 `workers.celeryQueueGroups`，經 review 後改成 `workers.celery.queueGroups`。

以兩組 Worker 為例，最終介面可以寫成以下片段。為了讓比較聚焦，省略既有環境的其他設定；這個版本的群組功能不支援 KEDA／HPA。

```yaml
executor: CeleryExecutor
workers:
  celery:
    queueGroups:
      - name: general
        queues: "default,email"
        replicas: 2
      - name: heavy
        queues: "reports,batch"
        replicas: 2
        nodeSelector:
          workload: memory-intensive
        resources:
          requests:
            memory: "4Gi"
            cpu: "2"
```

`queueGroups` 有內容時，只建立清單中的群組；沒有內容時，才走原本單一 Worker 的路徑。因此，想繼續處理 default queue，就要像上例一樣，把它明確放進某一組。

每組要求 `name`、`queues`、`replicas`，其餘允許的欄位由 schema 逐項列出。這種設計讓介面很具體，但每增加一個可覆寫項目，都必須確認 schema 與模板是否一起接好。

Ref: [queueGroups 設定與範例](https://github.com/apache/airflow/blob/8b76366a18073ceb497f45381ef5ca4a6fb46786/chart/values.yaml#L1019-L1048)

### 另一個版本：sets 加上明確的預設群組開關

#58547 的最終設定是 `workers.celery.sets`，queue 欄位改用單數的 `queue`，內容仍可以是逗號分隔的多個 queue。

要得到與前例相近的「只建立兩組指定 Worker」拓樸，需要關閉額外的預設 Worker：

```yaml
executor: CeleryExecutor
workers:
  enableDefault: false
  celery:
    sets:
      - name: general
        queue: "default,email"
        replicas: 2
      - name: heavy
        queue: "reports,batch"
        replicas: 2
        nodeSelector:
          workload: memory-intensive
        resources:
          requests:
            memory: "4Gi"
            cpu: "2"
```

`workers.enableDefault` 預設為 `true`。若保留預設值，會多出原本的 Worker，總共三組。這個 PR 讓「是否保留預設 Worker」成為獨立選擇，不必綁在群組清單是否為空的判斷裡。

Ref: [sets 設定與範例](https://github.com/apache/airflow/blob/989dba0ceede4ac802e46688a4ab537abb80232c/chart/values.yaml#L1077-L1099)、[enableDefault 與預設 queue](https://github.com/apache/airflow/blob/989dba0ceede4ac802e46688a4ab537abb80232c/chart/values.yaml#L640-L645)

## chart/templates/workers/worker-deployment.yaml

### 我的方式：逐一搬運群組參數

在 Helm 模板中，`.` 表示目前的 context。進入 `range` 後，`.` 會變成當次迭代的項目；原本能用 `.Values` 讀取的設定，就不能直接用相同方式取得。`$` 則保留該模板執行時的根 context。

我的處理方式是先建立群組清單，再進入 range 後逐項取出欄位，`.`已經變成「目前這組 Worker」，；要讀整份 Chart 的共用設定，就要透過 `$.Values`。以下節錄原始模板中的幾個關鍵行，中間的其他處理省略：

```yaml
{{- range $groupIndex, $workerGroup := $workerGroups }}
{{- $groupQueues := $workerGroup.queues }}
{{- $groupReplicas := $workerGroup.replicas | default 1 }}
{{- $groupNodeSelector := $workerGroup.nodeSelector | default dict }}
{{- $groupResources := $workerGroup.resources | default dict }}

{{- $nodeSelector := or $groupNodeSelector $.Values.nodeSelector }}
{{- $affinity := or $.Values.workers.affinity $.Values.affinity }}
```

這讓每個欄位的來源直接可見，但也讓設定繼承散落到不同變數與分支。例如，這裡的 `nodeSelector` 取群組值後回退到全域值；`affinity` 卻仍讀取共用的 `workers.affinity` 或全域設定。

隨著迴圈包住整份 Worker 模板，大量既有的 `.Values`、`.Release` 與 helper 呼叫也需要改成使用 `$`。這些改動有其必要性，但 review 時就必須從大量 context 調整中，辨識哪些地方真的改變了行為。

Ref: [群組變數與共用設定的取值](https://github.com/apache/airflow/blob/8b76366a18073ceb497f45381ef5ca4a6fb46786/chart/templates/workers/worker-deployment.yaml#L48-L78)。

### 另一種方式：先組合設定，再交給原本的模板

#58547 同樣需要迴圈，但它先為每組 Worker 組合設定，再建立新的渲染 context。以下節錄其 Service 模板的外層結構；省略中間的 Service 內容：

```yaml
{{- $workerSets := .Values.workers.celery.sets | default list -}}
{{- if .Values.workers.enableDefault -}}
  {{- $workerSets = concat (list (dict "name" "default")) $workerSets -}}
{{- end -}}
{{- range $workerSet := $workerSets -}}
  {{- $currentWorkers := mustMerge $workerSet (deepCopy $.Values.workers) -}}
  {{- $newValues := mustMerge (dict "workers" $currentWorkers) (deepCopy $.Values) -}}
  {{- $ctx := merge (dict "Values" $newValues) $ -}}
  {{- with $ctx -}}
```

這段邏輯將群組值放在合併目的端，再補上共用設定，接著把結果放回新 context 的 `Values.workers`。進入 `with $ctx` 後，內部模板就能繼續用 `.Values.workers` 取值。

對我而言，這個設計最有價值的地方，是讓模板原本理解的輸入形式保持穩定。群組化主要在外層完成，內部大部分渲染邏輯得以沿用，不必為每個欄位額外建立 `$groupSomething`。[Service 模板的 context 組合](https://github.com/apache/airflow/blob/989dba0ceede4ac802e46688a4ab537abb80232c/chart/templates/workers/worker-service.yaml#L23-L31)。

### 重用 context 仍然有成本

不能因此把整個實作簡化為「做一次 merge 就完成」。#58547 的 Worker Deployment 模板比 Service 更複雜：它另外處理 `workers.celery` 設定、副本數，以及 `persistence.enabled` 在合併過程中的值。

原始碼會先保存 `persistence.enabled`，再於後續合併後設回。這提醒我，設定合併需要分清楚「沒有指定」與「明確指定 false」；也不能假設每個模板都使用完全相同的繼承步驟。

因此，我從這個 PR 學到的是：**把共通設定處理集中起來，可以減少模板內部的分支；集中之後，仍要用測試確認覆寫語意。**

Ref: [Deployment 模板的設定合併與 persistence 處理](https://github.com/apache/airflow/blob/989dba0ceede4ac802e46688a4ab537abb80232c/chart/templates/workers/worker-deployment.yaml#L23-L45)。

## Workers 設定外

### queue 命令與相關 Kubernetes 資源

我的版本對自訂群組直接組出以下命令：

```bash
exec airflow celery worker --queues <group-queues>
```

因此，自訂群組走的是專用 args 分支；預設 Worker 才沿用原本的 `workers.args`。這會增加後續維護命令設定的成本。

#58547 則在既有 args 模板中，依 `.Values.workers.queue` 加入 `-q`。兩個版本都能指定多 queue，但後者把 queue 設定接回既有命令產生流程。它在 queue 為 `default` 時不額外加入 `-q`，所以也不能將它描述成「所有情況都明確指定 queue」；若環境另改了 Celery 預設 queue，部署前應核對實際命令與 scaler 查詢是否一致。<br>
Ref: [我的命令分支](https://github.com/apache/airflow/blob/8b76366a18073ceb497f45381ef5ca4a6fb46786/chart/templates/workers/worker-deployment.yaml#L303-L313)、[另一版的 args](https://github.com/apache/airflow/blob/989dba0ceede4ac802e46688a4ab537abb80232c/chart/values.yaml#L1057-L1066)、[KEDA query](https://github.com/apache/airflow/blob/989dba0ceede4ac802e46688a4ab537abb80232c/chart/values.yaml#L772-L788)。

多組 Worker 也不只是多份 Deployment。我的 PR 修改 Deployment 與 Service，透過 `worker-group` label 識別群組；#58547 使用 `worker-set`，並將群組處理延伸到 Service、NetworkPolicy、HPA 與 KEDA ScaledObject 的模板。

這些資源需要使用相應的名稱、selector 或 scale target。否則即使 Worker Pod 正確建立，周邊控制仍可能沒有跟上群組邊界。[#58547 完整 diff](https://github.com/apache/airflow/pull/58547/files)。

### KEDA 要統計該組會消費的工作

我的 PR 明確註記：群組模式尚不支援 KEDA／HPA，必須使用固定副本數。Reviewer 接受先記錄限制，我也回覆後續想繼續處理 autoscaling。[當時的回覆](https://github.com/apache/airflow/pull/56589#issuecomment-3481181851)。

#58547 在同一個 PR 內擴充這兩種 autoscaler。以 KEDA 為例，除了讓每組產生自己的 ScaledObject，還修改預設 SQL，使用 queue 清單篩選任務。假設 queue 是 `reports,batch`，concurrency 為 16，查詢的核心會是：

```sql
SELECT ceil(COUNT(*)::decimal / 16)
FROM task_instance
WHERE (state='running' OR state='queued')
  AND queue IN ('reports','batch');
```

這裡只呈現 queue 計數核心，混合 Executor 的額外條件省略。原始模板會將逗號分隔的 queue 拆開、去掉前後空白，再組成 `IN (...)`。

如果每組都統計所有任務，就可能為其他群組的工作擴展。依 queue 過濾，才讓容量估算與該組負責的工作範圍對齊。不過，如果多組刻意消費重疊 queue，它們仍可能各自計入相同任務；不能從這段 SQL 推論它會在群組之間分配容量。
群組覆寫組合都已驗證。本文是閱讀 diff 與測試的分析，沒有重新執行 Airflow Helm 測試或實際叢集部署。

## 結論: merge 更好的版本

### 兩者的差異

| 比較面向 | 我的 #56589 最終版本 | #58547 合併前版本 |
| --- | --- | --- |
| 設定入口 | `workers.celery.queueGroups`、`queues` | `workers.celery.sets`、`queue` |
| 預設 Worker | 有群組時取代預設 Worker | 由 `workers.enableDefault` 獨立控制，預設保留 |
| 設定處理 | 逐項取值、各自處理 fallback | 外層合併設定並建立渲染 context，部分值有額外處理 |
| 模板改動 | 大量調整根 context 存取與群組變數 | 多數內部模板沿用 `.Values.workers` |
| 自訂群組命令 | 專用分支直接組裝 Celery 命令 | 在既有 args 模板中加入 queue 參數 |
| 相關資源模板 | Deployment／StatefulSet、Service | 另涵蓋 NetworkPolicy、HPA、KEDA |
| Autoscaling | 明確列為不支援 | 擴充每組 autoscaler 與 KEDA queue 篩選 |
| 主要維護成本 | 新欄位需要逐一接線，繼承行為容易不一致 | 合併順序、布林值與相容設定需要仔細驗證 |

Reviewer 在 [2025-12-07 的比較留言](https://github.com/apache/airflow/pull/58547#issuecomment-3623590015)中提出兩個理由：
1. #58547 的 diff 更精簡、較容易閱讀
2. 涵蓋另一個 PR 排除的 KEDA／HPA 支援

實際看過程式碼後，我能理解這個判斷。它用較少的模板內部調整，涵蓋更完整的相關資源；reviewer 可以把注意力集中在新 context 如何組成、名稱與 selector 如何變化，以及 autoscaling 是否對準群組。


### PR 之後

這是第一次將工作上遇到問題試著回饋到社群，從開一個 Issue 將自己想要解決的問題和設計方向，到 Sumbit PR 和 Reviewers持續修改討論 PR 內容，到最後看到一個讓自己心服口服 PR 。

一切都蠻新鮮且充滿正向回饋。
