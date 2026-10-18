# 多位置取消／恢復核心（2026-10-17）

本批擴充既有 `YushinReservation.planLocationReservation`，不建立第二個預留核心。`nextStatus` 預設 `normal`；`cancelled` 不依賴訂單目標量或供應承諾，完整釋放所有既有位置，回傳空 locations、quantity/shortageQty/remainingToOrderQty 為零及 released 狀態。恢復傳入 normal、當下未交付量與未到貨承諾，仍保留可用的既有預留，供應承諾不算實貨。

完整來源先經 `reservationStockDeltas` 驗證，再以相同函式產生公司與各倉差額。禁止混合位置格式；提供 itemReservedQty 時必須與權威 quantity 一致。公司、所有可承接新預留的分倉及既有持有位置必須是非負安全整數，reserved 加 transferFreeInTransit 不得超過 onHand。停用實體倉可釋放舊預留，但不承接新增；保管位置仍須交原履約流程。缺失舊倉／舊庫存不能釋放。

現行單倉 `planReservationLifecycle` 同樣在取消／恢復前拒絕不可能的預留與途中量組合，保留歷史小數相容。實際取消／恢復 Service 的 shortageQty 直接採用既有核心輸出。純核心回傳 proposed change；呼叫者仍須在相同 transaction 讀取全數來源後套用，不能使用畫面快取或將重試結果重複加帳。

## 驗收與邊界

- 核心測試涵蓋取消、恢復、其他訂單競爭、停用倉、供應承諾、錯誤投影、混合版本、原始帳目異常、重複呼叫及 96 組狀態循環；確認 onHand 不變及公司差額等於分倉差額合計。
- 現行 Service 的 Node／Emulator 測試涵蓋 admin、sales、engineer，異常時訂單／預留／公司與分倉／需求均不變；修正帳目後可以原流程重試。
- 無新增 Firestore 讀寫、集合、查詢或索引，未改 Rules。計算沿用已讀快照，預留交易證明依舊由 StockPermissions 及 Rules 驗證。
- v2 仍是純核心提案：StockPermissions 與 Rules 持續拒絕多位置欄位。尚須整合多位置實際交易、逐倉 movement／證明、履約、調撥與五角色驗收後才能啟用，不因本批合併而改動歷史資料。

安全檢查範圍與既有缺口記錄於 `reservation-location-rules-audit-20261017.json`；這不是全系統安全認證。

## Emulator-only 單品項雙倉取消／恢復原子交易（2026-10-17）

新增 `functions/single-item-location-lifecycle-service.js`：`commitSingleItemLocationLifecycle` 僅允許 `demo-yushin` Emulator；獲授權的管理員／本人業務或工程師，在尚未採購、到貨、打單、寄出、送達、退貨且無採購需求文件時，使用共同 `planLocationReservation` 在一個 Admin SDK Transaction 同時釋放 A/B 預留與訂單狀態，並在恢復時按即時空閒實貨重新分配。先讀後寫、來源與投影精確比對；原倉停用不影響釋放但禁止新增。單一 `inventoryReservations` ledger 保存 `lifecycleWarehouseIds`，操作憑證與所有 movement 和總／分倉改帳一同提交；重送不重扣，異常及寫入衝突整筆回滾。完整 Emulator 案例包含競爭訂單、兩倉差額守恆、停用倉改配、五角色邊界（admin／本人 sales／engineer 操作）、來源錯誤、重送與碰撞。**部分出貨取消、已有採購需求、其他品項及全角色 Preview 尚未整合**；本流程無 Callable／UI，不能上線。

## v2 採購需求同交易同步（2026-10-17，Emulator-only 接續）

既有正式 `procurementDemandRef` 採 `encodeURIComponent` 編碼整段 `SALES_ORDER:orderId:itemId`；內部 Service 已修正與相同 ID 對接。具有待採購需求但從未實際下 PO、收貨的 v2 初始取消，現在能同交易將既有 demand 改為 CANCELLED；恢復按當下兩倉可預留量，由 `Workflow.procurementQuantities`、`ProcurementDemand.fromSalesOrder/demandDocument` 統一計算並重新開啟或建立需求。若原 demand 的來源身份、角色、產品、倉庫、狀態或數量投影異常，或有任何 supplier commitment，整批回滾；仍不開放部分出貨、收貨、打單、退貨及正式前端流程。為 Functions 共用的 Workflow／Demand 模組由 `modules/` 複製生成並在 CI 驗證一致性；完整 Preview 尚未驗收。

