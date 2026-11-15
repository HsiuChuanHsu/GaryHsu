---
title: 使用 KEDA 實現 Airflow CeleryExecutor Worker 自動擴展：部署與運作原理
date: 2025-11-15
lang: zh
---

## Overview

### 從固定兩個 Worker 開始

Airflow 的工作量通常不平均。有些時段沒有任務，有些時段卻會因為排程或手動觸發 DAG，一次湧入大量工作。如果 Worker 數量固定，閒置時會持續占用資源，尖峰時又可能讓任務等待太久。

這次環境使用 Kubernetes 與 Airflow CeleryExecutor，原先固定啟動兩個 Worker Pod。導入 KEDA 後，改成依任務需求調整 Worker：最少 0 個，最多 5 個。有工作時啟動，工作結束後再回收。

本文整合部署過程與擴展邏輯，說明設定如何影響 Worker 數量，以及觀察到的 Pod 行為應該如何解讀。


## KEDA 如何連接 Airflow 與 Kubernetes

### 任務執行與擴展是兩條路徑

CeleryExecutor 透過 Redis Broker 傳遞任務，Worker 再從 queue 取得工作並執行。在這次採用的整合方式中，KEDA 則透過查詢 Airflow Metadata Database，統計 `queued` 與 `running` 狀態的任務，換算需要多少 Worker。

`ScaledObject` 描述要監控哪個來源、擴展哪個 workload，以及副本數上下限。KEDA Operator 處理啟用與縮到零，Metrics API Server 提供指標給 Kubernetes，HPA 再依指標調整非零副本數。Admission Webhooks 負責驗證相關資源設定。

