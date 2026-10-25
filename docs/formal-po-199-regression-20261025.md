# #199 正式採購 GitHub Pages 入口修正

基準：main `8ead3e98`。本批不部署、不啟用正式旗標、不改正式資料。

## 原因與修正

最新 main 已含 #267 的 production gate，但前端只接受 Firebase Hosting 網址，使用者既有 GitHub Pages 即使啟用正式旗標也會被拒絕。未啟用後端路徑時，一般正式採購仍使用會觸發 Rules 1000 expressions 的 Client 多文件交易。

沿用獨立 `ENABLE_PRODUCTION_FORMAL_PURCHASE=true` 後端 gate 和 `YUSHIN_PRODUCTION_FORMAL_PURCHASE===true` 前端 gate；正式專案固定 `yu-shing-company`，禁止混用 Emulator。補允許既有 GitHub Pages `sstonetw-source.github.io/yushin-system`（含其下頁面），其他帳號、儲存庫及相似路徑拒絕。網址檢查只是環境防誤接，不作為授權來源。

唯一後端仍為 `commitV2FormalPurchase`，在原子交易內讀目前 users 角色及停權狀態、來源商品／需求／供應、可採購量、PO 意圖與原文件版本。只允許 admin/purchaser，沿用原業務歸屬；其餘角色不新增權限。原單號同意圖可重試，未知回覆不回退 Client writer。

未變更 Rules、Index、Collection 或 Listener；不改 PDF。適用原本後端支援的 1–5 列客戶訂單實體商品（入庫／直送）；備庫、手動採購及 SERVICE 不擴張。PO 確認仍只建立採購承諾與來源關聯，在途登記是原有獨立 checkpoint，實貨不因確認採購增加。

## 發布與回退

1. 先完成獨立 Preview 原站驗收及本批完整 CI，核對發布 commit 和角色結果。
2. 另經正式授權，部署 Functions（先保持後端旗標關閉）；不需要 Rules／Index 更新。網站沿既有 GitHub Pages 發布，無需 Firebase Hosting。
3. 前後端分別啟用後，才會走後端提交；必須在原登入採購角色完成代表性部分採購、重試與在途驗收，不能以 Emulator 冒充正式通過。
4. 故障時先停止新確認操作並關閉後端 gate，保留原 PO／操作 ID 查核已提交結果。不得僅移除前端旗標，避免回退舊 Client writer；不刪除或自動沖回已成功交易。

## 驗證

- 建置一致性與 diff：通過。
- 採購相關 Node 測試：63/63 通過。
- 完整 Node 回歸：同步最新 main 後待重新執行；前次基準 1835/1835 通過。
- Firebase Emulator：執行中，以最終紀錄為準。
- 實際瀏覽器／Preview／正式環境：尚未執行；完整 CI 尚未執行。#199 不得結案。