## 部分交付的剩餘取消／恢復（2026-10-17，Emulator-only 接續）

本節取代前述「全部已有出貨皆不支援」的限制。既有 Service 現支援部分商品已出貨且全數確認送達、未交付部分尚未打單的雙倉單品項訂單。共用出貨／送達核心及既有 shipment proof adapter；不新增核心或交易 Service。取消只釋放剩餘預留，恢復僅重新分配未交付量，採購需求沿用 canonical ID 和 Workflow／Demand Core 同步。出貨、送達、累計打單及原訂購量與實貨／批次不變。

新增真 Emulator 案例包含：10 訂購→打單／寄出／送達 2→取消 8→恢復 8→再次打單／分倉出貨／送達至 10；別單占用全部自由庫存後恢復缺口 8，建立並再次取消正確需求；途中貨、剩餘已打單、錯誤投影／缺失或竄改出貨 movement 拒絕；權限、同 ID 併發、後段 create 衝突整批回滾。案例已加入 CI，驗收以實際執行結果為準。

尚未完成：途中貨物或未出貨打單的取消、已下 PO／收貨／退貨整合、多品項、完整初始化與前端、Preview 五角色全流程驗收。無正式部署或資料遷移。

## 未到貨供應承諾接續（2026-10-17，Emulator-only）

本節取代前述「已下 PO 全部不支援」的限制；只擴及從未實際收貨的供應紀錄，原已收貨／退貨及物流限制保留。既有 v2 生命週期 Service 用 orderId 與 demandId 有界查詢真實 supplyOrders（聯集最多 50 筆），核對來源、所有權、產品／倉、正式 PO 的明細連結及數量，再由相同 Demand Core 重新加總承諾；訂單／採購需求與實際供應不符或 incoming 不足時拒絕。

取消客戶需求保留供應與 PO、實貨及採購 incoming；採購需求 CANCELLED 只停新增採購，remainingToReceiveQty 繼續保留。恢復時傳入既有未收貨承諾，不重複預留現貨；供應商同意取消後再恢復，僅依最新有效承諾重新計算，不復活原供應。供應商不同意取消仍需採購自行選擇既有 KEEP_STOCK，未代填或改寫其決策。

Emulator harness 實際呼叫原 `commitFormalPurchaseOrder`、`registerPurchaseIncoming`、`cancelOutstandingSupplyRecord`，用 Admin Firestore Transaction 驗證銜接；harness 僅提供頁面／session adapter，不代表前端登入與權限已完成 E2E。案例包含 10 訂購／預留 7／採購 3 的取消恢復、供應商另取消後再恢復、未完成 incoming 登記、恢復與供應取消併發、來源／PO／在途錯帳拒絕、50／51 筆來源上限及後段 create 衝突原子回滾。測試結果以實際本機及 CI 為準。

尚未完成：供應實際收貨後的 v2 分倉入庫／再配置、途中貨及剩餘打單取消、多品項、完整初始化與前端、Preview 五角色全流程。無正式部署或資料遷移。

## 既有收貨 Service 連接雙倉來源（2026-10-17，Emulator-only）

本批直接擴充 `receiveSupplyOrderRecord`，不新增平行收貨服務。正常、取消來源均使用原 Receiving／Supply／Reservation Core：正常收貨只在供應指定實體倉增加實貨／預留，其餘倉保持；取消來源須原採購 KEEP_STOCK 決策，實收入自由庫存，原 released ledger 保持不變。缺少來源 reservation 一律拒絕（含取消來源），避免漏帳時繞過驗證。v2 交易限 demo-yushin Emulator，重讀 users、公司／其他倉、PO／需求及來源；receipt 位置版本標記讓重送同樣拒絕停用或變更角色。

Emulator harness 呼叫原正式 PO／incoming 登記、原收貨 Service 及 `keepCancelledPurchaseAsStock` handler（UI adapter 由測試提供）。新增分次 1+2 收貨、取消後實收自由庫存、錯帳／錯 PO／缺失或混合 ledger 拒絕、相同與不同 ID 併發、disabled replay、後段 receipt 衝突全回滾、正式入口阻擋及 admin／purchaser／warehouse 成本憑證與 sales／engineer 拒絕。測試結果以本機及完整 CI 實際結果為準。

