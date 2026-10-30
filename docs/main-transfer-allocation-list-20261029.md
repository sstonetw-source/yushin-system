# 主倉分配權威清單後端

相依 #360，關聯 #291。新增 listV2MainTransferAllocations，唯讀、同一個預設關閉的demo Emulator gate。以後端擁有的 MAIN_TRANSFER_RECEIPT 憑證查詢，依文件識別碼分頁，每次讀六筆、處理五筆並回傳游標／hasMore。完成來源仍推進游標，不能因當頁rows為空就誤認全部讀完。

每筆重新驗證原入庫異動、寄出／收貨憑證、目的倉批次及共用checkpoint；顯示旗標與autoAllocatedQty不參與判定。缺checkpoint為pending，active仍列出，僅通過完整驗證的completed省略。異常來源保留blocked列及收貨憑證ID，不靜默丟棄。每筆最多101批次，每頁至多五來源，讀取預算有界；清單不回傳成本或他人身分，沒有任何寫入。

共用來源／checkpoint狀態讀取抽出給完成投影及清單，避免另建判定邏輯。現有前端仍使用舊顯示查詢，本批只交付後端入口；「權威清單原介面接線」尚待後續完成，不可宣稱正式清單已修復。Preview與正式仍拒絕。

本機覆蓋偽造顯示旗標、完成憑證與顯示不同步、唯讀無寫入、blocked保留、五筆分頁與末頁、權限及非法游標。真Firestore主倉案例加入清單驗證，等待CI。本機無Emulator runtime，Chrome／真Auth新入口／Preview／集中人工驗收未執行。未合併main、部署、開正式旗標、改Rules或正式資料。

下一步：原介面權威清單接線與分頁，再處理共用協調器Preview邊界與其餘交易舊writer，最後集中驗收。
