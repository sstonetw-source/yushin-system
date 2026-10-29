# 取消採購轉備庫：後端準備批次

相依退貨整合 #349；先修改與清理，最後集中驗收。

- 在既有 Supply Core 新增嚴格的轉備庫規劃，並以既有 builder 同步至 Functions，不新增第二套計算來源。
- 新增預設關閉的 keepV2CancelledPurchaseStock：最新 admin／purchaser、已取消訂單、來源品項與產品、原收貨方式、實體倉及公司／分倉在途均在原子交易內核對。
- 直送轉實體倉只增加未收量的 incoming，不增加 onHand。原實體倉採購只標記 KEEP_STOCK，不重加在途。單一 transaction 同步採購、成本隔離的 receivingSupplyOrders 與原 redirect movement。
- 固定 operation ID、canonical hash、原 UID／角色供同意圖重送；已有不同處理或轉倉憑證時拒絕覆蓋，不用 Math.max 掩蓋負數或超收。
- 獨立旗標 ENABLE_PREVIEW_CANCELLED_PURCHASE／ENABLE_CANCELLED_PURCHASE_EMULATOR；正式專案無啟用路徑。

本批只完成後端與共用規劃準備，原前端 commitCancelledPurchaseKeepStock 仍使用既有交易。尚未完成前端固定意圖持久化、回覆遺失恢復及入口切換，不能宣稱現有 UI 已改走後端。後續接線時應使用本共用規劃並移除重複數量邏輯；不得在未完成實際切換前刪除正式舊 writer。

本機定向檢查涵蓋在途一次加帳、實貨不動、成本隔離、原倉不重加、角色撤銷、壞帳及失敗無部分寫入。CI／真 Emulator／真 Preview 尚依 PR 實際結果追蹤；不逐項要求人工驗收。沒有部署、開旗標、改 Rules 或正式資料。
