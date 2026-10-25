# Firebase Hosting 停用紀錄｜2026-10-25

使用者明確授權同時移除專案 Hosting 設定與停用線上 Firebase Hosting 舊站台。

## 已執行

- 專案／站台：`yu-shing-company`。
- 只停用 Hosting 網站流量，未刪除 Firebase 專案、Auth、Firestore、Functions、Rules、Index 或歷史交易資料。
- Live channel 最新 release 類型為 `SITE_DISABLE`，release ID：`1792904645535000`。
- 停用前最後 Hosting version：`9eeffff71a31d88d`。保留歷史版本，不執行站台或版本刪除。

## HTTP 核對

| 網址 | 停用後結果 |
| --- | --- |
| https://yu-shing-company.web.app/ | 404 |
| https://yu-shing-company.firebaseapp.com/ | 404 |
| https://sstonetw-source.github.io/yushin-system/ | 200 |

只驗證網站 HTTP 狀態，未宣稱已用正式業務／採購／倉庫帳號登入實測。

## 程式變更

- `firebase.json` 移除整段 Hosting 設定。
- 保留原 Firestore Rules／Index 路徑、Functions runtime 與三種 Emulator 設定，內容與原 main 完全相同。
- README 明定網站使用 GitHub Pages，Firebase 後端與網站分開發布。
- 保留 Firebase `authDomain`；它是登入設定，不是網站發布設定。本次未更動登入、商業程式或角色權限。

## 驗證

- JSON 可讀，且移除 Hosting 後的其他設定與原 main 深度比對完全相同。
- app.js／src 與 Functions Core 建置一致性通過。
- Firebase 環境測試 3/3 通過，0 失敗、0 略過。
- diff 空白檢查通過。
- 本次不重跑與設定變更無關的訂單／庫存人工交易。

## 後續發布

此設定變更經 PR 合併後才進 GitHub main；線上 Hosting 已依本次獨立授權停用，不依賴 PR 合併。後續 GitHub Pages 更新不需 Firebase Hosting 發布，也不得例行重新部署 Hosting，否則會重新啟用舊網站。

本批不需要 Functions、Rules 或 Index 發布。未停用獨立 Preview 專案的站台；正式網站保持 GitHub Pages。