尚未完成：來源出貨或退貨後的 v2 收貨、收貨後的 v2 取消／恢復、自由庫存對其他 v2 缺貨的重新分配、多品項／完整初始化與 Callable／前端／Preview 全流程。沒有 Firebase 正式部署或資料遷移。

## 收貨後取消／恢復接續（2026-10-17，Emulator-only）

本節更新前述「收貨後 v2 生命週期尚未整合」的限制。原 Service 已支援部分／全收及取消中 KEEP_STOCK 到貨後的取消恢復；供應餘量另取消仍沿用採購原 Service。逐筆 receipt、原入庫 movement、lot 與累計收貨同交易核對，不改其內容、不讀成本；receipt 聯集最多 50 筆，重用批次或 cumulative 中斷拒絕。來源單曾有已確認送達且批次已消耗的合法出貨，仍用既有 shipment proof 核對，不能把 lot remainingQty=0 視為從未收過貨。

取消只釋放預留，恢復傳入有效承諾減已收貨的在途。Emulator 以原採購／incoming／收貨／KEEP_STOCK／供應取消及出貨／送達 Service 串接，新增部分收貨→取消→恢復→再收貨、全收且 PO 結案、取消中收到貨再恢復、部分到貨後供應餘量取消、偽造／缺失／重用證明拒絕、收貨與取消併發、後段寫入失敗全回滾，以及收到的 lot 已出貨後取消剩餘需求。以實際本機及完整 CI 結果為準。

尚未完成：已出貨後再收貨、途中貨／剩餘打單取消、退貨混合情境、自由庫存對其他 v2 缺貨再分配、多品項／完整初始化及 Callable／前端／Preview 全流程。無 Firebase 正式部署或正式資料遷移。

## 部分出貨後再次收貨（2026-10-17，Emulator-only 接續）

接續原收貨 Service，支援無退貨的 v2 單品項雙倉來源在已寄出後再次分批到貨，包含尚未確認、部分確認及已確認送達的情況。採購需求與收貨共用明確 shipment context，區分未寄出缺口與待送達量，防止已扣倉商品重複預留。收貨 transaction 逐筆讀實際出貨 movement，驗證來源／倉別／數量／批次配置與快取一致；使用原始 item，展示 normalizer 不成為帳務權威。原 acknowledgement proof 的 intent hash 驗證保留。

驗收案例串接真實採購／收貨／打單／出貨／確認 Services：先寄 4→到貨 1→寄 1→到貨 2→跨兩倉寄餘量→全部確認，共消耗 10 件且實貨／預留／在途／採購缺口歸零。另涵蓋三種確認進度、固定收貨 ID 重送、扣帳缺失／竄改／錯倉／批次異常、快取不符整批拒絕，以及收貨出貨併發。測試使用真 Firestore Emulator；VM 僅連接 session／展示等依賴，並非完整 Auth／UI E2E。

無新資料模型／索引／Rules；不部署 Firebase，不動正式資料。仍待完成退貨後收貨／補送、多品項、跨訂單 v2 自由庫存分配、完整初始化與前端、Preview 五角色全流程；途中貨取消仍安全拒絕。

## 操作憑證重送的即時所有權檢查（2026-10-17）

單品項雙倉初始預留與取消／恢復的固定操作 ID，即使交易已完成，也會在同一 Firestore Transaction 重新讀取實際 orders 文件。sales／engineer 已被移轉訂單所有權時，原持有人不能再用歷史操作 ID 取回原結果；admin 維持原權限。重新檢查不要求目前物流狀態仍等於首次執行，因此合法的同一持有人仍可於訂單進度變更後取得冪等回覆，不會再次扣帳。缺少來源訂單則拒絕；角色停用及意圖碰撞的原檢查保留。本批沒有新增讀取於首次正常操作（僅將既有訂單讀取移到憑證判斷之前）；對已完成重送增加單筆 orders 讀取，不修改 Rules／集合／索引，也不代表 v2 正式啟用。

## 已釋放自由庫存跨 v2 訂單再分配（2026-10-18，Emulator-only）

