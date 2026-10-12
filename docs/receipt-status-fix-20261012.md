# 正常客戶訂單收貨被拒絕

目前訂單建立使用 `status: active`，未必另寫入 `orderStatus`。前端 `normalizedOrderStatus` 將未取消／作廢的訂單視為正常；原本 `supplierReceiptDispositionAllowed` 卻要求 `orderStatus` 或其 fallback `status` 等於 `normal`，導致連結正常客戶訂單的收貨被拒絕。補庫存採購沒有來源訂單，因此未受此判斷影響。

修正僅調整收貨的來源訂單狀態判斷，與前端一致：`status`、`orderStatus` 任一為 cancelled／voided 都必須先取得 KEEP_STOCK 採購處置。保留角色、來源身分、數量、庫存非負及收貨冪等檢查；不修改既有資料、不降低取消防護。

以使用者提供的 2026-10-12 備份，在 Firestore Emulator 重現 74134、A63881、52304 的原始權限錯誤。僅修改此判斷後，三筆實際資料的收貨交易成功，同一 receipt operation ID 重試不重複入庫。74134 的既有庫存已占用，因此新到貨成為自由庫存。

| 品項 | 收貨後 onHand | reserved | incoming |
|---|---:|---:|---:|
| 74134 | 2 | 1 | 0 |
| A63881 | 1 | 1 | 0 |
| 52304 | 1 | 1 | 0 |

備份診斷使用真實收貨與自由庫存分配函式、正式 core modules、交易權限 proxy；UI 搜尋／工作分類與品項呈現 helper 以測試替身處理。結果為模擬器交易驗證，不表示線上已完成收貨。備份與私人原始資料不納入 Git。

新增自動測試涵蓋管理員、採購、倉管的完整收貨交易與同 ID 重試，以及互相矛盾的取消欄位、作廢欄位與 KEEP_STOCK 防護。860 項應用程式測試、87 項 Firestore 規則測試通過。

發布需要更新 Firebase Firestore Rules，無須新索引或資料遷移。只更新 GitHub Pages 不會更新規則。正式 Firebase 尚無可用部署憑證，因此線上發布與實際收貨重試尚未完成。
