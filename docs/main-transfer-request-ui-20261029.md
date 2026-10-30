# 主倉備貨需求原介面接線

相依 #352；先整合修改與清理，最後集中完整人工驗收。

createMainTransferRequest／cancelMainTransferRequestRecord 在受控 Preview／明示 demo 使用既有後端。Preview 關旗標仍拒絕回退原 client transaction；正式舊 writer 保留。前端旗標為 YUSHIN_PREVIEW_MAIN_TRANSFER_REQUEST／YUSHIN_MAIN_TRANSFER_REQUEST_EMULATOR，預設關閉。

提交前保存原需求 ID、動作、來源／主倉／數量，取消另保存固定 operationId，並綁定原 UID／角色與專案。沿用既有 Functions SDK loader，載入期間帳號切換不得提交。每次傳輸／回讀核對 App、Auth、Functions、Firestore及原角色；核對後端回覆及 stockTransferRequests 憑證才清 pending。

主倉需求面板從本機 pending 列出恢復入口，不依賴 status=PENDING 查詢，因此取消已成功但回覆遺失、需求已消失於清單時仍能恢復。關旗標不隱藏待確認結果。原寄出 writer 遇未確認需求先拒絕，建立／取消不得互相接手不同意圖。

本批不移動實貨、不新增預留計算。尚未統一調撥寄出／收貨、訂單調撥與交接，亦未完成真 Emulator／Chrome／Preview或正式角色驗收。必要 Node／CI 紀錄以 PR 為準；沒有部署、旗標啟用、Rules或正式資料異動，沒有提前移除正式舊入口。