新增在既有 `functions/single-item-location-service.js` 的 `commitSingleItemFreeStockAllocation`，同一個單品項雙倉預留 Service 使用 `Reservation.planReservationReceipt({addsStock:false})`，在一筆 Admin SDK Transaction 內，將真實公司及來源倉的自由實貨分配給另一張未採購／未打單／未出貨的 v2 缺貨訂單。僅增加公司、來源分倉 reserved 與既有單筆 v2 ledger；不變動 onHand／其他倉預留，也不將採購在途當現貨。

交易重讀有效角色（admin／purchaser／warehouse）、訂單同步、產品／實體倉、來源／數量投影及 canonical demand；有界查詢供應紀錄，任何已記錄的來源供應均拒絕此無採購試點。既有需求在同交易減少至真實剩餘缺口，不建立重複需求；沒有需求且全數分配時不額外建立零量文件。固定 operationId + intentHash 寫不可重用 movement，同 ID 重送不重扣；不同 ID 並發由 Firestore Transaction 衝突重試序列化。未有庫存或已無缺口時回覆零分配、不寫入憑證，允許後續重新嘗試。

實際 Emulator 測試涵蓋：A/B 取消釋放後由另一 v2 訂單分別接收、公司／來源倉差額、既有 demand 同步、冪等重送、角色／供應／取消與錯誤投影拒絕，以及同倉併發、操作 ID 衝突。此為**指定目標訂單的交易能力**，尚未實作 FIFO 自動挑選全產品缺貨清單／完整 checkpoint 續傳，也不開放 Callable、正式瀏覽器與 Preview。無 Firebase 正式部署、資料遷移或新增 Rules／索引。

## FIFO 候選掃描與可恢復進度（2026-10-18；僅 Emulator）

現有 `functions/single-item-location-service.js` 另提供 `advanceAutomaticFreeStockAllocation` 作為薄型協調入口：由指定產品、來源倉、最大分配量和固定 runId 開始，每次呼叫最多**推進一個訂單**。原子預留、採購需求和 movement 仍全部透過既有 `commitSingleItemFreeStockAllocation`，無另一套庫存數學。用 `Reservation.compareReservationPriority` 依日期／訂單／品項決定 FIFO；沿用既有 productKey＋status 查詢，每個狀態最多讀 51 筆，超過 50 筆立即拒絕，不假稱已找到全域最早。零預留 v2 候選可從權威訂單位置提示辨識，不開放無證據第三倉。

在既有 `reservationOperationReceipts/single-v2-free-batch-{runId}` 保存 actor、原請求 hash、最大量、累計已分配量、processedSteps、pending 目標與固定 operationId；與目標庫存異動之間是**可恢復兩階段工作**而非整批原子交易。先 durable 記錄待執行目標，再用固定 operationId 套用原交易，最後在 checkpoint transaction 累計；若已扣帳但進度寫入失敗，下次相同 runId 會從原 movement 重送取得原結果，且只計算一次。雙重繼續與同 ID 並發不得突破最大量。無候選、用盡額度或來源倉無自由庫存才標記 completed；需要新庫存時使用新 runId，不能以舊 completed job 偷做第二批。狀態為 active 的 job 必須持續以原參數重送，角色變更／停用或錯誤來源時拒絕。

**限制：** 目前仍為 demo-yushin 內部逐步執行，需呼叫端重複執行至 completed；不是排程自動觸發，也沒有 Callable、前端、Preview 或正式部署。每個狀態 50 筆上限是正確性閘門，不是大量候選最終方案；遇到已有供應／退貨或錯誤帳目將安全停止，等待稽核，不能偷偷跳過；需後續改善索引排序、分頁與跨批續傳。可恢復 checkpoint 只保證同一目標確定性重送，不宣稱所有品項／訂單合併為一個原子交易。

初始單品項 v2 writer 現在即使兩倉現貨皆不足、locations 為空，也將已驗證並排序的兩個候選實體倉存至同一 ledger 的 `lifecycleWarehouseIds`（僅位置證據、非額外預留）。之後相同來源重試若換成其他候選倉會拒絕；此欄讓 FIFO 協調器判斷零預留缺貨單可安全從第二倉分配，不准憑空加第三倉。舊 ledger 不做自動回填或正式資料遷移。

## FIFO 大量候選分頁與真實日期（2026-10-18）

