# Firestore Rules 發布修正（2026-10-30）

## 問題與修正

以 main `17c692e` 為基準。Firebase Console 顯示 `Line 1761: Unused function: receiptFreeGroup` 並拒絕發布。

只刪除未被任何規則呼叫的 `receiptFreeGroup` 函式（3 行）。所有有效的 allow 條件、角色、資料歸屬、查詢範圍、成本與庫存限制均不變；不修改資料、Collection、Index、Functions 或網站。

新增 `tests/firestore-rules-publish.test.js`，檢查無引用的 helper 定義，納入現有 Node CI。這是保守的原始碼檢查，不取代 Firebase 編譯或 Emulator 權限測試。

## 驗證與發布界線

- 發布檢查測試通過；完整測試結果以 PR CI 為準。
- Firebase CLI `deploy --only firestore:rules --dry-run` 的雲端編譯端點回覆 HTTP 503。
- 另外嘗試建立未啟用 ruleset 進行雲端編譯，也回覆 HTTP 503；沒有建立成功的 ruleset。
- 沒有修改正式 release，沒有部署 Rules、Functions 或網站。
- 不需 Index 或 Firebase 設定變更。

正式發布前須重新完成雲端編譯，發布後回讀 active ruleset 比對來源，不能把 GitHub 合併或模擬器通過視為正式部署成功。
