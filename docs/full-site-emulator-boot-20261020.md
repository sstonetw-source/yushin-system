# 完整首頁 Emulator 啟動驗收

## 範圍與安全邊界

- 在 1280px、390px Chrome 載入原 index.html、未修改的 app.js、所有原本的本機模組與 CSS；不替換導航、權限、快取、登入恢復或訂單清單。
- 測試伺服器僅將外部 SDK / PDF vendor URL 轉向本機真正的 npm 套件。Firebase 使用現有 real compat bundle，非正式 CDN 10.8.0 的逐位元複本。PDF 匯出不在本批驗收範圍。
- 本機模式需 localhost / 127.0.0.1 且 YUSHIN_LOCAL_EMULATOR 嚴格等於 true；只可 demo-yushin，拒絕沿用正式 / Preview app。Auth 9099、Firestore 8080、Functions 5001 在任何讀寫前設定。
- 不新增正式功能旗標、不修改正式 Functions 部署入口、Rules、索引、provider 或角色資料。測試攔截並阻擋非本機網路。

## 驗收內容

1. 真實 Auth 帳密經原登入表單；原 bootstrap 載入角色，重新整理恢復登入。
2. 原導航與訂單清單取消來源訂單。實際 callable 已提交後丟棄 HTTP 回覆；重新整理、原操作入口使用相同 operationId 確認，不重複取消。
3. 倉管原倉庫頁讀取兩倉釋放來源，讀取不配貨；原按鈕配五筆後回覆中斷。
4. 原登出與採購登入、原頁面接手同一批工作，完成七筆預留，僅一筆接手紀錄。實體庫存與 lot 不變。
5. sales / warehouse / purchaser / engineer / admin 共五種真實 fixture 身分登入及恢復；檢查原頁面權限。非本機請求、未捕捉頁面錯誤皆須為零。

保留原先兩個元件型真實 SDK 測試；新增兩個整站型測試。整站通過不代表正式環境或所有流程均完成驗收，仍須通過完整 CI 才可合併。
