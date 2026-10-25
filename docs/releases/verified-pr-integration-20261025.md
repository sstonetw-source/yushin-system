# 2026-10-25 PR 整合與未通過項目

依使用者「全部合併」授權整合修改，但維持既定的 CI 與 P0 合併閘門。

## 已納入本分支

- #270：GitHub Pages 受控正式採購後端入口，不啟用正式開關。
- #269：Emulator 限定的手動採購後端原子交易與接續收貨驗收，不啟用正式入口。
- #273：自行訂貨預設已下訂、交易方式必填；保留舊資料相容性。
- #274：常賣品項、複製產品資訊及有界查詢。
- #198：保留其原分支歷史；舊 Client PO 4/7 測試已由 main 的後端原子採購、未知回覆恢復、收貨、出貨與送達連續驗收取代，不重啟已知 Rules 超限的舊 Client writer。

保留 main 已合併 #272 的估價單純文字標籤／Forecast 工具列、#275 地址文案，以及 #271 的 GitHub Pages 發布設定。處理前端版本、來源與 Rules 測試衝突；CI 加入所有測試腳本的語法檢查，不略過原有 Chrome、Auth、Functions、Firestore 或 Rules 驗收。

## 第一批曾排除：#131

實際 demo-yushin Firestore Emulator 重現五筆兩倉的運算預算問題；部分局部修正後，倉管全量釋放仍出現 1000 expressions／文件查核錯誤。未通過完整驗收，不可合併。第一批 #277 不包含此提案。後續已在隔離 Emulator 找到並修正重複 exists/get、未異動兄弟列與舊巢狀憑證殘留，原 #131 接續獨立驗收；最新結果以其 head 完整 CI 為準，詳見 cross-warehouse-reservation-evidence-20261017.md。

## 發布界線

GitHub 合併不等於 Firebase 發布。產品索引、訂單 Rules 與採購 Functions 仍依個別文件配套發布與驗收。本次不部署 Firebase、不啟用正式開關、不修改正式資料，也不宣稱正式採購 P0 已解除。

完整 CI 以本分支最新 head 為準，全部通過後才合併。
