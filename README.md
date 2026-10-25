# 又鑫公司系統 — 程式維護入口

- 編輯主程式請從 `src/` 開始，勿直接編輯 `app.js`。
- 建置：`node tools/build-app.cjs`
- 確認：`node tools/build-app.cjs --check`
- 既有 `modules/` 商業核心保留，不另建重複公式。
- 資料庫集合責任：`docs/DATA_MODEL.md`
- 設計與限制：`docs/ARCHITECTURE.md`
- 計算與事件：`docs/BUSINESS_RULES.md`
- AI / 開發修改守則：`docs/DEVELOPMENT_RULES.md`
- 交易未完成清單仍請對照 `docs/workflow-consistency-audit-20261014.md`。

## 網站與 Firebase 發布

- 正式網站使用 [GitHub Pages](https://sstonetw-source.github.io/yushin-system/)，來源為 `main` 的根目錄。
- 本專案不設定或發布 Firebase Hosting；GitHub 網站更新與 Firebase 後端發布分開處理。
- Firebase 繼續提供 Authentication、Firestore 與 Cloud Functions。保留 Firebase 登入用的 `authDomain`，不要因移除 Hosting 設定而刪除驗證網域。
- Functions、Rules 與 Index 只有在對應內容需要更新且取得發布授權時才發布；不要把網站更新當成後端已同步。
- 移除本機 Hosting 設定不會停用線上既有 Hosting 站台；若需下架舊網址，應另列站台及停用範圍。