將 #153 每個狀態超過 50 筆即拒絕的試點改成延續既有 Receiving Service 的 Firestore 游標分頁。每頁最多 50 筆，掃描 active 與 shortage 兩類後，才依共用 `compareReservationPriority` 選擇當前最早者，避免只看第一頁就分錯。單次完整掃描最多 500 份候選文件，超過上限安全停止，不寫入實體庫存或預留，也不將部分掃描當作完整 FIFO。每一步仍可能反覆掃描全部符合條件的 ledger；這是過渡驗證方案，不是已完成高效率索引式 FIFO；大規模資料仍需單獨規劃優先順序索引與候選投影。

初始 v2 來源訂單若有合法 orderDate/date/createdAt 日期，將其日期保存在既有 ledger 的 `orderDate` 供 Core 決定順序（後續重送保留原日期）；缺日期的舊紀錄仍沿用原有排序 fallback，不自動回填或變更正式資料。採購、出貨、退貨的權威判斷與冪等 checkpoint 維持現有 Service。

## v2 真實釋放來源與批次續傳接線（2026-10-18；僅 Emulator）

取消單品項 v2 訂單，在原本同筆原子交易內的每個 `single-v2-life-...` 庫存 movement 標記 `v2FreeStockSource:'CANCELLED_ORDER_RELEASE'` 和實際釋放數量 `freeAllocationQty`。只有 reservedDelta<0 的位置才會標記；恢復增加預留不建立自由訊號。可再上架的實體客戶退貨若採 `settlement:'CLOSE'`，在原先已與實貨、批次、退貨紀錄一起提交的 `location-return-...` movement 標記 `v2FreeStockSource:'CLOSED_CUSTOMER_RETURN'`，REPLACE 不標記。上述皆使用既有唯一交易 movement，**不新建庫存帳、不在來源交易內直接執行跨訂單分配**。

原 `functions/single-item-location-service.js.advanceReleasedV2FreeStock` 是來源證據檢查與續傳協調入口，核對現在登入者 admin/purchaser/warehouse、實際 movement 與原 cancel receipt 或 CLOSE 退貨紀錄。依 movementId 算出固定 runId，交給既有 `advanceAutomaticFreeStockAllocation` 逐單處理，進度仍由原 checkpoint 持久化；相同來源重試不重複增加預留。單事件超過 1000 件暫時拒絕試點續傳，來源實際交易仍有效，需另行分批策略。

**尚未完成：** 此版本為已提交事件的**可明確呼叫續傳入口**，沒有常駐 job runner、排程或自動觸發；尚未接入採購到貨（尤其取消後 KEEP_STOCK）、超大量分批與安全交接不同操作人員，也未正式接 Callable／UI／Preview。原單倉 `allocationPending` 完全不動，避免瀏覽器 v1 Recovery 誤判 v2 訊號。沒有新增 Collection／Rules／Index、正式資料遷移或 Firebase 部署。

## v2 採購收貨自由庫存來源的權威憑證（2026-10-18；Emulator-only）

既有 `Receiving.receiveSupplyOrderRecord` 會在同一個 Firestore Transaction 寫入實體 `inventoryLots`、`receipts/{operationKey}`、`inventoryMovements`、公司／分倉庫存及採購在途；多倉 v2 source receipt 在 receipt 記錄 `reservationLocationSchemaVersion:2`、`autoAllocationQty`、`sourceOrderStatus`，已取消來源另需採購明確確認 `KEEP_STOCK`。新增在現有 `single-item-location-service.advanceReleasedV2FreeStock` 的來源驗證入口直接讀**已存在的** receipt／movement／lot，校驗原來源供應、產品、批號／效期、真實入庫數量與可供分配的額外量；取消來源再驗證供應 `KEEP_STOCK` 的真實決策。**不修改瀏覽器 Receiving writer，也不新增第二套入庫 movement、來源標記或虛擬庫存。**

有效 receiptId 对應的原實體 movementId 作為固定分配批次身份，交給既有 FIFO checkpoint 與唯一 v2 `commitSingleItemFreeStockAllocation`；重試不重複入庫或預留，receipt 沒有剩餘實貨、只有採購在途、證據遭竄改／缺批次時拒絕。權限限制 admin/purchaser/warehouse 並在交易內重驗；仍屬**顯式呼叫**、一輪至多推進一個缺貨訂單，沒有 background runner 或正式 Callable，原單倉實際網站流程不受影響。未做舊單價／批次資料遷移，也沒有 Firebase 正式部署。

