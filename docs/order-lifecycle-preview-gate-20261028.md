# 訂單取消／恢復：隔離 Preview Callable（Issue #333）

此批僅建立一條**預設關閉**的後端試點入口，不部署、不切換正式資料、不刪除既有前端交易程式。

## 入口與權威資料

- `functions/index.js` 匯出 `setV2OrderLifecycle`，內部只呼叫原本的 `commitOrderLocationLifecycleAndRecover`；沒有新增庫存 writer、數量公式、集合、索引或 Rules 放寬。
- Service 沿原整單交易一次核對登入者 `users` 的角色／啟用狀態、訂單 owner、1–5 個品項、同步識別碼、雙倉預留、採購／收貨／已出貨與退貨憑證；原 `reservationOperationReceipts` 與 `inventoryMovements` 是冪等及釋出證據。
- 原取消操作成功後的 `postCommitAllocation` 仍是獨立的有界續傳；`recovery-pending` 不表示取消失敗，也不會重做來源釋出。

## 雙側隔離條件

| 環境 | 後端允許條件 | 前端條件 |
| --- | --- | --- |
| demo Emulator | `ENABLE_V2_LIFECYCLE_AUTH_EMULATOR=true`、原 Return Auth Emulator gate、Functions／Firestore／Auth Emulator 的本機位址、專案 `demo-yushin` | `YUSHIN_V2_LIFECYCLE_EMULATOR=true` 且 localhost、同一個 demo Auth／Functions 專案 |
| Preview | `ENABLE_PREVIEW_ORDER_LIFECYCLE=true`、專案必須**正好是** `preview-20135`、不得帶 Emulator 旗標 | `APP_ENVIRONMENT=preview`、`YUSHIN_PREVIEW_ORDER_LIFECYCLE=true`、固定 Preview 網域、Auth／Functions／Firestore 都屬於 Preview 專案 |
| 正式 | **永遠拒絕**，即使誤設 Preview 旗標 | 原正式舊交易暫時維持；若有未確認 v2 意圖則拒絕退回舊 writer |

Preview 即使沒有開啟旗標，也會阻止取消／恢復落回舊前端 `runRoleTransaction`。UI 的列表快速動作、狀態表單及進度入口都使用 `lifecycleProtectedMode()` 判定，讓原 `sessionStorage` 固定意圖在回覆遺失、重新整理、角色變更後仍由同一識別碼核對；若資料損壞或讀回不能確認，操作拒絕而不建立第二筆交易。

## 測試與未完成事項

- `tests/order-lifecycle-preview-callable.test.js`：預設關閉、環境／專案組合、偽造 actor、缺 Auth、未知 Service 錯誤清洗、真 index 匯出。
- `tests/v2-lifecycle-ui.test.js`：同意圖重試、回覆遺失及刷新、無旗標時禁舊回退、錯誤網域／專案／Auth Emulator、四個原 UI 入口共用 pending 保護。
- `tools/run-v2-return-auth-emulator.cjs` 的隔離測試入口改用真正匯出的 `setV2OrderLifecycle`，不再默默測試舊 Adapter 的替代 handler。
- 真 Firebase Auth／Callable／Firestore Emulator、Chrome 1280／390px、Rules 與完整 CI 須在 PR 驗證。**不得在 CI 未通過或缺少整單原子交易驗收時合併。**
- 2026-10-28 Firebase Console 顯示 `preview-20135` 專案最近已刪除，因此目前無法執行真 Preview 線上驗收；不可自動恢復專案或啟用旗標。

## 後續獨立階段

取得 Preview 可用性與角色驗收，並另外取得正式入口切換授權後，才能移除舊 Client 取消／恢復 writer。**本 PR 合併也不代表正式功能已啟用。**
