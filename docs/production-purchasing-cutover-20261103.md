# 採購舊瀏覽器退役鎖候選

手動採購與正式 PO 已有正式後端，但前端旗標不能阻止快取中的舊 Client SDK。
`settings/purchasingCutover.backendOnly=true` 封鎖 Client SDK 的 supplyOrders 建立／修改／刪除，
包括管理員；後端 Admin SDK 不受影響。舊手動採購或 PO 交易建立供應時整筆被拒絕，
原訂單、Demand、PO、庫存不會因同一原子交易留下部分成功。

PO 文件準備仍可使用既有 DRAFT/documentOnly=true 流程：建立、修改及刪除草稿不等於採購。
已確認 PO 不得改回草稿、修改採購內容或刪除；僅可更新原列印輸出時間與類型。
確認採購必須走既有後端，不能由客戶端將草稿改為 ORDERED。

鎖為單向、預設關閉；瀏覽器不能將 true 關閉、刪除欄位／文件或改為其他型別。
只能在所有供應執行都切到相容後端的維護時段啟用，因它同時影響收貨、直送與自行訂貨。
尚未具備正式後端的路徑維持停止，不能為了讓舊流程繼續而放寬此鎖。
**正式狀態更正（2026/11/11 唯讀查核）：** `yu-shing-company` 的正式
Firestore Rules 已發布 backend-only stock writer 版本，
`settings/purchasingCutover.backendOnly=true`。這是 Rules 舊瀏覽器寫入
封鎖狀態，**不代表所有 Functions 的 `ENABLE_PRODUCTION_*` 交易旗標已啟用，
也不代表員工正式入口已核准**。後續部署應先核對最新 main 與正式
Functions revision，避免把已發布的 Rules 當成尚未發布而重複操作。

本次僅修正紀錄，未重新部署、切換旗標、修改正式資料或角色。

不新增庫存核心、Listener、Index；唯讀與既有角色範圍維持。
