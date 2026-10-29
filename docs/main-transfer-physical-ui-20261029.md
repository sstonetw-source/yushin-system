# 主倉實貨調撥原 UI 接線與恢復

相依 #354，關聯 #291／#311。依使用者指示先整合與清理、最後集中完整驗收；本批只接主倉備貨的實貨寄出及收貨，尚未接管缺貨分配。

## 原操作與共用邊界

原 `commitWarehouseTransfer` 在 Preview／明示 demo 的主倉需求寄出委託 `dispatchV2MainTransfer`，原 `commitWarehouseTransferReceipt` 委託 `receiveV2MainTransfer`。主倉需求、實貨寄出與實貨收貨維持不同語意及獨立旗標。一般調撥／訂單調撥／交付業務仍為下一階段，正式 client writer 保留。

`mainTransferBackendContext` 由原需求與實貨傳輸共用，刪減重複 App／Auth／Functions／Firestore 專案、來源網域、旗標及原 UID／角色核對。沿用 Functions SDK loader，非同步載入、Callable及憑證回讀後重新檢查；切帳、跨專案或旗標停用不得繼續，也不能改用舊交易。

實貨前端獨立旗標 `YUSHIN_PREVIEW_MAIN_TRANSFER_DISPATCH`／`YUSHIN_PREVIEW_MAIN_TRANSFER_RECEIPT`；demo 對應 `YUSHIN_MAIN_TRANSFER_DISPATCH_EMULATOR`／`YUSHIN_MAIN_TRANSFER_RECEIPT_EMULATOR`。預設皆關閉；旗標關閉時保留待確認記錄與恢復入口。

## 固定 ID 與回覆遺失

- 送出前將原操作、需求／收貨 operationId、原 UID／角色／專案存入 sessionStorage，讀回成功才傳輸。
- 同需求未確認寄出不能另建 ID，取消需求也拒絕接手。原寄出未確認前不能由同一操作帳號開始收貨。
- 同頁連點共用同一筆 in-flight Promise；含 await 的收貨預讀後再核對已保存操作，不覆寫另一個操作 ID。
- 回覆及原 stockTransfers 憑證均符合才清 pending；lost reply、重整、讀取失敗、不符回覆、角色／專案改變或暫存毀損都保留原資料。
- 已收貨再次核對時沿用原 receiptOperationId，不能重新建立收貨。原需求離開 PENDING 查詢或實貨離開 IN_TRANSIT 查詢後，寄出與入庫恢復列仍從原暫存顯示。
- 既有 client 寄出／收貨 writer 明確拒絕接手後端調撥，即使離開 Preview且所有旗標關閉，也不能回退舊入庫或舊分配。

## 收貨後分配尚未完成

後端實貨收貨目前回傳 `allocationCompleted=false`，UI 明確顯示「實貨已入庫；缺貨訂單分配尚待後端接線」，不顯示需求已同步。該列維持待分配；按「核對已入庫結果」只核對原操作，不重複入庫，不呼叫舊前端 allocator。這是開發候選的明確缺口，不能啟用正式入口或宣稱整體交易完成。

既有 `allocateFreeReceiptStockToShortages` 有獨立原子交易與每筆進度，但仍由前端執行並掃描候選；下一批須沿既有預留／履約／採購需求核心集中到後端，核對 v2 多倉及最新來源，採用有界進度與原憑證恢復，不能複製一套庫存公式。訂單調撥／交付業務及其他預留路徑也未結案。

## 驗證與發布界線

- 本機一般 Node 2,051／2,051，零失敗／略過；新增傳輸／恢復8項包含 lost reply／reload、原ID、連點、原憑證、關旗標、切帳／跨專案、禁止 client 接手及來源離開查詢後仍顯示恢復列。
- build-app（65個來源）／build-functions-core --check、相關JS語法與 git diff --check。
- 本機未執行真 Auth／Functions／Firestore Emulator、Chrome、Preview或正式角色驗收，最後集中進行。PR CI 以新 head 為準，不以本機測試代替。
- #354 CI 40822237756 在本批開發時仍執行中；已見 source／一般browser／部分Emulator與Rules成功，不宣稱整體完成。
- 沒有合併 main、部署、啟用正式旗標、修改 Rules、正式資料或刪除仍在使用的入口。本次不需要刪除舊資料。
