---
title: Composer Airflow 3 環境移除 Proxy 與 SendGrid 問題
date: 2026-09-18
lang: zh
---

## Overview

### 環境與背景

我們目前 GCP Managed Airflow 2.10.2 版本 Terraform 中啟用了**私有模式**（`enable_private_environment = true`）。在這樣的環境設定中，Airflow 各元件沒有直接連到外網的路徑，Google 自家的 API 則可以經由 `private.googleapis.com` 存取。

為了連到外部服務，例如拉取外部映像檔或呼叫第三方 SendGrid 服務，目前必須經過在特定環境已經設定好的 VPC 代管 **Secure Web Proxy**。

所以在 Airflow 2.10.2 環境中，我們在 `env_variables` 設定 `HTTP_PROXY`／`HTTPS_PROXY`，都需要有對外連線需求時，都需要經過這台 Proxy，而 SendGrid 也就是透過這條路徑才能成功寄出告警信。

#### 困境
---
然而當我們嘗試把 Airflow Image 從 **2.10.2 升級到 3.3.2**，原本的全域 Proxy 設定卻讓 Airflow 內部元件無法互相溝通，導致整個叢集無法健康的工作。

這篇文章記錄遇到的問題、選擇的解法以及評估過的替代方案。

## Root Cause

### Airflow 3 改了架構

#### Airflow 2
---

過往在 Airflow 2.X Worker 是自己直接連到 Metadata Database。這是一個單純的 TCP 連線，`HTTP_PROXY` 這類設定不會影響這段資料庫連線。

![Airflow 2 架構：Worker 與其他元件直接連到 Metadata Database。](/GaryHsu/images/composer-airflow-3/airflow-2.png)

#### Airflow 3
---

但到了 Airflow 3.X ，因為底層架構大改動，Worker 不再自己直接連到 Metadata Database，而是**透過 HTTP 呼叫 Airflow API Server**，由 API Server 代為讀寫資料庫。

![Airflow 3 架構：Worker 透過 Task Execution API 與 API Server 溝通。](/GaryHsu/images/composer-airflow-3/airflow-3.png)

然而問題在於，HTTP 連線會讀取 `HTTP_PROXY`。Worker 原本只想與叢集中的 API Server 溝通，卻被全域環境變數導向對外的 Proxy。

但這台 Proxy 不認識也不會放行 Airflow 內部的 IP，最後導致讓用來「出外網」的 Proxy 設定連帶影響「內部」連線。Composer 目前又無法讓我們設定 NO_PROXY，避開這個影響，導致這個問題。

### NO_PROXY 為何不可行？

原本我們的想法很簡單，就是使用 `NO_PROXY` 設定，讓內部位址的連線不經過 Proxy。但在 Composer 環境中，`NO_PROXY` 不允許覆寫，只支援內建的四種值：

- `.google.com`
- `.googleapis.com`
- `metadata.google.internal`
- `localhost`

因此，無法自行補上 Airflow 內部服務的位址來解決問題。
Ref: https://docs.cloud.google.com/composer/docs/composer-3/change-networking-type#proxy-variables



### Dead End

最終我們卡在這個矩陣中:<br>
當我們設定全域 Proxy，Airflow Worker 開始報錯，Worker 無法順利工作，Airflow 根本無法順利運作;<br>
而當我們試著想要移除全域 Proxy，雖然 Worker 順利開始服務，但卻無法連線外部的 SendGrid 服務，告警信永遠無法寄送出來。

| 設定 | Airflow Worker | SendGrid 寄信 |
| --- | --- | --- |
| 保留全域 Proxy | ✕ 無法啟動 | ✕ Worker 無法啟動，根本無法寄信 |
| 移除全域 Proxy | ✓ 正常 | ✕ 無法連到外網 |


## 解法

### Custom email backend

