# #308 收貨可信任後端｜預設關閉的正式候選與中止方案

本階段只交付可合併的程式候選；**未部署 Firebase、未啟用正式入口、未發布 Rules、未修改正式資料**。原站仍由既有前端 Transaction 收貨，直到取得獨立授權並完成切換驗收；不得提前刪除舊入口。

## 唯一寫入核心及限制

- 已匯出的 `receiveV2Supply` Callable 經 `functions/supply-receipt-service.js`，以 Admin SDK 取得最新角色，並於同一 Firestore Transaction 再次核對角色、供應來源、PO／手動採購操作憑證、訂單、倉庫、餘量與預留。實際收貨、Movement、Reservation、Demand、公司與分倉庫存仍交給同一份 `src/services/receiving.js`；後端 `functions/shared/receiving-runtime.js` 由其產生，沒有第二套寫入器。
- 固定 `operationId` 及 `receipts/{operationId}` 憑證用於冪等與重試；畫面保存每一列的原始數量／批號／效期及操作 ID，未知結果不得另建 ID 或執行舊前端交易。已確認的收貨仍需核對真實 receipt 欄位。
- 目前已驗證上限維持：實體倉庫收貨來源最多 **15 品項**；原廠直送最多 **5 品項**。不延伸其他交易入口的上限。

## 正式候選開關（本次全部保持關閉）

| 層級 | 條件 | 未符合時 |
| --- | --- | --- |
| 後端 | `ENABLE_PRODUCTION_RECEIVING_BACKEND=true` 且部署專案必須是 `yu-shing-company`，不可混入 Emulator | Callable 拒絕；沒有資料寫入 |
| 前端路由 | 正式環境、`YUSHIN_PRODUCTION_RECEIVING_BACKEND=true` **及** `YUSHIN_PRODUCTION_RECEIVING_LEGACY_BLOCKED=true`，網站必須為 `https://sstonetw-source.github.io/yushin-system/` 路徑 | 不呼叫後端；一旦設有 legacy lock 即拒絕舊交易 |
| SDK 與原操作 | Auth、Functions、預設 App、Firestore 都指向 `yu-shing-company`；沒有 Auth Emulator；身分／角色一致；作業明細事先寫入 sessionStorage | RPC 前拒絕或保留待確認工作 |

本 PR **不修改** `transaction-rollout-config.js` 既有正式旗標，亦不設定上述兩個收貨前端旗標。正式後端開關為獨立新名稱，不能藉 Preview 旗標開啟。`YUSHIN_PRODUCTION_RECEIVING_LEGACY_BLOCKED=true` 在未來核准切換後必須永久保留；後端停用、逾時、回覆不明時，仍應中止收貨並用原 ID 查證，**不得恢復舊 SDK writer**。

## 真實環境切換前的必要獨立工作

1. **唯讀核對**現有 Firebase 正式專案、Functions 部署 hash／環境旗標、網站實際來源與快取、現有 Rules、角色、目前未完成的收貨 operation ID。舊 `preview-20135` 曾經刪除，**不可假定現在可用**；需先確認真實 Preview 專案存在且權限、資料隔離、安全性均符合需求，才可規劃驗收。Emulator／Facade 證據不等於真實 Preview。
2. 取得分開且明確的正式 Functions 部署、後端開關、前端切換及必要 Rules 發布授權。先部署且保持後端關閉，回讀專案／函式版本／所有既有入口旗標，避免影響已運作的 PO、手動採購與訂單入口。
3. 訂出可實施的寫入維護凍結、舊分頁與手機快取換版、Rules 舊 writer 防火牆方案。只變更新版 JavaScript **不能封鎖已快取的舊客戶端**；未保證兩種版本不會併行寫入前，不可放行切換。
4. 在維護時段、版本和授權均核對通過後，依序開啟後端 gate，再透過獨立正式釋出設定兩個前端旗標為 `true`，完成精確的 Auth／Functions／Firestore 專案綁定核對。正式角色及必要差異驗收完成前維持凍結；沿用 #308 已完成的隔離／原站驗收，不再製造重複正式測試單。
5. 對未確認結果，只讀回查原 `receipts/{operationId}` 與供應來源、Movement、Demand 和庫存；必要時以**原操作內容及 ID**重試。不能用新 ID 重送，也不能直接修改帳面。

## 故障中止

- 任一部署／前端版本／資料庫專案／角色／憑證／庫存對帳不一致：停止新收貨，保留作業與憑證，記錄故障範圍。不可藉放寬 Rules 或改回舊 writer 快速恢復。
- 後端停用時保留前端 `LEGACY_BLOCKED=true`；只要後端尚未恢復並核對，就呈現待確認／不可提交。舊分頁與新版並存的風險須在正式切換前獨立解決。
- 若仍缺真實 Preview 或正式授權，本階段可合併程式候選，但狀態只能寫「已合併、正式入口未啟用」，不能宣稱正式收貨驗收完成。
