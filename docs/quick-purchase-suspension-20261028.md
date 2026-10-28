# 手動採購：停用後的未確認操作保護

## 本批範圍

同一帳號／訂單／品項的後端操作憑證存在時，即使前端旗標停用，仍不得進入舊前端交易。無法讀取憑證時停止提交；不自動刪除或換操作編號。未確認提示在停用期間保留，重新授權後才提供原重試按鈕。未建立新交易核心或資料集合。

修改前新增測試重現 Emulator／production 帶未確認憑證進入 `LEGACY_TRANSACTION_USED`；Preview 原本已有額外禁止回退。修正後三環境均攔截。測試包含有效／損壞／空白憑證、修改數量、帳號／訂單／品項隔離、儲存不可讀及復原面板的停用／恢復。

本機採購相關 Node 31/31、一般 Node 1,892/1,892 通過；產物一致性、語法及 diff 檢查通過。既有原站 1280px 採購回覆遺失案例追加「停用旗標、原操作被拒且原憑證保留、提示仍在、重新載入後以原 ID 恢復」斷言。完整 CI、真 Chrome 與 Emulator 結果待 PR；本機未執行瀏覽器或 Emulator，不提前宣稱通過。

## 正式切換方案草案（未執行）

1. 前置：本批與 #319 經審查、完整 CI 全綠並整合指定 main；核對合併後產物。main #307 已提供正式 Callable 與獨立旗標，但合併不等於啟用。
2. 先在隔離 Preview 完成授權的部署與瀏覽器驗收，查核 Auth/Firestore/Functions 同屬 `preview-20135`。Emulator 或 project facade 不能代替真實 Preview。
3. 取得明確正式發布授權，記錄指定 commit、網站版本及 Functions 修訂。以正式專案 `yu-shing-company` 部署既有 `commitV2QuickPurchase`，前端正式旗標仍保持關閉；不部署 Rules、Index 或其他 Functions 作為本次附帶變更。
4. 確認後端部署及環境後，按授權設定 `ENABLE_PRODUCTION_QUICK_PURCHASE=true`。前端透過可審閱的載入設定、於 app.js 執行前設定 `YUSHIN_PRODUCTION_QUICK_PURCHASE=true`；這個前端設定變更尚未建立或執行，須在發布前確認網站來源及快取更新方式。
5. 以授權的原 purchaser 操作核對來源訂單、採購需求、公司／分倉 incoming、唯一供應與 movement，保留原 operationId、提交及回讀證據；admin 成功不代替 purchaser 403 驗收。
6. 正式驗收通過後，再以獨立 PR 移除舊 client writer，保留原後端冪等憑證與復原入口。

### 中止／恢復

- 發生結果不明時，停止新的手動採購，保留原操作 ID、分頁及 sessionStorage。重新整理同一分頁可保留 sessionStorage；關閉分頁或清除網站資料不能作為復原程序。
- 暫停後端時，前端維持後端路由，不能把關閉前端旗標當作恢復舊寫入的安全方案。必要時以獨立授權關閉後端 `ENABLE_PRODUCTION_QUICK_PURCHASE`，讓請求明確拒絕；已開始的請求仍須核對結果。
- 本批只保護該瀏覽器分頁內仍存在的 actor/order/item 憑證；不把換瀏覽器、開新分頁或刪除憑證當作允許重建採購的依據。
- 修復同一後端核心並恢復授權後，由原復原入口以原 ID／原內容重送、完成權威回讀；不刪帳、不補寫部分交易、不放寬 Rules。

本批不執行上述部署、旗標或正式交易。#268 正式 403 仍保持未結案，#199 正式 PO 與收貨 PR #309–#318 不包含在本批。
