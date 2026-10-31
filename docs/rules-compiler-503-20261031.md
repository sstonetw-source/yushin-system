# Issue #311 — Rules 編譯 503 修復

基準 main：fbda823a2e0bedf29bcdf3a709ab89e44fee9861。

## 診斷

正式 `projects/yu-shing-company:test` 重現 HTTP 503。來源為 155,409 bytes，低於官方 256 KiB 來源限制；呼叫圖沒有循環，最深 7 層，不能據此宣稱超出官方 20 層或確定超出編譯後 250 KiB。API 未提供編譯後大小或內部錯誤原因。

只在不發布的診斷內容將 orderUpdateAllowed 或 logisticsLocationProtected 換成 false，可以通過；只停用 inventoryMovementWriter 或 validCommercialOrderCostUpdate 仍失敗。減少物流驗證筆數也未能穩定解決。這將問題定位到訂單更新路徑的組合展開，而不是服務完全停擺。診斷規則從未發布。

## 修復

- 角色集合直接比較一次 role；owns 共用同一份使用者資料與業務代碼，保留停用、歸屬及匿名限制。
- 物流品項比較三個受保護欄位的投影，保留 custody deliveryPlan 限制；外層仍逐一驗證全部 15 筆。
- 商業成本保護使用等價的布林化簡及預設值投影，保留 Service 身分與自行訂貨成本限制。
- 合併採購／倉庫的共同 dispatch，移除不可能成功的重複物流分支：前段已涵蓋其全部 changed-key 白名單；各角色自己的文件白名單仍分開。
- 共用 operationalItemsOnly 的 15 筆驗證，不改各角色允許欄位。

沒有減少品項上限、開放舊 SDK 初始化、變更角色或資料；沒有修改 quotes、產品、價格、Index、Cloud Functions、網站開關。

最新版已兩次通過正式 test API，並以 Firebase CLI `deploy --only firestore:rules --project yu-shing-company --dry-run` 成功編譯。這是對實際失敗路徑的修復證據，並非對 Google 內部 503 機制的斷言。

新增 15 筆首／中／末物流欄位、保管運送指示與跨業務竄改的 Emulator 回歸。完整 CI 必須通過才可合併及發布正式規則；正式回讀及交易驗收另記於 Issue #311。
