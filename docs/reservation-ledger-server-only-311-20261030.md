# #311 — 高風險跨倉預留改由後端唯一寫入（Rules 候選）

狀態：**Draft 原型，未合併、未發布；須通過完整 Rules／Callable／UI 回歸和審查。**

使用者 2026-10-30 明確說明目前尚未正式上線，允許停用仍在使用的舊操作入口及清理舊測試資料。因此本候選可以優先切除有資料一致性風險的舊 SDK writer，但不自動授權正式 Firebase 專案資料刪除或 Rules 發布。

## 規則切換

- `inventoryReservations`：在既有 `operationalReservationStockEvidence` 驗證內拒絕 `stockEvidence.crossWarehouse=true`；其餘既有合法操作與角色讀取限制保留。這包含 #311 真正重現的「同倉兩筆品項拆成不完整的跨倉型主要憑證」，不只是兩個倉庫之間調配。
- `inventoryMovements`：在既有 `validOperationalMovementEvidence` 驗證內拒絕 `reservationStockEvidence.crossWarehouse=true`。即使快取舊版瀏覽器繼續嘗試，整筆交易也無法藉由不完整的主／次倉憑證變更預留數。沒有在每筆寫入的 match 層新增檢查，以免讓合法交易超過 Firestore Rules 運算預算。
- `inventory`、`warehouseStocks` 的既有驗證規則保持不變；相對應跨倉預留須由已驗證身分、角色、來源及操作編號的 Admin SDK Callable 處理。
- 保留後端 Admin SDK 的原子交易與冪等憑證；Rules 無法限制 Admin SDK，因此後端必須自行嚴格驗證。
- 舊版直接使用 **crossWarehouse 憑證**的操作會失敗。單倉／非跨倉的舊功能暫時保留，避免一次切掉 76 項正常流程。完整後端接管後仍需獨立移除其他 SDK writer。

## 安全驗收矩陣

| 檢查 | 目標 | 目前證據 |
|---|---|---|
| purchaser／warehouse 原生 SDK 建立或修改跨倉預留憑證 | 拒絕 | 改寫原生跨倉 Rules 反例，待 CI |
| #311 同倉兩筆拆分 primary／重複 primary、第二倉漏列 local ID | 原子拒絕、公司與分倉數量不變 | 直接引用 #338 原生 SDK 重現 fixture，改為後端唯一 writer 的負向驗收，待 CI |
| 原生 SDK 建立跨倉 movement | 拒絕 | 原生跨倉 Rules 反例，待 CI |
| 跨倉漏列、多倉拆分、重複主憑證 | 原子拒絕，帳面不變 | #338 已知反例；本次以拒絕整個舊跨倉協定處理 |
| 正常後端整單預留和後續交易 | 通過、冪等、數量相符 | 既有 Auth／Functions／Firestore Emulator 回歸，需重新執行 |
| 角色、成本資料、匿名讀取、偽造欄位、負值、重播 | 維持原限制 | 既有 Rules 回歸，需重新執行 |
| Chrome 電腦與手機 | 正確呈現未啟用／失敗；已切換走後端 | 既有原站 Emulator，需重新執行 |

本候選不變更任何登入權限、產品主檔、正式集合 schema，也不修改或刪除營運資料。已知舊 Rules 測試中的 purchaser／warehouse 原生 SDK 跨倉成功斷言已轉為「舊跨倉 SDK 拒絕＋後端跨倉交易成功」的對照驗收。**此修補只封鎖 #311 已確認的跨倉原生憑證路徑，不能宣稱其他所有舊 SDK writer（尤其 admin 與業務的不同交易路徑）都已消失。**
