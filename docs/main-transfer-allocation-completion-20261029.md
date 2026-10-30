# 主倉分配完成狀態收斂

相依 #359，關聯 #291。分配續傳只有在既有 coordinator 回傳 completed 後，才執行獨立、可重試的顯示投影交易；每次重新驗證最新角色、原入庫來源／批次與同一 movement 推導的共用 checkpoint。核對意圖、數量、完成原因及無 pending 命令後，更新 stockTransfers 的完成顯示、實際分配量、原 run ID 與原因。

清單沿既有 allocationCompleted=false 查詢退出已完成來源。該旗標只是可重建的顯示投影，不是交易權威；任何續傳仍查核原來源及共用 checkpoint。若旗標遭直接改成 true，清單仍可能被提前隱藏，此既有 client 可寫投影限制未由本批解除，不能宣稱權威清單防竄改已完成。原暫存恢復列不依賴查詢，回覆遺失仍能恢復。

若分配已完成但投影失敗，Callable 不回報成功，前端保留原來源。下次原 ID 續傳讀取已完成 job，只補齊顯示，不重複分配或入庫。投影不寫庫存、訂單、需求或 movement。同一投影重播無差異時不再寫入。

刪除未接線的 main-transfer-allocation-inspection、舊 allocationIntent／inspectAllocationCheckpoint 及其專屬測試，保留實際使用的寄出／收貨憑證驗證，避免另一套未使用的進度格式。

本機測試覆蓋缺少 job、active／損壞 job、撤銷角色、偽造顯示欄位修復、晚期投影失敗及原 ID 恢復、Callable 等待投影與結果不一致拒絕。真 Firestore 主倉整合測試加入完成投影，等待 CI。本機無 Emulator runtime，Chrome／真Auth新流程／Preview／集中人工驗收未執行。仍僅demo Emulator；未合併main、部署、開正式旗標、改Rules或正式資料。

下一步：共用分配協調器 Preview 的環境／權限邊界與權威清單讀取，再續處理其餘調撥交接及舊 writer，最後集中驗收。
