# 2026-10-31：28 個保留分支的第二階段查核

基準 main：`42e60ebb9a2bc5255d9f41805a11f1bf5ee296ba`。GitHub 當前 main regression #41098164541 與 Pages #41098164726 均 completed/success。Open PR 0（本次維護 PR 建立前）。

## 方法與結果

逐一以 GitHub compare 確認 merge base，下載固定 SHA 的 branch/main/base，逐檔比對 blob 及 `git apply --reverse --check`。反向 patch 失敗僅代表有上下文差異，不能推論功能遺漏；成功及相同 blob 也不能代替其他檔案的查核。28 個分支全部有分岔歷史，不能直接以 ancestor 判斷。

4 個分支完成全部變更的等效查核，24 個保留；未聲稱已完成這 24 個分支的功能驗收。完整檔案結果見同目錄 JSON。

| 原 PR | 分支 | 查核證據 |
|---|---|---|
| #390 | `fix/order-reservation-production-cutover-311-20261030` | 後端 callable/gate/test 三檔完全相同；前端旗標與路由、拒絕舊 writer、測試及預設 false 均保留。其他差異為 #385 憑證防護、已核准 PO 旗標與資產版號及停用舊入口風險說明。 |
| #385 | `fix/order-reservation-reply-proof-20261030` | 原憑證 ID 核對、旗標在途關閉拒絕、較新同步 attempt 拒絕和三個安全案例均保留；差異為 production gate 接線、訊息與 fixture 擴充，未遺漏原修改。 |
| #377 | `fix/po-incoming-backend-20261029` | 7/9 檔內容完全相同或完整 patch 可反向套用；其餘兩檔保留 registerV2FormalPurchaseIncoming export 與三處 ENABLE_V2_PO_INCOMING_EMULATOR，僅新增其他受控測試。 |
| #288 | `perf/rules-warehouse-stock-metadata-once-20261025` | 兩個變更檔的原始 patch 均可在 main 反向套用檢查成功；原 Rules 優化與回歸測試仍存在。 |

## 驗證

最新 main 六份預留／PO 在途定向測試 79/79 通過；`build-app --check` 及 `build-functions-core --check` 通過。這些是本機 Node／生成檔證據，不是新一輪 Emulator 或正式環境驗收。#288 僅查核 main 仍含原 Rules patch，沒有發布 Rules 或重新聲稱正式角色驗收。

## 安全清理

一次性 workflow 僅刪除上表固定四個 SHA 的分支。執行前確認 main 關聯全部檔案 blob 不變、原 PR closed 且原 head 相同、目標分支不受保護／SHA 未變、無 Open PR；任何不符均跳過。不改 commit、Firebase、交易旗標或正式資料。完成後移除 workflow，保留 JSON 和執行日誌。

## 仍須保留的分支

| 分支 | 原 PR | 初篩已證實檔案／全部變更檔 |
|---|---|---|
| `feat/multi-item-shipment-20261018` | 無 | 1/10 |
| `feat/order-amount-details-20261025` | #283 | 14/26 |
| `feat/quick-purchase-preview-backend-gate-20261025` | #290 | 1/6 |
| `fix/20260920-critical-integrity` | #26 | 0/7 |
| `fix/forecast-ui-brand` | 無 | 0/3 |
| `fix/legacy-reservation-v2-failclosed-20261017` | #123 | 0/13 |
| `fix/lifecycle-duplicate-item-identity-20261015` | #91 | 2/5 |
| `fix/order-autofill-batch-stock` | 無 | 0/2 |
| `fix/order-deletion-linked-record-integrity-20261015` | #89 | 0/4 |
| `fix/product-search-and-stock-diagnostics-20261014` | #65 | 1/4 |
| `fix/reservation-proof-coverage-311` | #338 | 0/3 |
| `fix/stocked-order-purchase-queue-20261014` | #64 | 0/5 |
| `fix/system-terminology` | #51 | 2/11 |
| `merge/all-open-prs-20261025` | #276 | 31/51 |
| `preview/inventory-warehouse-forecast-20260920` | #29 | 0/1 |
| `preview/multi-item-order-model-20260920` | #28 | 0/1 |
| `refactor/architecture-unification-20261015` | #94 | 11/49 |
| `refactor/transaction-core-unification-20261015` | #92 | 1/5 |
| `upgrade/admin-simplify-20260924` | #41 | 0/3 |
| `upgrade/ci-integration-validation-20261028` | #344 | 20/33 |
| `upgrade/discussion-fixes-20260923` | #40 | 0/3 |
| `upgrade/final-ui-simplify-20260924` | #42 | 0/3 |
| `upgrade/purchasing-three-workspaces-20260924` | #43 | 0/3 |
| `upgrade/remove-product-line-assignment-20260923` | 無 | 0/1 |

特別注意 #338 的 Rules 原型與文件在 main 不同／缺少，不可將失敗的 1,000 expressions 實驗直接補回；#28 晚於父 PR 合併、無 PR 分支及原 head 已前進分支仍逐項追蹤。
