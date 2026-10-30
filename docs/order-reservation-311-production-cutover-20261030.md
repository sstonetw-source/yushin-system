# #311 — 整單預留後端：正式切換前置程式與中止條件

狀態：**僅供審查的程式候選，未啟用、未合併、未部署**。

## 修正目標與目前界線

原生 SDK 可在 Firestore Rules 漏列同倉預留憑證時造成公司／分倉 `reserved` 不一致；#338 的完整涵蓋 Rules 原型又會使合法五筆雙倉交易超過 1,000 expressions。此批不把失敗的 Rules 原型套進 main，也不降低憑證／來源／角色驗證。

整單 `commitOrderReservationPreview` 後端已在**同一 Firestore Admin 交易**讀取最新角色、訂單、產品、倉庫、公司及分倉帳，更新預留／需求／訂單並建立固定同步憑證；任何失敗都不可用另一個 ID 重新提交。這個入口與舊原生 SDK writer 仍會並存，**所以本 PR 不代表 #311 修復完成**。

本 PR 只補齊正式環境的獨立、預設關閉切換控制：

- `transaction-rollout-config.js` 的 `YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND=false`：未授權時維持原入口。
- `YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED=false`：正式切換後要與後端旗標共同設為 `true`；日後後端故障／停用只能中止，不得將此永久封鎖旗標恢復成 `false` 以重啟舊 SDK。
- Callable 生產環境需同時啟用 `ENABLE_ORDER_RESERVATION_BACKEND=true` 和 `ENABLE_PRODUCTION_ORDER_RESERVATION_BACKEND=true`，且後端專案必須是 `yu-shing-company`、不可混接 Emulator；角色仍於交易內重查。
- 確認回覆不明、旗標在等待期間關閉或登入身分變更時停止，保留原 `syncAttemptId`；不改用舊前端交易。

## 正式切換前必須確認

1. 最新 main 和所有相關 Draft 的實際差異與審查；**整合 #385 的原 `receiptId` 與 `syncAttemptId` 回覆核對，不能僅以 `status` 認定已完成**；確定預留 Callable、前端生成 `app.js`、版本化設定檔、後端部署版本一致。
2. 確認真實 Preview 專案存在且受控，完成多角色（包含成本隔離）與 Chrome 1280／390px 的實際 Preview 流程。
3. 覆蓋至少：同倉兩筆、跨兩倉五筆、合法減量及釋放、取消／恢復、交易衝突、回覆遺失後同一操作憑證恢復；不得從部分成功推論全入口有效。
4. **明確盤點其他仍可直接寫入** `inventory`、`warehouseStocks`、`inventoryReservations`、`inventoryMovements` 的每一個舊入口；不能只切新訂單就認定唯一 writer 已完成。
5. 設計並驗收低成本的正式 Rules 封鎖方案，使新版與快取舊版瀏覽器都無法直接提交舊預留 ledger；不能僅依賴可在用戶端更改的旗標。
6. 取得必要審查、CI、正式部署／旗標／Rules **分別授權**，準備故障中止與原操作編號查核；避免不同版本同時寫入。

## 故障與回退

- 切換前：兩個正式前端旗標預設為 `false`，舊正式入口維持原狀。
- 切換後：若 Callable 不可用，應停止新預留提交並查詢既有 receipt，不可改回舊 SDK。前端封鎖旗標與 Firestore Rules 必須保持生效。
- 回到舊 writer 不是安全的「一鍵回退」：須先評估 Rules、資料一致性、既存同步憑證與來源單狀態，重新取得正式授權。

## 驗證紀錄

本分支的定向 Node 測試涵蓋預設關閉、雙重後端旗標、專案不符／Emulator 阻擋、成功與不明回覆、旗標中途關閉、舊 writer 的路由封鎖位置。GitHub CI、真實 Emulator、Preview 與正式角色驗收應以其各自最新執行結果記錄，不能預先勾選為成功。
