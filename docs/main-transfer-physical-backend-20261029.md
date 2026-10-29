# 主倉備貨調撥實貨後端準備

相依主倉需求 UI #353，關聯 #291／#311。依使用者指示，先整合修改與清理，最後集中人工驗收；本批尚未接入原寄出／收貨 UI。

## 實際變更

- 原 Warehouse Logistics 共用 `planTransferDispatch`／`planTransferReceipt`；原前端與新後端共用公司／分倉實貨、預留與調撥在途投影，刪除原 Service 重複的計算。交付業務保管仍維持原獨立語意。
- `dispatchV2MainTransfer` 只接受固定調撥 ID 與原主倉需求 ID。後端讀最新 admin／purchaser／warehouse；核對 PENDING 需求、實體來源與目的主倉、公司與分倉身分、實際數量及保留。原子扣來源實貨與備貨保留，增加公司調撥在途，寫批次扣帳、調撥／需求及唯一 out movement。公司 onHand 不變。
- `receiveV2MainTransfer` 是另一個 Callable、旗標與操作 ID。只接受本後端建立的 IN_TRANSIT 主倉調撥；核對原需求、公司在途、out movement、原批次追溯，以及目的批次／成本憑證不存在，一次寫實貨入倉、目標批次／成本來源、唯一 in movement 及收貨憑證。
- 冪等憑證存於既有 `reservationOperationReceipts`，沿用 client 禁止讀寫的 Rules。使用不同動作前綴；寄出保存不可變來源快照，收貨與重試核對原快照，不能只信任 client 可建立的 stockTransfers metadata。每次重試仍驗最新角色。
- 批次沿用原 `reconcileStockLots`／`allocateLots`。未分批庫存保留來源，未知成本不捏造；對外 stockTransfers 不帶 unitCost／cost。
- Admin transaction 內查批次；候選入口最多100筆既有來源，另可有一筆未分批來源。最多101個目的批次，收貨最多207次寫入，未達500上限；實際入口上限須待真 Emulator／Preview 驗證，不能引用既有200批次上限宣稱已驗收。拒絕目的批次或成本憑證覆寫。

## 預設關閉與界線

前後端尚未正式切換。後端獨立 `ENABLE_PREVIEW_MAIN_TRANSFER_DISPATCH`／`ENABLE_PREVIEW_MAIN_TRANSFER_RECEIPT`；demo 對應 `ENABLE_MAIN_TRANSFER_DISPATCH_EMULATOR`／`ENABLE_MAIN_TRANSFER_RECEIPT_EMULATOR`，必須使用本機 Auth／Functions／Firestore。正式專案沒有啟用路徑。建立需求旗標不會授權實貨寄出或收貨。

收貨後 `allocationCompleted=false`、`autoAllocationQty=qty`，只表示實貨已收。缺貨訂單分配仍是另一個可恢復交易，這次未接管，不能向使用者顯示完整分配成功。原 UI 尚未呼叫這兩個新入口；固定意圖保存、刷新／lost reply 恢復、禁止 legacy 接手及後續分配須在接線批次完成。原正式 writer 保留至實際切換，未部署、未開旗標、未改 Rules 或正式資料。

訂單調撥、交付業務、一般自由調撥及歷史 legacy transfer 不在新後端範圍。未以刪除資料代替權限／憑證驗證；使用者允許必要時捨棄舊系統與舊資料，本次不需要正式刪除。

## 驗證與下一步

- 本機一般 Node 2,043／2,043；定向45／45，零失敗／略過。包括原調撥39項與新增後端6項；mock transaction 測試不等於真 Firestore 原子性／競態驗收。
- build-app／build-functions-core 生成一致性、相關 JS 語法與 git diff 檢查通過。
- GitHub CI 以本 PR 最新 run 為準。本機未執行真 Auth／Functions／Firestore Emulator、Chrome、Preview或正式角色驗收；最後集中進行。
- 下一步接原 UI 的寄出／收貨操作持久化與恢復，並將缺貨分配沿既有核心移至後端；接續訂單調撥／業務交接與其餘預留路徑，不另建庫存計算。