## 來源交易後自動嘗試與上次進度恢復（2026-10-18，僅 Emulator）

在原 `single-item-location-service.js` 加入 `drainReleasedV2FreeStock(db,uid,{movementId,maxSteps})` 作為**有界執行器**：逐次呼叫既有 `advanceReleasedV2FreeStock`，每次最多 10 個步驟（預設 5），每一步都重新驗證原始來源和現在物流角色，每個目標分配仍走相同原子 Service／固定 checkpoint。批次已完成立即停止，遇到競爭回傳 retry 不盲目重做；超過步數顯示 `recoveryPending`，下一輪使用**同一 movementId** 續傳。

原有 v2 取消及實體退貨 Service 新增**可選的 Emulator-only 組合入口** `commitSingleItemLocationLifecycleAndRecover`、`commitLocationReturnAndRecover`。先呼叫原權威來源 Service 完成原子提交，隨後以原 release／CLOSE 入庫 movement ID 執行 bounded drain；不改動原交易流程、來源身份或存量。客戶業務（sales/engineer）只可提交權限內取消／退貨，沒有物流分配權限時來源仍正確提交，組合回傳 `postCommitAllocation.status='recovery-pending'` 和可交由有權物流角色處理的來源 movementId；不能使用業務身份冒充倉管。對已提交事件重送來源操作 ID，會取得原來源交易結果並續傳原配貨批次，不會再產生第二筆取消、入庫或庫存預留。

**狀態**：新入口是**可被後續 Callable／工作佇列使用的內部組合 API**，尚未綁定正式頁面、排程或 Cloud Functions trigger，因此不表示所有取消／退貨現在已自動跑配貨。不同操作員無法直接接手已建立且進行中的 actor-bound checkpoint，需後續設計具真實身分及單筆 movement 稽核的 lease／安全交接。來源 movement 已成功但配貨失敗的回傳必須區分「交易已提交、後續續傳待處理」，不能告知使用者取消或入庫失敗。沒有正式 Firebase 部署、Rules／Index 更新。


### v2 自由庫存配貨進度完整性（2026-10-18）

已實作：既有 `advanceAutomaticFreeStockAllocation` 的每次 checkpoint 交易讀取（包含已完成重送及扣帳後結算）均經 `validateAutomaticFreeStockCheckpoint`。累計分配須為 0 至原 maxQty 的整數，步數為 0–1000；完成必須沒有 pending、具已知完成原因，quantity-reached 必須實際達到原額度。pending 必須具有完整且僅限既定欄位、正整數且不超過剩餘額度，操作 ID 必須依原 runId／步數／訂單／品項衍生。達 1000 步不可建立新指令。異常進度先拒絕，不自動改成完成、重設操作 ID 或推估已扣帳量。

沿用原 checkpoint、movement 與唯一自由庫存 writer；交易已提交但 checkpoint 結算失敗時，修復正確進度後仍以原指令重送，原 movement 確保不重複預留。不變更角色、Collection、Rules、Index、前端或 Callable，仍僅 demo-yushin Emulator。新增 Emulator 案例涵蓋完成憑證異常、pending 篡改與額度超限、扣帳後再讀進度異常及原 ID 續傳；實際執行結果以本批 PR CI 為準。完整 Preview、不同操作者安全交接及正式部署仍未完成。


### v2 配貨自動換人續傳（2026-10-18）

本節取代前述「不同操作員無法接手進行中 checkpoint」限制。相同來源 movement 的 `drainReleasedV2FreeStock` 現可由當前有效 admin／purchaser／warehouse 自動續跑；原來源 proof、批次意圖與固定 ID 保留。接手先在同一進度 transaction 核對原 pending movement，已提交量用共同結算 helper 計一次；未提交量仍保留相同指令。交接寫入同集合的不可重覆稽核，原動作執行者與目前接手人分開保存。

實際 writer 額外在庫存 transaction 核對現任批次與指令，舊人恢復連線不會拿過期工作扣帳；雙操作者競爭可能收到需重新讀取的回覆，不能改新批次 ID 重做。已完成批次可由合格物流角色唯讀取得結果。此為 Emulator 內部接手能力，未建立正式操作頁、Callable、背景 runner 或 Preview／正式部署。
