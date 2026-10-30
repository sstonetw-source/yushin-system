# 取消採購轉備庫：原 UI 接線候選

相依 #350。原 commitCancelledPurchaseKeepStock 在 Preview 或明示 demo 旗標下，只委託既有受控後端；正式原入口保留至最後實際切換驗收。

前端獨立旗標為 YUSHIN_PREVIEW_CANCELLED_PURCHASE／YUSHIN_CANCELLED_PURCHASE_EMULATOR，預設關閉。Preview 即使關旗標也不得落回原 client transaction。App／Auth／Functions／Firestore、登入 UID／角色與網域須一致，回覆及回讀後均重驗。

提交前先將原操作編號、原收貨方式、所選倉、專案及使用者／角色存入 sessionStorage；回覆遺失、刷新及關旗標均保留。原介面優先顯示確認前次結果，恢復時不再要求重新選倉。伺服器回覆與 supplyOrders 的 KEEP_STOCK 操作憑證核對完成才清除暫存。暫存毀損、跨專案或角色變更不覆蓋、不另建操作；所有現有取消採購入口會擋住未確認的轉備庫。

這是 UI／傳輸接線，沒有新增庫存計算，沒有修改後端交易或放寬 Rules。現有正式 client writer 仍保留；待其餘交易整合後，集中做真 Preview、完整生命週期及正式角色驗收再依授權切換。

本機定向涵蓋原 ID 刷新恢復、回覆遺失、關旗標禁止 fallback、在途身分／專案變更、壞回覆與暫存保留。真 Emulator／Chrome／Preview 尚未在本機執行，不以 Node 通過宣稱整體驗收完成。沒有部署、正式旗標啟用或正式資料異動。