這裡查的是資料庫中的任務狀態，並不是直接量測 Redis queue 長度或 Worker CPU。Airflow 官方的 [KEDA 整合說明](https://airflow.apache.org/docs/helm-chart/1.16.0/keda.html)也採用這種方式。

### 為什麼連 running 都要算？

只看 `queued`，會忽略已經被 Worker 接手、但還沒完成的工作。例如 queue 已經清空，仍可能有數十個任務正在執行。把 `running` 與 `queued` 一起納入，才能讓所需容量包含這兩部分。

這仍然是容量估算。任務執行時間、資源需求與 Celery 分配工作的方式不同，因此相同任務數量不代表相同 CPU 或記憶體負載。

## 部署 KEDA

### 準備映像檔與內部 Registry

原環境無法直接從外部 Registry 拉取所需映像檔，因此先在可連外的環境取得三個元件，再搬到內部 Registry。以下保留版本，將內部位址改成 `registry.example.com`。

```bash
docker pull ghcr.io/kedacore/keda:2.17.2
docker pull ghcr.io/kedacore/keda-admission-webhooks:2.17.2
docker pull ghcr.io/kedacore/keda-metrics-apiserver:2.17.2
```

例如，Operator 的映像檔可以重新標記後推送：

```bash
docker tag ghcr.io/kedacore/keda:2.17.2 \
  registry.example.com/library/keda:2.17.2
docker push registry.example.com/library/keda:2.17.2
```

其餘兩個元件也要搬到相同 Registry，repository 分別為 `library/keda-admission-webhooks` 與 `library/keda-metrics-apiserver`。搬運時要確認映像檔架構符合叢集節點；Registry 認證則沿用環境既有的拉取憑證。

接著在 KEDA Chart 的 `keda-values.yaml` 指定映像檔位置。這份檔案屬於 **KEDA 本身**，與下一節的 Airflow values 不同。

```yaml
image:
  keda:
    registry: registry.example.com
    repository: library/keda
    tag: "2.17.2"
  metricsApiServer:
    registry: registry.example.com
    repository: library/keda-metrics-apiserver
    tag: "2.17.2"
  webhooks:
    registry: registry.example.com
    repository: library/keda-admission-webhooks
    tag: "2.17.2"
  pullPolicy: Always
```

上述欄位可對照 [KEDA Chart 2.17.2 values](https://github.com/kedacore/charts/blob/v2.17.2/keda/values.yaml)。如果內部 repository 路徑不同，就應一起調整，不要只替換 Registry 網域。

### 安裝並確認元件狀態

在可存取 Chart repository 的環境，可以使用：

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
helm upgrade --install keda kedacore/keda \
  --namespace keda --create-namespace \
  --version 2.17.2 \
  -f keda-values.yaml

kubectl -n keda get pods
```

離線環境則先下載同版本的 Chart 套件，搬入內部後，以本機套件路徑取代 `kedacore/keda`。只有映像檔搬完還不夠，Helm 安裝時也必須能取得 Chart。

原始部署確認了 Operator、Metrics API Server 與 Admission Webhooks 三個元件均為 `Running`。實際檢查時也要看 `READY` 是否達到預期；若出現 `ImagePullBackOff`，先確認映像檔路徑、tag 與認證。

## 啟用 Airflow Worker 自動擴展

### 設定副本數與每個 Worker 的容量

KEDA 正常執行後，再修改 Airflow Chart。以下統一使用每個 Worker 16 個並行槽位、最少 0 個、最多 5 個 Worker：

```yaml
executor: CeleryExecutor

config:
  celery:
    worker_concurrency: 16

workers:
  keda:
    enabled: true
    pollingInterval: 5
    cooldownPeriod: 30
    minReplicaCount: 0
    maxReplicaCount: 5
  hpa:
    enabled: false
```

`workers.hpa.enabled: false` 是停用 Chart 額外提供的 HPA 設定入口；KEDA 仍然會建立並管理自己的 HPA，避免同一個 Worker workload 被兩套擴展設定同時控制。

`worker_concurrency` 要透過這個 Helm value 設定，讓 Worker 的實際容量與 KEDA 查詢使用相同數字。如果只在環境變數覆寫 Worker 的 concurrency，查詢卻仍用舊值，估算就會失準。

原始截圖的 Chart 另外註明，使用 KEDA 時必須停用 Worker persistence。這是需要依版本確認的限制，不能直接推廣到所有 Chart。若實際版本有這項要求，應先安排遠端日誌或其他持久化方式，再評估調整；不要直接在既有環境停用 persistence，導致日誌無法保留。

### 先確認 Chart 產出的資源

將上面的片段存為 `airflow-keda-values.yaml`，並與既有完整設定一起渲染。以下 `airflow-values.yaml` 代表環境原有設定：

```bash
helm repo add apache-airflow https://airflow.apache.org
helm repo update
helm template airflow apache-airflow/airflow \
  --namespace airflow \
  --version 1.16.0 \
  -f airflow-values.yaml \
  -f airflow-keda-values.yaml
```

確認輸出中的 `ScaledObject` 指向正確 Worker workload，SQL 與連線來源符合環境，且副本數與時間參數正確，再透過原有部署流程套用。**不要為了套用本文片段而直接升降既有 Chart 版本。**

啟用後，檢查 Airflow namespace 內的資源：

```bash
kubectl -n airflow get scaledobject
kubectl -n airflow get hpa
kubectl -n airflow get pods
```

## Worker 數量如何計算

### 先換算容量，再套用上下限

對本文的單一 Celery Worker 群組，核心查詢可以寫成：

```sql
SELECT ceil(COUNT(*)::decimal / 16)
FROM task_instance
WHERE state IN ('running', 'queued');
```

這是將 Helm Chart 中的 `worker_concurrency` 展開為 16 後的 PostgreSQL 範例。先統計任務數，再除以單一 Worker 的容量，最後向上取整，確保不足一個 Worker 的工作仍有容量可以處理。

```text
所需 Worker 數 = ceil((running + queued) / worker_concurrency)
穩定狀態的目標副本數 = min(maxReplicaCount, max(minReplicaCount, 所需 Worker 數))
```

後一行是理解上下限的簡化模型，實際副本數仍會經過 KEDA 啟用、HPA 調整與 Pod 啟動流程，不會在 SQL 回傳後立刻到位。

| running + queued | 計算結果 | 上下限內的目標 Worker 數 |
| --- | --- | --- |
| 0 | `ceil(0 / 16) = 0` | 0，等待縮到零的條件成立 |
| 5 | `ceil(5 / 16) = 1` | 1 |
| 16 | `ceil(16 / 16) = 1` | 1 |
| 17 | `ceil(17 / 16) = 2` | 2 |
| 30 | `ceil(30 / 16) = 2` | 2 |
| 50 | `ceil(50 / 16) = 4` | 4 |
| 80 | `ceil(80 / 16) = 5` | 5 |
| 150 | `ceil(150 / 16) = 10` | 5，受到最大值限制 |

若改成 `minReplicaCount: 1`，即使沒有任務，也會保留一個 Worker。相反，最多 5 個 Worker、每個 16 個 Slot，代表名目上有 80 個並行的 Slot；超過容量的工作仍需等待，不會因為啟用自動擴展就全部同時執行。


### 多 queue 環境要先看查詢範圍

上面的 SQL 沒有依 queue 篩選，適合用來理解原始筆記的單一 Worker 群組。如果不同 Worker 群組只消費特定 queue，卻都統計整張表，就可能依不屬於自己的工作擴展。

因此，擴充到多 queue 或混合 Executor 前，必須檢查所用 Chart 的查詢是否已經正確篩選，不能直接複製這段簡化 SQL。

## KEDA／HPA 完整運作流程

### 先看各元件如何分工

**KEDA 會建立並管理 HPA，由 HPA 調整非零的 Airflow Worker 副本數；KEDA 另外處理從零喚醒，以及閒置後縮到零。** 最後建立 Pod、安排節點與啟動容器，則是 Kubernetes 其他元件的工作。

下圖呈現控制與指標的流向。藍色箭頭表示設定與控制，綠色表示指標回傳，橘色虛線則是 KEDA 直接處理零副本的路徑。

![KEDA 與 HPA 運作流程：ScaledObject 經 KEDA Operator 建立 HPA，HPA 透過外部指標 API 取得 SQL scaler 查詢結果，再更新 Worker workload 的副本數，由 Kubernetes 建立與啟動 Pod；KEDA 另外直接處理從零喚醒及縮到零。](/GaryHsu/images/keda-airflow/keda-hpa-flow.png)

圖中的指標箭頭表示資料回傳方向，不代表 KEDA 主動推送擴展命令。HPA 會定期透過 Kubernetes 的外部指標 API（`external.metrics.k8s.io`）取得數值，再進行計算。

### 1. Chart 產生 ScaledObject，KEDA 建立 HPA

啟用 `workers.keda.enabled` 後，Airflow Chart 會產生 `ScaledObject`。這是一份描述擴展方式的設定資源，本身不會執行 SQL 或啟動 Pod，主要包含：

| 設定 | 用途 |
| --- | --- |
| `scaleTargetRef` | 指向要擴展的 Worker Deployment 或 StatefulSet |
| PostgreSQL trigger | 指定資料庫連線來源、查詢與指標目標值 |
| `minReplicaCount`／`maxReplicaCount` | 定義副本數上下限 |
| `pollingInterval`／`cooldownPeriod` | 定義 trigger 檢查間隔與縮到零的等待時間 |

KEDA Operator 監看這個資源，建立並維護對應的 HPA，將目標 workload、指標與副本數限制寫入 HPA 設定。相關實作在 KEDA 的 [`newHPAForScaledObject()`](https://github.com/kedacore/keda/blob/v2.17.2/controllers/keda/hpa.go#L64-L133)。

因此，`workers.hpa.enabled: false` 並不表示整個流程沒有 HPA。它關閉的是 Airflow Chart 另外提供的 HPA 設定入口；KEDA 仍會管理自己的 HPA，避免兩套設定同時控制相同 workload。

### 2. SQL scaler 將任務數轉成容量指標

假設 Metadata Database 中有 50 個 `running` 加上 `queued` 的任務，前面的 SQL 會回傳：

```text
ceil(50 / 16) = 4
```

**這個指標值是 4，不是 50。** Airflow Chart 的 SQL 已經先將任務數換算成所需 Worker 數；HPA 不需要理解 Celery、SQL 或每個 Worker 的 concurrency。

任務執行仍走另一條路徑：Scheduler／CeleryExecutor 將工作交給 Redis Broker，Celery Worker 從 queue 取得工作。KEDA 查資料庫是為了擴展容量，並不負責分配或執行任務。

`worker_concurrency: 16` 表示每個 Worker 提供最多 16 個並行槽位。兩個 Worker 名目上共有 32 個槽位，但實際分配會受到預取、任務長短、Airflow pools 與 DAG 並行限制影響，不保證平均分配。

### 3. HPA 透過 KEDA 取得外部指標

HPA 不會自行連線 Airflow 資料庫，而是向 Kubernetes 外部指標 API 要求指標，再由 KEDA Metrics API Server 提供 scaler 取得的資料。這是 HPA 主動讀取指標的控制迴圈，不是每次 SQL 完成就由 KEDA 推送一道擴展指令。

未啟用指標快取時，HPA 的指標請求可以促使 KEDA 取得資料來源的即時數值；啟用快取時，則可能使用 KEDA 在輪詢期間保留的數值。設定與快取行為可參考 [KEDA Scaling Deployments](https://keda.sh/docs/2.17/concepts/scaling-deployments/)。KEDA Metrics API Server 提供的是這裡所需的外部指標，與一般供 `kubectl top` 使用的 CPU／記憶體 Metrics Server 用途不同。

### 4. HPA 計算建議副本數，再套用限制

在本文的 SQL 已換算 Worker 數、trigger 使用 `targetQueryValue: "1"`，且指標類型為 `AverageValue` 的設定下，HPA 的目標可以理解為「每個副本承擔 1 單位指標」。以下只列出 HPA 的相關欄位，並非完整可套用的資源：

```yaml
metrics:
  - type: External
    external:
      # 省略實際的 metric 名稱與 selector
      target:
        type: AverageValue
        averageValue: "1"
```

先忽略容忍區間、穩定視窗與速率限制，建議副本數可以寫成：

```text
建議副本數 = ceil(外部指標總值 / 每副本目標值)
           = ceil(4 / 1)
           = 4
```

對應的 Kubernetes 實作是 [`GetExternalPerPodMetricReplicas()`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/controller/podautoscaler/replica_calculator.go#L324-L347)。副本數與目前數量的差異若仍在容忍範圍內，也可能維持原值。

接著 HPA 還要套用副本數上下限、穩定視窗與擴縮速率政策。例如查詢回傳 10，但上限為 5，就不能擴展成 10 個；即使最後需要 5 個，也不保證一次同步就到達目標。上下限與速率限制的實作可對照 [`horizontal.go`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/controller/podautoscaler/horizontal.go#L1069-L1151)。

前面的 `min(maxReplicaCount, max(minReplicaCount, 所需 Worker 數))` 是解釋允許範圍的簡化模型，並不是 SQL 中的計算，也不是完整的 HPA 演算法。尤其當最小值為零時，還有 KEDA 另外處理的零副本流程。

### 5. HPA 更新期望副本數，Kubernetes 建立 Pod

假設原本有 2 個 Worker，HPA 決定調整為 4 個，接下來會發生：

1. HPA 透過目標 workload 的 `scale` 子資源，將期望副本數更新為 4。
2. 若目標是 Deployment，由 Deployment／ReplicaSet controller 補足 Pod；若是 StatefulSet，則由 StatefulSet controller 處理。
3. Scheduler 依資源 requests、節點容量與排程條件，為新 Pod 選擇 Node。
4. 該 Node 上的 kubelet 拉取映像檔、完成初始化並啟動容器。
5. Celery Worker 就緒後，才能從 Broker 取得任務。

所以 HPA 改的是「期望副本數」，不是直接執行容器。看到 HPA 目標為 4，也不代表已經有 4 個可工作的 Worker；還要檢查 Pod 是否完成排程及就緒。HPA 與 workload 的關係可參考 [Kubernetes HPA 文件](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/)。

### 6. 沒有 Worker 時，KEDA 先從零喚醒

當 `minReplicaCount: 0` 且 Worker 已縮到零，Celery Worker 雖然不存在，KEDA 仍在執行，也仍可查詢 Metadata Database。

新的 queued 任務出現後，KEDA 按 `pollingInterval: 5` 檢查 trigger。若判定為活躍，就直接透過 workload 的 `scale` 子資源，先將副本數從 0 提高到 1；若設定了較高的最小副本數，則依該設定啟動。接著由 HPA 在非零範圍內繼續調整。

因此，50 個任務的啟動過程可以理解為：

```text
0 個 Worker → KEDA 喚醒為 1 個 → HPA 依指標調整至 4 個
```

KEDA 2.17.2 在最小值設為 0 時，產生的 HPA 下限仍為 1，零副本由 KEDA 額外處理。可對照 [`GetHPAMinReplicas()`](https://github.com/kedacore/keda/blob/v2.17.2/apis/keda/v1alpha1/scaledobject_types.go) 與 [`scaleFromZeroOrIdle()`](https://github.com/kedacore/keda/blob/v2.17.2/pkg/scaling/executor/scale_scaledobjects.go#L250-L271)。

這也是最小值 0 的代價：第一批任務需要等待偵測、排程、映像檔拉取與 Worker 初始化。五秒輪詢不代表五秒內就能開始工作；若任務對延遲敏感，可以評估保留最少一個 Worker。

### 7. 工作減少後，HPA 與 KEDA 分別處理縮容

當任務完成，SQL 指標隨之下降，縮容分成兩種情況：

| 變化 | 主要負責者 | 相關條件 |
| --- | --- | --- |
| 例如 4 → 2、2 → 1 | HPA | 指標、縮容穩定視窗與速率政策 |
| 閒置後回到 0 | KEDA | trigger 不再活躍、允許縮到零，且滿足 cooldown 等條件 |

`cooldownPeriod: 30` 主要控制閒置後縮到零的等待時間，不表示所有縮容都在 30 秒後發生；HPA 也有自己的同步週期，不能把非零副本的調整頻率都當成 `pollingInterval`。相關定義見 [KEDA ScaledObject 規格](https://keda.sh/docs/2.17/reference/scaledobject-spec/)。

縮容時，控制器會減少 Pod，Worker 可能進入 `Terminating`。這只表示正在關閉，不保證長時間執行的任務一定能完成；仍需確認 Worker 關閉行為、termination grace period 與日誌保存方式。縮到零的也只有 Worker，Redis、Scheduler 等其他元件仍持續執行。

### 沿控制流程確認實際狀態

實際確認時，可以沿著「ScaledObject → HPA → workload → Pod」查看設定與狀態。以下名稱與 namespace 請換成實際值：

```bash
kubectl -n <airflow-namespace> get scaledobject,hpa
kubectl -n <airflow-namespace> get scaledobject <scaledobject-name> -o yaml
kubectl -n <airflow-namespace> describe hpa <hpa-name>
kubectl -n <airflow-namespace> get deployment,statefulset
kubectl -n <airflow-namespace> get pods -w
```

若 ScaledObject 查詢失敗，先看資料庫連線與認證；若 HPA 讀不到指標，檢查外部指標 API 與 KEDA；若副本數已增加但 Pod 無法執行，再看排程、映像檔與初始化狀態。這樣才能區分是指標、擴展決策，還是實際容量的問題。

## 結論

### 自動擴展的效益與容量限制

KEDA 與 HPA 能讓 Airflow Worker 數量隨任務需求調整，但增加 Pod 不會增加節點的 CPU 與記憶體。例如 Kubernetes Worker Node 固定只有兩台 VM 時，新增的 Airflow Worker 仍然共用這兩台 VM 的資源。

當節點仍有餘裕，或任務主要等待外部服務時，擴展 Worker 可以提高資源利用率與任務吞吐量；如果節點已經滿載，更多 Worker 只會競爭相同資源，甚至因無法完成排程而停在 `Pending`。要增加實際運算容量，需要增加節點或提高 VM 規格，節點自動擴展則是另一層機制。

同樣地，兩台 VM 持續開著時，Worker 縮到零主要是釋放叢集內資源，通常不會直接減少 VM 費用。

因此，評估自動擴展時，除了觀察 Worker 數量，更應確認任務等待時間是否縮短、處理效率是否提升，以及節點是否有足夠容量。**真正的目標，是讓執行容量跟上需求，而不只是讓 Pod 數量增加。**

## 參考資料

- [Apache Airflow Helm Chart 1.16.0：Autoscaling with KEDA](https://airflow.apache.org/docs/helm-chart/1.16.0/keda.html)
- [Apache Airflow Helm Chart 1.16.0：values.yaml](https://github.com/apache/airflow/blob/helm-chart/1.16.0/chart/values.yaml)
- [KEDA Helm Chart 2.17.2：values.yaml](https://github.com/kedacore/charts/blob/v2.17.2/keda/values.yaml)
- [KEDA 2.17：ScaledObject specification](https://keda.sh/docs/2.17/reference/scaledobject-spec/)
- [KEDA 2.17：PostgreSQL scaler](https://keda.sh/docs/2.17/scalers/postgresql/)