在我們原本的 Airflow 2.10.2 的 Composer，我們直接使用 SendGrid Provider 作為我們的 email_backend，並透過 Airflow Connection 儲存的 SendGrid API Key 寄信。[SendGrid Provider](https://docs.cloud.google.com/composer/docs/composer-3/configure-email#:~:text=the%20secrets%20backend.-,Override%20the%20following%20Airflow%20configuration%20options%3A,-Section)

然後看過 SendGrid [原始碼](https://github.com/apache/airflow/blob/main/providers/sendgrid/src/airflow/providers/sendgrid/utils/emailer.py)內容後，發現或許可以改成自己的 custom email backend，這樣就不用仰賴，目標很單純：

1. 從既有的 `sendgrid_default` connection 取得 API Key。
2. 只在呼叫 SendGrid 時帶入指定的 Proxy。
3. 移除 Composer 的全域 `HTTP_PROXY`／`HTTPS_PROXY`，讓內部連線恢復正常。


### 呼叫時指定 Proxy

關鍵是把 Proxy 從全域環境變數，移到單次 HTTP 請求的 `proxies` 參數，只有在呼叫 SendGrid 時，才帶入指定的 Proxy。

以下是概念程式碼:
```python
# custom email backend
def send_email(
    to,
    subject,
    html_content,
    conn_id="sendgrid_default",
    **kwargs,
) -> None:
    key = BaseHook.get_connection(conn_id).password

    requests.post(
        "https://api.sendgrid.com/v3/mail/send",
        headers={"Authorization": f"Bearer {key}"},
        json={...},  # 省略完整 SendGrid email payload
        proxies={"https": "http://10.172.255.2:80"},
        timeout=30,
    ).raise_for_status()
```

這樣需要連外的寄信請求會經過 Proxy，Worker 與 API Server 的內部連線則不受全域 Proxy 設定影響。而這個 Proxy 已經放行對於 SendGrid 的呼叫，URL List 已經包含 `api.sendgrid.com`。


## 評估過的方案

### 方案 A：Cloud NAT（Cloud Network Address Translation）

#### 移除 Proxy，改用 Cloud NAT 直接對外。
---
放棄原本全域設定 Proxy 的方法，讓 Worker 需要呼叫 SendGrid 時，透過既有 VPC 接 Cloud NAT 連到外網。

**但什麼是 Cloud NAT?**<br>
Cloud NAT 是 GCP 提供的託管式網路位址轉換服務，讓沒有 Public IP 的雲端資源，也能主動連線到網際網路。
![Cloud NAT](/GaryHsu/images/cloud-nat/cloud-nat-concept.png)

使用情境：
> 當 VM 或 GKE Node 不想配置 Public IP，想以降低對外暴露的風險，但它們仍然需要連上外部網路，例如下載 Docker Image、安裝 Python Package、呼叫第三方 API。



#### Tradeoff
---

- 需要與雲端小組溝通。在各環境使用 Cloud NAT 直接連外，涉及既有網路管理方式的調整。
- 必須新建或修改 Cloud Router 與 NAT，基礎設施變更範圍較大。
- UAT／STG／AI 等多數環境仍需要從零建置相關資源。

### 方案 B：Cloud Function 轉發

#### 把對外寄信的功能移到 Cloud Function，讓 Composer 保持不直接連外
---
方案 B 是由 Airflow 將寄信請求送到 Pub/Sub，再由 Cloud Function 呼叫 SendGrid。

![Cloud Function 轉發架構：Composer 發送寄信請求至 Pub/Sub，由 Cloud Function 呼叫 SendGrid，並搭配 DLQ 與 Cloud Monitoring／Logging。](/GaryHsu/images/composer-airflow-3/cloud-function.png)

這段設計有幾個仍需要解決的問題:
1. **Airflow 仍需要自己的轉送程式**<br>
    原本 Airflow 已經有 email backend。改成 Pub/Sub 後，只是把「直接寄信」改成「送訊息到 Pub/Sub」，這段 Python 程式仍
    然需要自行開發與維護。

2. **Airflow 不知道信是否真的寄成功**<br>
    Airflow 只能確認 Pub/Sub 收到訊息。如果後續 Cloud Function 或寄信服務失敗，Airflow 不會直接得知，因此還需要補上 DLQ、錯誤監控與告警。

3. **整體架構變複雜**<br>
    原本只是 Composer 寄信，現在會增加 Pub/Sub、Subscription、DLQ、Cloud Function、IAM、部署流程與監控，等於為寄信多維護一套小型系統。

#### Tradeoff
---
方案 B 把對外寄信功能搬到 Cloud Function，讓 Composer 不需要直接連外；代價是架構更複雜，寄信結果回報也變成非同步，而且只處理寄信，沒有解決 Composer 其他程式需要連外的問題。

