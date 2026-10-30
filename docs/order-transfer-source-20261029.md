# 訂單調撥預留來源核對與舊writer邊界

相依 #364，關聯 #291。原前端只比對reservation.quantity／warehouseId，若v2資料混入單倉欄位，可能沿舊writer更新warehouseId，留下locations不一致。本批在原Reservation Core新增共用orderTransferReservationSource，核對訂單／品項／產品、全數預留、零缺貨及未有調撥／業務交接關聯。

舊單保留有限小數與既有缺少部分metadata的相容性；已提供metadata必須相符。v2須完整來源身分、沒有單倉欄位，使用既有reservationLocations核對各倉合計。純來源規劃只接受全數位於同一實體來源；多來源不得自行壓成單倉。原client writer對所有v2明確拒絕，不能因來源可解析就宣稱已完成多倉調撥。v2 custody目前不屬既有位置帳契約，沒有擅自擴大模型。

原舊單調撥／交接沿同一transaction；v2或混合欄位在庫存／批次／訂單寫入前拒絕。此批不新增交易端點、不遷移正式資料、不刪正式入口。Functions shared與app由原來源重建，更新app及Reservation Core資產版本。

本機Node2084/2084、build一致性／語法／diff通過。新增來源識別、缺貨、重複交接、小數、v2完整單倉／分散多倉、混合格式，以及真實舊Service在錯誤來源時無部分寫入的模擬transaction測試。本機真Emulator／Chrome新流程／Preview／集中人工驗收未執行，遠端CI待結果。

保持Draft，未合併main、部署、開旗標、改Rules或正式資料。下一步訂單調撥的受控後端寄出／收貨及原操作恢復；業務保管位置仍須沿既有模型核對，不能隱式放寬v2。最後集中驗收，整體#291未完成。
