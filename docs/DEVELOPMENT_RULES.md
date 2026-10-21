# DEVELOPMENT_RULES — 修改規範與驗收閘門

**唯一原始碼**：`app.js` 是由 `src/` 生成的相容部署包，**禁止直接手工修改**。修改各 feature 源碼後執行 `node tools/build-app.cjs`，生成檔與來源需一起提交；`--check` 是 CI 必跑項。

## 實作規範

- 庫存策略／安全庫存與清單封存必須經 inventory-planning Service，不得在 Feature 直接 update／另開交易。固定 pending 操作 ID 到回覆及 UI 同步確認；已提交後刷新失敗與未提交須區分，原身分／視窗 generation 不符不得更新新畫面。新策略 audit 必須與 inventory 同交易且通過精確 schema／前後值 Rules。此次需同步審查及部署 Rules，GitHub 合併不代表 Firebase 已部署。

1. 先定位權威核心與既有 service；不要在頁面另寫交付、預留、在途、退貨、有效交付的第二套計算。
2. 畫面僅處理使用者輸入、讀取、驗證回饋；狀態推導在 core，真正變更由受保護 transaction / 服務協調。
3. 既有 `modules/` 是現行功能模組，**不得只為資料夾好看而複製一份到 src**。遷移需一次調整呼叫、文件、測試，並刪除舊實作。
4. 每個操作都要定義 actor、intent、attemptId、受影響的文件、數量上下限、錯誤回饋、重試／重複行為及權限來源。
5. 不在 Firestore Transaction callback 裡執行非冪等的外部副作用（寄信、瀏覽器通知）；拆為可追蹤的交易後作業。
6. 改 Rules 必須與讀寫程式、Emulator、五角色存取及需要的 Index 同步審查；不能用前端檢視身份取代 Rules。
7. 不為了刪除歷史相容而清空正式資料；若移除欄位需獨立規格、Preview migration 與可重建備份。
8. 正式 Firebase 部署與資料重置和 GitHub 合併是不同操作；未取得部署／刪除授權時只能提交程式。

## 每批提交驗收

- `node tools/build-app.cjs --check`
- `node --test $(find tests -maxdepth 1 -name '*.test.js' ! -name 'firestore-rules.test.js' | sort)`
- GitHub CI Desktop/Phone Chrome smoke + Firestore Emulator；失敗不能合併。
- 涉及交易需驗證正常、部分、取消、恢復、退貨、直送、服務型別及重複提交（各依變更影響範圍）；涉及權限需按角色檢驗。
- PR 說明要包含：變更入口、權威函式、Firestore 寫入與索引/Rules 差異、性能、測試數量、未驗收範圍。
- 沒有實際執行的驗收不能記錄成通過；需要人工或正式資料驗收時明列缺口。

## 待改善技術債

第一批完成來源責任切分及自動建置一致性；後續才讓 UI 與 transaction services 真正隔離、移除跨檔全域變數及保持 PR #91 的取消／恢復修正整合與測試。單純拆檔與生成 bundle 不是商業邏輯全面完成的證明。

- 核銷／核銷日期不能在畫面另開直接 update：必須呼叫 `setOrderBillingStatus` 或 `changeOrderBillingDate`，並保持修改歷史和角色保護。
- 收貨 Service 不得使用 window、document、Storage、UI 快取或呈現函式；Feature 不得自行重開收貨 transaction。提交後快取通知由呼叫端傳入同步 `onStockCommitted`，只在成功提交及身分檢查後執行，不得放在 transaction callback；通知失敗不能當成資料未提交。
- supply-order Service 同樣不擁有採購編輯狀態、取消確認、清單或快取；Feature 用 `onStockCommitted`／`onDemandChanged` 接收同步提交後通知。整張停止中途通知失敗不得將前面已完成的供應視為回滾，也不得提前標示整張完成；必須保留原 checkpoint 續跑。
- 正式建單文件提交一律呼叫 `commitOrderCreation`，包含手動、估價單帶入與 Forecast 多品項轉單。Feature 擁有草稿／待確認 ID／快取，Service 不依賴瀏覽器暫存或畫面。Forecast 訂單及來源 backlink 同交易提交；庫存初始化和延後來源同步仍各自保留 checkpoint，不能宣稱整條流程原子化。
- 庫存卡片的數量盤點一律呼叫 `commitInventoryQuantity`；Feature 不得另開盤點交易。操作 ID 在視窗待確認期間固定，重試核對原 movement／目標量／產品／倉庫／身分；不得換 ID 掩蓋不確定回覆。零差量也保存操作憑證。Service 透過同步 `onStockCommitted` 通知快取失效，不直接依賴 UI／Storage／快取；盤點已提交後的刷新失敗須明確區分。
- 人工／Excel 新增、批號／效期調整與報廢一律呼叫 `commitManualInventoryAdjustment`，Core 使用 `manualAdjustmentLots`。Feature 保留每列操作 ID，不能在部分失敗時重建已提交列；保留逐列 checkpoint，不宣稱整批原子。必須同步權威 inventoryLots；inventory.lots 只能由權威批次投影，不能再另算一份增減。成本只進受保護集合，不得為了去重把價格塞入 movement intent。
- 庫存清單與批號搜尋一律經實際批次 read adapter／operationalLotRows；禁止回退舊 inventory.lots、讀取成本集合或把分頁未讀完當作沒有批次。lookahead 文件不能跳過，零餘量文件也必須推進 cursor；載入更多／重試與跨身分失效要有執行測試。不得在 render 階段發 Firestore 寫入或無界讀取。

- 預留同步、取消／恢復使用 `validateReservationBalance` 的原始帳目檢查；不得先正規化或 `Math.max(0, reserved-release)` 掩蓋不足。新增位置配置前須同時驗證來源與目標帳目，callback 重試不可沿用上次結果或通知目標。

- 撤銷、退貨及退貨縮量的原批次更新必須使用 `planLotRestoration`，所有候選先讀後驗證；同 lotId 的分配合計後一次寫入，不可逐列以同一舊餘量覆寫。錯產品／倉庫不得猜測或重標批次。

- 撤銷／退貨的公司與分倉數量一律交 `planReservationReturn`；先驗證原始帳與完整差額，再還原原批次。CLOSE、REPLACE 及取消狀態不可由 Feature／Service 另寫 clamp 公式。

- 來源收貨與自由庫存分配共用 `planReservationReceipt`；需求分別由 Receiving／Workflow 與採購投影提供，不另造需求公式。只變更收貨倉預留，既有 receipt／transfer checkpoint、FIFO 與重試身分保護不能略過。

- 後端分組預留僅 Preview 選擇性開啟，必須檢查實際後端 `ENABLE_GROUPED_RESERVATION=true` 並使用相同來源同步 `syncAttemptId`；正式環境、前端未開啟或不符合初始雙倉條件時不呼叫 Functions。勿在未知回覆後盲目用另一 attemptId 重做；維持原訂單來源同步及採購需求 checkpoint。正式切換前須先完成 Functions Callable 模擬真實 Auth/role、正常/拒絕/併發、收貨/打單/出貨、取消／退貨與服務品項完整 E2E。

- 後端雙倉 Callable 的執行閘門必須同時核對 `ENABLE_GROUPED_RESERVATION=true` 和實際專案 ID 為 `preview-20135`；僅完整的 Auth + Firestore Emulator 下允許 `demo-yushin`。不可把示範開關或來源 JS 旗標當成正式部署授權。重大角色／身份改動須跑 `tests/emulator-grouped-reservation-callable.cjs` 的真實登入 SDK 測試。

- 單品項雙倉 v2 提交目前僅供 demo-yushin Firestore Emulator，`commitSingleItemTwoWarehouse` 不可匯出 Callable 或接線前端。先完成所有履約寫入與位置讀取的相容契約及 Preview 驗收，才可另案修改執行閘門。變更須跑 `tests/emulator-single-item-location.cjs` 的五角色、併發、回滾與重送測試；不得以 Node 靜態檢查取代實際交易驗證。

- 指定倉分批寄送使用 `commitLocationShipment`，目前僅 demo-yushin Emulator；不匯出 Callable／接前端。倉庫寄出與客戶送達必須分開，不能為了沿用舊 UI 把新倉庫事件寫成 deliveryRecords。不得另寫 FEFO、預留扣量或打單可用量公式；共用 Core 的部署副本一律建置產生。改動須跑 emulator-location-shipment.cjs 的多倉分批、五角色、併發、原子回滾與重送；Preview 啟用前補全部投影／簽收不重扣及其他履約入口。

- v2送達確認一律使用 `commitShipmentDelivery`／`projectShipmentDelivery`，目前僅demo-yushin Emulator；來源必須連結真實倉庫出貨及扣帳movement。確認不能呼叫現有會再扣庫存的delivery-stock Service，不可將新版與legacy事件混用。權限沿現有商業生命週期：admin或本人sales／engineer。修改須驗證真實預留→分倉寄送→分批送達／再寄下一批，並在執行時檢查無退貨的正常送達確認執行4次交易讀取（使用者、訂單、出貨 movement 與一次有界退貨憑證查詢）、只寫orders；退貨／撤銷與前端／需求投影未整合前不可開放。

- v2送達撤銷必須使用 reverseShipmentDelivery，不能呼叫會補回實貨的舊delivery-stock撤銷。確認／撤銷／批次追溯須共用原身份、投影與shipment proof；操作ID不可跨動作重用。部分送達混合批次的實物退貨，須由操作者明確指定lotId／qty，不可猜FEFO或最後批次。planLocationReturnTrace僅唯讀，不可直接套其預覽進正式寫入；真正退貨入庫仍需另案整合所有帳與重試證據。

- v2實物原倉退貨一律走 `commitLocationReturn`（僅demo-yushin Emulator），共用 `projectShipmentReturns`／`planExplicitShipmentReturn`／`planReservationReturn`／`planLotRestoration`。不得直接提交唯讀追溯結果；須同交易重讀原出貨、先前入庫憑證、全部來源倉批次及原始帳。CLOSE／REPLACE 不可覆蓋他倉預留。已有退貨後的新打單／出貨／送達仍須獨立整合，不得解除現行入口阻擋來宣稱補送已完成。修改須跑 emulator-location-shipment 的分次、五角色、重送、競爭與末端失敗回滾。

- 訂錯貨以退貨CLOSE＋一般重新下單為主要流程；不能為此開放未完成的原單補送。新入口呼叫既有空白 openOrderModal／commitOrderCreation，只帶客戶及 returnReorderSource，禁止複製錯誤商品、價格、舊預留或收款。來源關聯需納入草稿及固定 pending ID，首次同交易驗證實收CLOSE／客戶／所有權，重送不能更換來源。現行前端CLOSE不重做，後端僅新請求未指定 settlement 時預設CLOSE；勿批次重寫舊REPLACE或改變其重試hash。

- v2 `dispatchPreparedQty` 的交易寫入新增內部 `commitLocationDispatchPreparation`（僅 demo-yushin Emulator），必須驗證 role、syncAttemptId、單品項 v2 ledger、已寄出投影及預留合計，使用 `Fulfillment.warehouseShipmentState` 計算可打單額度。前端 `prepareOrderDispatch` 尚不可直接操作 v2；不可只因打單時不扣實貨便繞過 Firestore 權限。重送需以固定 `dispatchRecords/v2-{operationId}` 連結原始意圖，禁止使用新 ID 重新消耗相同額度。測試須覆蓋先打單部分→寄出→再打單→第二倉寄出與同步併發及權限拒絕；此能力沒有 Callable／Preview／正式部署。

- 單品項 v2 尚未履約訂單的取消／恢復僅在 `demo-yushin` Emulator 內使用 `commitSingleItemLocationLifecycle`；絕不可直接讓舊 `setOrderLifecycleStatus` 對位置版本 2 寫入單倉預留。此 Service 從交易內重讀真正角色、來源、v2 ledger、原候選倉、公司及分倉數量並呼叫共同 `planLocationReservation`。若有任一採購需求（包含取消狀態）、供應、收貨、打單、物流或退貨事件即安全拒絕；直到採購需求同步與部分出貨取消完整接線並通過 Preview 才可對外開放。重送須固定 receipt ID 與 hash；不可以客戶端按鈕隱藏取代後端權限。

- `procurementDemands` 的 SALES_ORDER ID 是 `encodeURIComponent(YushinProcurementDemand.demandIdForSource({sourceType:'SALES_ORDER',sourceId,sourceItemId}))`，不能讀取未編碼路徑假設沒有已存在的採購需求。v2 `commitSingleItemLocationLifecycle` 針對零供應承諾／零收貨的正式需求以同交易同步 `CANCELLED`／恢復，再由共同 `YushinWorkflow.procurementQuantities` → `YushinProcurementDemand.fromSalesOrder/demandDocument` 產生待採購量。任何真實供應承諾、送達或退貨進度仍須使用未來整合後的權威交易，不可只改 `status`。`functions/shared/workflow-core.js` 與 `procurement-demand-core.js` 是 `modules/` 的 build 同步檔，禁止手工分叉、必須執行 `tools/build-functions-core.cjs --check`。此操作限 Emulator。

- v2 部分出貨後的取消／恢復沿用 `commitSingleItemLocationLifecycle`，必須經 `projectShipmentDelivery` 核對送達並經 `readShipmentProof` 驗證實際出貨扣帳。僅已出貨全部送達、無剩餘打單、退貨、供應承諾／收貨的單品項雙倉可進入。不得用原 qty 直接恢復全量：傳入既有預留 Core 的目標須為 qty 減已確認交付。Emulator 須覆蓋取消→恢復→剩餘打單／出貨／送達、競爭庫存引起缺口與需求同步、重試／角色、出貨憑證錯誤與後段失敗原子回滾。仍禁止直接接正式 Callable／UI。

- v2 客戶取消可涵蓋未到貨供應，但必須同交易查核 supplyOrders 的訂單及需求兩種來源並限制最多 50 筆，再由既有 Procurement Demand Core 重建供應承諾。正式 PO 來源與停止進度、產品／倉庫／所有權、訂單／需求承諾及已登記 incoming 均需一致。取消不可擅自更新 supplyOrders／purchaseOrders／incoming 或替採購填入 KEEP_STOCK。恢復將真實未取消承諾傳給原 Reservation Core，不可重複預留現貨；已停止 supply 不得重新啟用。測試使用原正式採購、在途登記與供應取消 Service 搭配真 Firestore Emulator，區分交易驗證與尚未完成的 Auth／UI／Preview E2E；須覆蓋恢復與供應取消併發、後段失敗全回滾及 50／51 筆邊界。

- v2 實收來源接線修改原 `src/services/receiving.js`，禁止再建第二套 receipt writer。使用原 planReservationReceipt 與 applyReceiptToOrderItem，v2 分倉不足額檢查應比對本倉 ownQty，不得拿全公司 reservation.quantity 當成本倉持有量。保留其他 locations 並避免寫 warehouseId；取消 KEEP_STOCK 收貨不寫 released ledger。新 helper 必須在首次寫入前驗證 Emulator、真實 users 角色、來源／需求／PO、公司與其他預留倉，重送同樣核對角色，不能只信 session 按鈕。修 src 後重建 app.js。Emulator 須覆蓋分次到貨、原 KEEP_STOCK handler、三操作角色／兩業務角色、批次成本憑證、併發超收、固定 ID 重送、環境拒絕與後段寫入失敗全回滾；不把 VM session adapter 當作正式 Auth／UI E2E。

- v2 收貨後生命週期沿用 `commitSingleItemLocationLifecycle`，禁止新增另一套取消／恢復核心。供應狀態依原 Receiving.normalizeSupply；Functions 的 receiving-core.js 必須由 modules/ build 同步。供應承諾與收貨均須同交易核對來源、receipt／唯一入庫 movement／原 lot，最多 50 筆 receipt；累計與身份不符、批次重用、缺失或竄改憑證須在任何寫入前拒絕。恢復傳給 Reservation Core 的 incoming 僅為有效 ordered 減 received，Workflow／Demand Core 保留累計收貨歷史；不可將取消狀態當作沖銷入庫。測試須用原採購／收貨 Service 串接部分或全收、取消中收貨、供應餘量取消、已出貨批次的收貨證明、併發與後段失敗回滾。

- 部分出貨後收貨必須沿用 receiving Service 與 Workflow／Receiving／Fulfillment Core；明確提供 warehouseShipmentContext，不得把 shipped 填成 delivered。v2 交易驗證須使用原始 order item，不能用 presentation normalizer 重算的 shortage 覆蓋 ledger。實際出貨扣帳的純驗證共用 validateShipmentMovement；原 readShipmentProof 的 intent hash 核對須保留。新增測試涵蓋 pending／partial／full acknowledgement 後收貨、原展示 normalizer、完整跨倉收貨打單出貨送達、固定 ID 重試、憑證竄改拒絕及收貨／出貨併發。退貨、前端 v2 寫入或途中取消未整合前不能解除阻擋。


### v2 自由庫存配貨進度完整性（2026-10-18）

已實作：既有 `advanceAutomaticFreeStockAllocation` 的每次 checkpoint 交易讀取（包含已完成重送及扣帳後結算）均經 `validateAutomaticFreeStockCheckpoint`。累計分配須為 0 至原 maxQty 的整數，步數為 0–1000；完成必須沒有 pending、具已知完成原因，quantity-reached 必須實際達到原額度。pending 必須具有完整且僅限既定欄位、正整數且不超過剩餘額度，操作 ID 必須依原 runId／步數／訂單／品項衍生。達 1000 步不可建立新指令。異常進度先拒絕，不自動改成完成、重設操作 ID 或推估已扣帳量。

沿用原 checkpoint、movement 與唯一自由庫存 writer；交易已提交但 checkpoint 結算失敗時，修復正確進度後仍以原指令重送，原 movement 確保不重複預留。不變更角色、Collection、Rules、Index、前端或 Callable，仍僅 demo-yushin Emulator。新增 Emulator 案例涵蓋完成憑證異常、pending 篡改與額度超限、扣帳後再讀進度異常及原 ID 續傳；實際執行結果以本批 PR CI 為準。完整 Preview、不同操作者安全交接及正式部署仍未完成。


### v2 配貨自動換人續傳（2026-10-18）

自動配貨的換人續傳須沿用既有 coordinator 與 `commitSingleItemFreeStockAllocation`；coordinator 呼叫 writer 時必須傳入內部 batchContext，真正庫存交易重讀批次、當前 users 角色及固定 pending 指令，不可只在交接前檢查身份。禁止在接手時重建 runId、改寫舊 movement 操作者或重新執行已提交指令。原步驟與接手補結算共用 `settleAutomaticFreeStockStep`，不分叉進度加總。

實測須包含三種合格物流角色、停用原操作者、不合格接手者、尚未扣帳／已扣帳未更新進度、舊程序延遲執行、不同角色併發、原 movement 篡改、交接稽核失敗回滾及來源 movement 的 bounded recovery。仍不得接正式 Callable／前端；需另行 Preview 全流程驗收。


### CLOSE 退貨後的剩餘履約（2026-10-18，Emulator-only）

CLOSE 後剩餘履約須使用原打單／出貨／確認 Service 與 `projectShipmentReturns`，不能只解除 returnRecords 阻擋而略過實際退貨憑證。`normalizeLocationReturnIntent`／`readLocationReturnProofs` 共用於原退貨 writer 及後續履約；不得重寫 intent hash 或複製第二套驗證。Core 修改後重新產生 functions/shared 副本。

日期驗收須覆蓋同一批退貨後的較晚分次送達、反序退貨快取、同日累計上限及禁止用較晚送達回填先前退貨。交易驗收須覆蓋兩倉完整剩餘流程、五角色、超出原訂購量、固定 ID 重送、三入口缺失／竄改／刪除退貨憑證、併發超配與後段寫入失敗回滾。REPLACE、混合補送、退貨後送達撤銷、退貨後收貨／取消恢復及正式接線仍須獨立整合。


### CLOSE 退貨後的取消／恢復（2026-10-18，Emulator-only）

CLOSE 後取消／恢復仍拒絕未整合的退貨刪除／更正歷史，不能只因快取目前皆為 CLOSE 便忽略其他歷史動作。CLOSE 後取消／恢復不可移除保護後另算需求：一律沿原 `commitSingleItemLocationLifecycle`、`projectShipmentReturns`、`readLocationReturnProofs`、Reservation 與 Workflow／Demand Core。CLOSE 的有效商業交付應明確傳入 Workflow，不能單純用 returnedQty 再扣一次已結案數量。重送仍查真實使用者與目前所有權；新交易才重新讀取業務來源並提交。

需驗收取消／恢復兩方向的缺失／竄改／隱藏退貨 proof，真實競爭預留引起缺口，取消後配貨再恢復，五角色與外人／停用帳號，併發與末端 receipt 建立失敗（包含新需求全回滾），以及原採購→收貨→出貨→送達→CLOSE→取消／恢復的供應歷史保留。途中貨、未出貨打單、REPLACE／混合補送與全數完成仍拒絕，不可直接開放前端或 Callable。


### CLOSE 後收貨實作規則（2026-10-18，Emulator-only）

只擴充原 receiveSupplyOrderRecord，不可另建收貨 writer。新交易必須核對實際 return movements（包含空快取），共用 Fulfillment.normalizeLocationReturnIntent／validateLocationReturnProofs；Node 與 Web Crypto 只負責 SHA-256 adapter，不得各自正規化意圖或變更歷史 hash。原 Functions readLocationReturnProofs 仍為共同有界讀取 adapter。

使用含 returns 的 warehouseShipmentContext，gross／effective 要明確表達 CLOSE 商業結清；不得把 returnedQty 歸零或以待客戶確認量當實體缺口。測試須包含原真實採購→收貨→出貨→送達→CLOSE→後續收貨→剩餘履約、取消 KEEP_STOCK／恢復、錯誤憑證拒絕、固定 ID 重送與衝突、競爭交易與末端失敗整筆回滾。modules 修改須產生 functions/shared，src 修改須產生 app.js。仍限 demo-yushin Emulator，沒有 Callable／UI／正式 Firebase 部署。


### 取消來源 CLOSE 退貨驗收（2026-10-18，Emulator-only）

只能擴充原 commitLocationReturn 與 Reservation.planReservationReturn，不得另建取消退貨 writer。shipmentDeliveryContext 的 allowCancelledCloseReturn 僅此首次 CLOSE writer 使用，其他入口沿預設禁止取消來源；不要全域移除取消guard。取消ledger必須完整釋放，禁止藉退貨靜默釋放殘存預留或重新占庫。正常／取消兩種ledger目標分別為尚未寄出量／0，恢復仍由原 lifecycle重新規劃。

驗收須包含實際取消→退貨→恢復→剩餘履約、分次與超額拒絕、五角色／陌生操作者／失效帳號、錯誤狀態／ledger／實際movement／批次、退貨與取消／恢復競爭、末端碰撞回滾、固定ID replay、自由實貨有界配給其他訂單，以及真實PO／receipt／KEEP_STOCK後續收貨。原送達／撤銷／trace不得因此對取消來源開放。modules改動需用build-functions-core同步；無正式Auth／UI／Preview或Firebase部署。


### 退貨預覽必須與入庫共用剩餘額度（2026-10-18，Emulator-only）

只能擴充原 planLocationReturnTrace，不可另建批次額度核心或預覽writer。必須先用實際 return movements 核對快取，再以選定shipment的 priorReturns 呼叫原 planExplicitShipmentReturn；正常／取消皆只開放CLOSE後續查核。取消來源需一致狀態與空released ledger，並共用實際退貨的取消scope guard。不得開放一般取消送達／撤銷。

驗收需覆蓋正常／取消來源、既有CLOSE逐批扣額度、跨shipment不混用、五角色／陌生所有權／失效帳號、缺漏／變造／隱藏憑證及損壞ledger、201筆query拒絕、無成本／無寫入、預覽過期後入庫拒絕並可刷新。preview始終canCommit false，不得把預覽物件直接寫Firestore；實際入庫仍走原固定ID原子交易。modules修改須同步functions/shared並檢查app來源一致性。


### 真實登入退貨測試（2026-10-18，Emulator-only）

退貨Callable adapter不得加到正式functions/index.js；隔離runner只允許固定demo-yushin，臨時Functions入口必須引用實際checkout中的原服務，不可複製或另造退貨writer。保留明確flag、FUNCTIONS_EMULATOR、local Auth／Firestore host與db.projectId限制。測試資料只來自Emulator，禁止deploy或改正式Auth provider。

必須以Firebase Client Auth SDK真實登入取得token，再以Functions SDK呼叫，不能只傳假的request.auth宣稱Auth通過。覆蓋正常／取消CLOSE、五角色、陌生所有權、payload身份偽造、自訂claim不越權、token發出後角色變更／active停用、未登入／無效token／缺profile、同步attempt變更、固定ID衝突與併發重送。明確揭露上游初始化及sync仍為fixture，不能稱為正式UI或完整初始化驗收。CI執行node tools/run-v2-return-auth-emulator.cjs，需Node22與Java21、根目錄Firebase client/Admin依賴及functions依賴。


### 初始化同步不得用測試completed替代（2026-10-18，Emulator-only）

退貨Auth整合改用tests/fixtures/v2-order-initialization.cjs，必須載入實際src同步／預留協調／需求／索引函式並呼叫原v2庫存writer；測試不得直接update inventoryReservationStatus completed。只以SDK／傳輸adapter接入原雙倉Service，不另造計算或checkpoint writer，不讓原單倉預留覆寫v2 ledger。

本輪覆蓋七組實際Firestore初始化：雙倉與正式缺口需求完成、預留後需求前中斷與重試、完成重送、舊attempt晚回覆、角色／所有權／active、完成回覆遺失、切換帳號後恢復。退貨真實Auth七組亦全部經由此初始化，結果以本輪CI為準。仍明確保留來源order／inventory種子資料，未驗收完整建立訂單UI／Client Rules或初始自行訂貨，不能宣稱正式上線。

### v2 真實登入建單的整合測試閘門（2026-10-18）

新增測試於既有 `tests/emulator-v2-return-callable.cjs`，隨 `node tools/run-v2-return-auth-emulator.cjs` 在隔離 demo-yushin Auth＋Functions＋Firestore Emulator 執行。測試需以 Client SDK 登入業務本人、透過真實 Firestore Rules 執行原 `commitOrderCreation`，再由原初始化協調器與 v2 writer 建立預留與採購缺口，不可將直接 Admin seed 訂單當作「已驗收建單」。驗證含成本／無權倉管建單拒絕、同 ID 重送不得覆蓋來源或重扣帳。VM 只供 Firestore 模組化 SDK 介面相容，不得複製商業計算或新建單 writer。

此測試僅驗收單品項雙倉 Auth Client 建單入口到後續 Emulator 初始化的**部分鏈路**；正式網頁、真實瀏覽器登入／Role adapter、Preview、全面多品項／直送／服務型流程與正式部署仍須各自驗收。


### 2026-10-18 實際打單入口續傳整合

打單 UI 必須提供已持久保存的固定 intent；兩頁沿用同一 handler／Service。新增 Chrome smoke 與實際 Client Rules／Emulator 行為測試；不得以記憶體瀏覽器傳輸宣稱 Auth／Preview 全線 E2E。 詳見 [介面交易對照與驗收邊界](transaction-ui-integration-20261018.md)。已實作、待本批 CI；未部署 Firebase，單品項多位置仍未啟用正式介面。


### 2026-10-18 退貨實收 Service 接線

退貨實收及待檢轉庫存 UI 不得內嵌庫存交易，分別呼叫 commitCustomerReturnReceipt／commitCustomerReturnHoldRelease。Service 可重用既有訂單與批次 helper，但不得新增第二組數量或批次算法。退貨申請／撤回與採購取消處置仍待後續責任整理。 驗收項目與限制見 [介面交易對照](transaction-ui-integration-20261018.md)。未部署 Firebase，完整 Preview 全流程尚待驗收。

### 2026-10-18 整單雙倉提交規範

多品項初始預留使用原 Service 的 commitOrderTwoWarehouse，僅 demo-yushin Emulator；不得匯出 Callable 或直接解除前端位置限制。不能用多個獨立 commitSingleItemTwoWarehouse 宣稱全單原子。修改須驗證同產品共用餘額、既有預留合計、後項失敗與末端 create 全回滾、兩張訂單競態、五角色與原單品項回歸。整單 source／需求 checkpoint 及多品項後續履約未接前，不得把這一階段描述為正式整單全流程完成。見 [詳細契約](multi-item-location-transaction-20261018.md)。

### 2026-10-18 初始化工作接手

初始化預留與需求寫入必須在交易重跑時核對當前 attempt／來源；不可只在畫面或 callback 開頭判斷。需求間中斷及舊工作被新工作取代均須驗收；已完成來源重送不得重寫需求。Emulator Admin adapter 驗收不等於真實 Auth／正式 UI 完成。見 [初始化驗收](multi-item-initialization-20261018.md)。

### 2026-10-18 多品項收貨驗收

多品項收貨不得僅解除單品項檢查，須驗證完整穩定來源、合計公司／各倉持有量與兄弟資料不被 normalized 投影改寫。數量沿用原 Core；回滾測試須確認真實交易碰撞，不能把 adapter 例外誤當成功的回滾驗收。仍禁止正式 v2 呼叫。見 [完整界線](multi-item-receiving-20261018.md)。

### 2026-10-18 整單履約與原憑證

多品項履約必須先驗證全部事件再分組，不能以逐項 filter 隱藏未知來源。逐項數量仍交給原 projectShipmentReturns，整單合計不可溢位。所有實際退貨 proof 都須被核對；空 cache 不代表沒有入庫。歷史 fixture 必須與已啟用 writer／正式 UI 區分。見 [多品項打單驗收](multi-item-dispatch-20261018.md)。

### 2026-10-19 多品項送達實作與測試邊界

新增多品項送達必須沿用 `commitShipmentDelivery`，不能複製送達 Service 或重算數量；`projectOrderShipmentReturns` 是跨品項履約合計唯一權威來源。所有 sibling 出貨需核對 immutable movement，所有退貨證明需走原 reader。測試真實 Emulator 競態、憑證篡改、角色更新、重送與回滾；CI 全通過前不得合併，更不得開啟正式 Callable 或 UI。詳見 [本批契約](multi-item-delivery-20261019.md)。


### 2026-10-19 多品項送達撤銷（已實作、待本批 CI）

多品項撤銷必須沿用 reverseShipmentDelivery／projectOrderShipmentReturns，驗證全單出貨 proof 及隱藏退貨，不可逐項 filter 掩蓋其他品項。固定 ID 重送只回原結果。 僅 demo-yushin Emulator；未接正式 UI／Callable、未部署 Firebase，完整 Preview 仍未驗收。詳見 [同一份送達契約與驗收範圍](multi-item-delivery-20261019.md)。


### 2026-10-19 多品項履約後收貨（已實作、待本批 CI）

履約後多品項收貨必須先用 projectOrderShipmentReturns 核對完整事件，再篩選單品項傳入原 Receiving／Workflow；核對全部 sibling 出貨 movement，不得只信快取或選中品項。所有既有預留、供應、需求及角色驗證保留。 限 demo-yushin Emulator，未接正式 UI／Callable 或部署；詳見 [原收貨契約增補](multi-item-receiving-20261018.md)。


### 2026-10-19 多品項整單取消／恢復（已實作、待本批 CI）

整單取消／恢復不可循環提交單項交易，必須走原 lifecycle 引擎與完整 itemIds/單份操作憑證，所有來源雙向供應/receipt proof 都需驗證。共享Core決定數量與零剩餘fulfilled狀態；CI全部通過才合併。 仍限 demo-yushin Emulator，正式 UI／Callable 未開啟，無部署。詳見 [同一份 lifecycle 契約增補](location-lifecycle-20261017.md)。

### 2026-10-19 多品項 CLOSE 退貨（已實作、待本批 CI）

多品項實收需沿原commitLocationReturn與整單Core，trace及receipt共用出貨證明／全ledger查核；空退貨快取也必須查實際movement。實收核對同商品公司／兩倉合計，保留兄弟原資料；不可將唯讀預覽當實收承諾。全部CI通過才合併，正式入口未啟用。見 [原退貨契約增補](location-return-receipt-emulator-20261017.md)。


## 2026-10-19 多品項 CLOSE 後續收貨與整單取消／恢復

本節取代前述「多品項退貨後收貨／取消恢復尚未整合」限制。限原 2–5 品項、兩候選實體倉、completed 初始化及 demo-yushin Emulator。正常訂單已有可驗證 CLOSE 退貨時，可由原 receiveSupplyOrderRecord 繼續收貨，或由原整單 lifecycle 取消／恢復未出貨剩餘。CLOSE 不重開已交付需求；取消／恢復不改寫歷史出貨、送達、退貨、PO、供應在途、實收、批次及成本。

新增共用 Fulfillment.validateOrderLocationReturnProofs，先驗完整整單事件與有界（200）實際退貨 movement 集合，再逐項沿原 validateLocationReturnProofs 驗證 canonical intent SHA-256 與完整 returnRecord。後端 trace／退貨／lifecycle 與瀏覽器收貨共用同一核心；資料庫 query 與 SHA-256 保持平台 adapter。兄弟品項憑證不能被 filter 隱藏，空退貨仍須查核實際入庫。收貨只將選定品項事件傳入原 Receiving／Workflow，維持全單投影與各來源 ledger／合計持有量查核。

新增四項真實 Emulator 驗收：兩產品 CLOSE 後分批及固定 ID 重送收貨並完成 12 件歷史交付；兩產品退貨後原子取消／恢復及恢復後收貨；兄弟憑證遺失／hash／完整紀錄／來源／隱藏紀錄／更正歷史均零寫入；REPLACE 及取消中多品項收貨維持拒絕。fixture 沿真實初始化、PO、收貨、打單、出貨、送達、退貨 Services。

本地 Node 1560/1560 通過，完整 Emulator／Auth／Rules 與八組桌機手機 Chrome 以本批 CI 為準。無新 collection、欄位、Index、Rules、Listener 或額外資料庫查詢；沒有 Firebase 部署或正式資料寫入。多品項取消中 KEEP_STOCK 收貨、取消後再新增退貨、補送／退貨更正、正式 UI／Callable／Preview 真實登入全線 E2E 仍待後續整合。


## 2026-10-19 多品項取消後 KEEP_STOCK 收貨

本節取代前述多品項取消中收貨仍拒絕的限制。原 validateV2ReceiptSource 擴充為同時驗證正常及取消整單；取消時全部原 v2 ledger 必須 released、quantity／shortageQty 為零且沒有位置，全部品項無途中貨與額外打單。仍查核全部兄弟產品／來源、整單事件、出貨 debit 與 CLOSE 退貨實際憑證。選定 supply 必須有既有採購 handler 的完整 KEEP_STOCK 決策，不能將某品項核准套到另一品項。

receiveSupplyOrderRecord 沿原取消分支及 planReservationReceipt(requestedReserveQty:0) 入庫，不另建 writer、狀態公式或預留機制。只增加實貨與原收貨／批次／成本紀錄、減少原在途並更新選定品項與取消需求的實收進度；所有已釋放 ledger、兄弟品項與物流退貨事實不變。恢復仍沿原整單 lifecycle，以即時實貨與剩餘未出貨量配置。與恢復競爭時依交易重讀目前狀態，正常分支的來源超額保持自由庫存，不假設必定全部被本單預留。原 receipt ID／actor／role 重送、原自由庫存分配與 durable recovery 接線不變。

新增八項真實 Emulator 案例：逐供應採購核准、分批及完整收貨恢復、兩產品 CLOSE 保留歷史、五列同商品競爭、來源／空 ledger／決策／退貨憑證異常零寫入、五角色與重送綁定、同 ID／超額／恢復競態、ALREADY_EXISTS 末端回滾與回覆遺失、原 receipt 自由庫存來源及正式環境閘門。皆沿既有初始化、採購決策、PO、收貨、出貨、退貨與整單 lifecycle。沒有新資料庫查詢、Collection、持久欄位、Rules、Index 或 Listener。

本地 Node 1560/1560 通過；完整新增 Emulator、Auth、Rules 與八組 Chrome 以本批 CI 為準。僅 demo-yushin Emulator、2–5 個實體倉品項、兩個原候選倉；未啟用正式 UI／Callable、未部署 Firebase 或修改正式資料。多品項取消後再新增退貨、混合服務／直送、補送／更正及 Preview 真實登入全線 E2E 仍待後續整合。


## 2026-10-19 取消後多品項 CLOSE 退貨

本節取代前述取消後再新增多品項退貨仍拒絕的限制。僅 demo-yushin Emulator、2–5 個實體倉品項、原兩候選倉、completed 初始化。原 shipmentDeliveryContext 只有同時明確啟用 return／cancelled-CLOSE 選項才接受兩個狀態欄位均 cancelled 的整單；原送達確認與撤銷仍拒絕取消訂單。

原 trace 與唯一 commitLocationReturn writer 共用整單 context／取消 guard／來源 reader：每個品項都須無途中貨、無額外打單、無 REPLACE，退貨歷史僅有可對應原入庫的 add；每份原 v2 ledger 必須 released、quantity／shortage 為零、位置為空，並維持相同候選倉及所有權／商品來源。全單出貨 debit 與全單退貨 movement／canonical hash 查核不變，不能忽略兄弟品項。trace 仍只讀來源證據與原批次，不讀庫存或成本；多品項取消的選定 ledger 已由原整單 reader 查核，不重讀一次。

原庫存／批次／Fulfillment Core 處理實收及原批次還原，CLOSE 只增加自由實貨，取消狀態、released 預留、採購／需求／送達事實保留，不重開已交付需求。整單 returnedQty／isDelivered 沿原整單 Core 投影，只改選定品項；原固定 movement ID、actor／role、intent hash、原子提交、重送與提交後自由庫存續傳沿用。退貨後可接原 KEEP_STOCK 收貨及整單恢復，並依當下實貨配置原未出貨需求。

新增十項真實 Emulator 案例：正常及五列取消後退貨／恢復、唯讀 trace 與過期預覽、五角色及重送／所有權、兄弟出貨／ledger／途中／打單／歷史／隱藏憑證損壞、同 ID／超額／跨品項／恢復競態、ALREADY_EXISTS 末端回滾與回覆遺失、原自由庫存續傳及正式閘門，另含真實 PO→出貨→取消→兩產品退貨→KEEP_STOCK 收貨→恢復與取消前後各一筆 CLOSE。既有 Node context 契約更新為需同時明確啟用兩個退貨選項。

本地 Node 1560/1560 通過；完整 Emulator／Auth／Rules 與八組 Chrome 以本批 CI 為準。無新 writer、資料庫查詢、Collection、持久欄位、Rules、Index、Listener、Firebase 部署或正式資料寫入。正式介面／Callable 接線與 Preview 真實登入全線 E2E、混合服務／直送及退貨更正仍待後續整合。


## 2026-10-19 退貨申請／撤回與採購保留入庫介面接線

原 modules/customer-cancellations.js 的三個交易 writer 移入既有 src/services/customer-return.js：saveReturnRecord → commitCustomerReturnRequest、withdrawCustomerReturn → commitCustomerReturnWithdrawal、keepCancelledPurchaseAsStock → commitCancelledPurchaseKeepStock。Feature 保留原輸入、確認、pending 鎖、固定操作 ID、提示與 cache 刷新，已無 runRoleTransaction 或直接 tx 寫入。退貨實收／待檢轉庫存仍沿原 Service，未新增第二個 writer、畫面或操作步驟。

customerReturnPendingQty 原計算原樣移入 Service，不新增退貨額度公式。申請重送核對既有 request 的 ID、item、qty、date、reason、settlement、createdByUid；即使原申請之後已部分實收或撤回，也只回原結果，不再新增。錯誤內容不能沿用原 ID。撤回只關閉原申請未收餘量，保留 receivedQty 與 returnRecords；已完成／已撤回重送不重寫時間。三動作在交易讀取前後、寫入前及回覆前核對目前帳號／前端角色與 capability；真正身份、停用、所有權與作業權限仍交由原 StockPermissions／Client Rules，不以 capability 取代授權。

KEEP_STOCK 沿原採購決策／來源及倉庫驗證。原直送轉原選定實體倉只登記尚未到貨 incoming 與原 redirect movement，不增加 onHand 或預留；沿原 runRoleTransaction 原子同步 receivingSupplyOrders，重試不重複登記。沒有新資料庫查詢、持久欄位、Collection、Index、Rules 或 Listener。

新增六項 Node 行為測試、五項真實 Client SDK＋StockPermissions＋Rules 測試，涵蓋額度、原 ID 意圖／帳號、30 次上限、部分實收撤回、帳號／角色變更、回覆遺失及末端回滾；Client Rules 驗證五角色／偽造 capability、同 ID／超額競爭、停用與外人、部分實收撤回以及 KEEP_STOCK 原子來源／接收鏡像／在途。既有 1280／390 px Chrome suite 擴充原三個 click handler → 真實 Service，驗證未知回覆重試與 incoming 不重複。Chrome 為記憶體傳輸，不是完整 Auth Browser／Firestore 單線 E2E。

本地 Node 1566/1566、建置同步／語法／diff 通過；新增 Client Rules 與 Chrome 以本批完整 CI 為準。本批接線為原一般介面，v2 多倉正式 Callable／UI 閘門不變，沒有 Firebase 部署或正式資料寫入。v2 正式傳輸、Preview 及完整真實登入端對端驗收仍待後續整合。


## 2026-10-19 原打單介面的 v2 Auth 傳輸試點

本節僅擴充 demo-yushin 隔離 Emulator 的介面驗收，未解除正式／Preview v2 限制。原訂單頁與採購頁 markOrderItemDispatchPrepared → prepareOrderDispatch，在明確 YUSHIN_V2_DISPATCH_EMULATOR=true 時轉接 prepareV2OrderDispatchEmulator；其餘一般打單路徑不變。介面沿原 warehouseShipmentState，從原 raw item 的 warehouseShippedQty 計算已消耗的打單額度，不將客戶送達當出貨，也不改寫其他數量投影。原 sessionStorage intent 另保存既有 inventoryReservationAttemptId 作 syncAttemptId，固定操作 ID／數量／打單基準；v2 intent 不得降級改送一般交易。

傳輸要求 localhost／127.0.0.1、Auth 與 Functions SDK 的實際 app.projectId 均 demo-yushin、Auth emulatorConfig 為本機9099，並強制 Functions SDK useEmulator(127.0.0.1,5001)。實際 Auth currentUser.uid 必須等於原前端 actorUid，呼叫前後與回讀訂單後均核對目前帳號／角色；payload 不含 actorUid／role。未載入 Functions、缺同步 ID、環境不符、回覆不明或網路失敗均不 fallback 到一般 writer，保留原作業。成功後只回讀真實 order 更新 cache，不以回應 counters 拼造訂單。

沿既有隔離 v2-return-callable-adapter／runner 新增 prepareV2OrderDispatch，唯一 writer 仍 commitLocationDispatchPreparation。Firebase SDK 驗證登入 token，原 Service 重讀 users 的實際角色／active／disabled；自訂 claims 或 payload 不授權。v2 後端仍允許原 admin／purchaser／warehouse，現有兩頁 UI 仍只有 admin／purchaser 可操作，沒有新增倉管按鈕。正式 functions/index.js 不匯出此入口，沒有 Functions／Auth provider 部署或正式資料寫入。

原 normalizeLocationDispatchIntent 新增可選 expectedPreparedQty，提供時納入 canonical hash 且在讀取原 receipt 確認尚未提交後，於同一交易核對 prepared 基準。不提供者的既有 hash／重送契約不變。僅已確認未提交且基準過期，回 failed-precondition＋details.reason=dispatch-stale，由原 handler 清除舊提案，更新後再確認；未知提交結果不清除。沒有新持久欄位、Collection、Rules、Index、Listener 或數量／預留 writer。

新增五項 Node 測試與四項 Auth SDK→原 UI handler／Service→Functions SDK→原 writer→Firestore 整合：多品項含同商品及另一商品、admin／purchaser 的不明回覆／重新載入原 ID、五角色、即時降權／claim 偽造、未登入／payload UID／停用、同 ID／競爭 ID／打單基準與同步版本。既有八組 Chrome 中，打單 suite 加測1280／390px 原兩頁 renderer 與 click handler，在尚未確認送達的實體出貨後使用正確 Core 額度並跨頁重試；其 Callable 為 scripted local transport，真實 Auth／Backend 由獨立整合測試驗證，不宣稱完整 Browser Auth／Preview E2E。

本地 Node1571/1571、建置同步／語法／diff 通過；完整新增 Auth、Chrome 與既有全部 Emulator／Rules 以本批 CI 為準。v2 初始化、收貨、出貨、送達、取消／恢復與退貨的正式傳輸／UI／Preview 全線仍待逐步接線。


- v2 實體倉分批出貨登入傳輸 `shipV2WarehouseItem` 只存在隔離 `v2-return-callable-adapter`／測試用 Functions source，必須由 Firebase Auth 真實 uid 進入原 `commitLocationShipment`，在資料庫交易重讀 users 當前角色與全部來源，不能接受前端 actorRole 欄位替代授權。原 `functions/index.js` 仍不得匯出；正式 UI、Preview 與部署皆未啟用。修改須先驗真實 Auth／Callable／Firestore Emulator 的出貨與送達不混淆、五角色、偽造 claims、相同 ID 重送與錯意圖拒絕；後續接原倉庫頁時需再補瀏覽器持久 intent／未知回覆恢復／跨頁操作，而非直接把舊 deliveryRecords writer 當作新 shipment。


- 原倉庫單筆與批次出貨的 v2 本機試點沿用 `commitInventoryShipment` 與原 `shipV2WarehouseItem` Callable；只能在 localhost/127.0.0.1 的 demo-yushin Auth/Functions/Firestore Emulator 啟用。首次提交前必須儲存凍結的 UID／角色／操作 ID／倉庫／數量／日期／交付方案及同步 ID；未知回覆、角色切換或刷新不可產生另一份實體出貨。完成必須核對 immutable movement ID，回讀 orders 後才解除原 pending。原單與批次兩個入口不得改走另一套扣帳 Service，也不得將 v2 warehouseShipmentRecords 當成客戶 deliveryRecords。原舊式介面、正式 index/Rules 不應因測試閘門而改動；多候選倉選取、客戶送達、真實 Preview 瀏覽器驗收仍為獨立未完門檻。

- v2 客戶送達確認與倉庫出貨是獨立事件，送達只能沿 `saveOrderDeliveryRecord` → `confirmV2ShipmentDelivery` → 唯一 `commitShipmentDelivery`，不得再次執行 `delivery-stock.js` 之出貨／還原扣帳；隔離本機 demo-yushin gate 之外沿用一般系統。v2 必須由 Core 驗證來源出貨的 pendingQty，在 Firebase 交易內重讀所有權、送達來源扣帳憑證與權威進度；前端 sessionStorage 固定同一不可變 operationId／來源 shipmentId／數量，未知回覆保留意圖並可刷新確認。v2 未接撤銷前禁用舊版取消、更正及一鍵完成途徑；正式 index 不得匯出 v2 Callable；啟用 Preview、正式 Rules／Functions／資料遷移都須另外驗收。

- v2 送達撤銷的登入傳輸僅隔離 `reverseV2ShipmentDelivery` → 原 `reverseShipmentDelivery`，不得改用 legacy delivery-stock 還原實貨。正式 index 不匯出、原 UI 仍關閉；後續接線需固定撤銷 intent／操作 ID 與提交後回讀，未知回覆不可重建 ID 或退回一般更正路徑。測試用真 Auth SDK 驗證五角色、當前權限、來源 proof、重送與競爭；已有實物退貨仍拒絕。詳見 [原介面驗收邊界](transaction-ui-integration-20261018.md)。

- 2026-10-20 本機 v2 原送達紀錄的逐筆撤銷已接原 deleteDeliveryRecord → reverseV2ShipmentDeliveryEmulator → 唯一 reverseShipmentDelivery；取代上一條「原 UI 仍關閉」的本機限制。確認與撤銷共用環境／身分 gate，分開保存固定 intent；未知回覆或提交後回讀失敗不可換 ID／降級 legacy。原紀錄已消失仍需顯示同 ID 核對入口；角色變更／損壞暫存須關閉操作並顯示提示，不能靜默清掉。正式／Preview 未啟用，已有實物退貨仍拒絕。詳見原介面驗收文件。

- 2026-10-20 隔離 setV2OrderLifecycle 只接原 commitOrderLocationLifecycleAndRecover，唯一整單交易與後續有界配貨責任不變。真 Auth uid／當前 profile／所有權須在原交易查核；來源 applied／already-applied 和 postCommitAllocation.recovery-pending 必須分開，不得將配貨無權限視為取消回滾。原頁面尚未接線、正式 index 不匯出，沒有 Auth provider／正式部署變更。新 Auth 測試驗證來源、五角色、重送、競爭與末端失敗回滾；UI 接線前須另外驗證固定意圖、刷新回讀及原兩入口。

- 本機原取消／恢復兩入口已沿單一 setOrderLifecycleStatus 接上述 Callable，獨立 YUSHIN_V2_LIFECYCLE_EMULATOR gate 同時查實際 Auth／Functions 專案、本機 Auth 9099 與固定 Functions 5001。每個 await 後查原 UID／角色／capability；前端不授權後端。未知回覆保留原 intent，刷新後清單與表單都須提供確認入口；角色變更／暫存損壞顯示警告而非刪暫存。已確認提交後 UI 更新失敗與未確認交易須分開；cache 失效涵蓋所有原候選倉。須跑 Node、真 Auth 原 handler 整合及桌機／手機 Chrome。正式／Preview 與獨立 metadata 更正未開放。

- 原 free-stock-recovery 面板的 v2 試點須明確 YUSHIN_V2_RECOVERY_EMULATOR，本機 demo Auth／Functions gate 及原真實 users 三物流角色。唯讀載入不得啟動配貨；全完成的掃描頁也須保留正確 lookahead／cursor，不能把空結果當全部讀完。續傳只送原 movementId、最多五步；由原 release proof／coordinator 及 allocation writer 查核接手與重送。禁止新 ID／legacy fallback／自動重新取消。非同步回覆須核對 UID／角色及 UI generation；已確認配貨與畫面刷新失敗分開。需驗證 Node、真 Auth 原列接手、三合格／兩不合格角色、竄改拒絕、分頁與桌機／手機 Chrome。正式 index 不匯出、Preview／部署未開放。

- 真 Browser Auth 驗收不可用假的 firebase.auth／httpsCallable 或 Node 暴露函式代送瀏覽器的交易。SDK 本機打包，實際 Chrome 直接登入與呼叫 Emulator；只在真 HTTP 已完成後中斷回覆測重試，不偽造成功 payload。攔阻所有非本機瀏覽器網路，驗證 token 存在但不輸出 token／密碼。原登入／取消／續傳 source boundaries 改動應使測試失敗。頁面導覽／cache 殼與 Admin fixture 初始化須明列，不能稱為整站啟動或 Browser 建單全線。此驗收納入原隔離 runner、與原 Auth 測試依序執行。

- compat 的區域 callable 使用 firebase.app().functions(region)，全域 firebase.functions(app) 不是區域入口。測試替身須提供正確 app.functions 形狀；取消及物流傳輸另以全域 namespace 禁止 region 的行為回歸，不能再用接受任意參數的替身掩蓋錯誤。修改 src 同步重建 app.js；原環境／角色與後端 gate 全部保留。


## 正式採購多品項後端擴充（2026-10-20）

後端正式採購多列變更須覆蓋：五列上限、同訂單多品項、跨單／同產品不同倉、最後一列拒絕且零部分寫入、同號並行重送、不同號競爭同需求，以及停用使用者重送。不得把本階段測試當成原 UI、收貨或正式部署驗收。

原 PO 按鈕接線驗收必須實際點擊原表單，經真 Auth／Functions／Firestore Emulator，驗證 4/7 PO、來源與需求、四件在途、實貨與原批次不變。只允許隔離 PDF 實體輸出；不得改寫 handler、Service、Rules 或偽造 Callable 成功。驗收未通過不得合併，正式部署與正式資料遷移仍另行授權。文件 helper 與前端金額／搜尋投影使用 shared Supplier Core，須執行 build-functions-core 及 build-app 一致性檢查。


### 原採購單斷線恢復（2026-10-20）

原採購按鈕在呼叫同一 `commitFormalPurchaseOrder` 前，以 sessionStorage 固定原 UID／角色／單號及完整提交內容；未確認作業只允許原意圖重送，不建立新單號意圖。原採購頁提供「確認前次採購結果」，刷新後仍可經同一後端 writer 回讀 PO／來源／Supply，沿原 `registerPurchaseIncoming` 完成在途後才解除 checkpoint。讀取與導覽不得自行提交。僅 demo-yushin 本機試點啟用；正式／Preview 不啟用，未部署 Firebase。

後端交易及需求公式沒有新增第二套；畫面快取同步抽為共用 feature helper。存取失敗在提交前停止；回覆未知、回讀失敗、在途失敗、角色改變或暫存損壞均保留 checkpoint，不默默刪除或降級 client writer。回覆已確認後的畫面更新失敗須與交易未確認分開顯示。checkpoint 僅保存於同分頁 sessionStorage，不承諾跨裝置或關閉分頁恢復；價格資料不送入新 collection。無新 Rules／Index／Listener／正式資料遷移。

實作及尚未驗收範圍見 [整站驗收紀錄](full-site-emulator-boot-20261020.md)。


### 原採購單部分收貨傳輸（2026-10-20，待 CI）

原 receiveSupplyOrderRecord 在明確 YUSHIN_V2_RECEIVING_EMULATOR gate 中轉至 receiveV2Supply，僅 localhost／demo-yushin Auth 9099／Functions 5001 可呼叫，不回退原 client writer。原收貨工作保存 qty／lot／expiry／operationBase；傳輸前須核對 sessionStorage 已保存的同一意圖，回覆後回讀 receipts 權威憑證並核對真實 UID／角色，未知回覆保留既有工作與重試入口。

唯一權威收貨 writer 仍為 src/services/receiving.js。tools/build-receiving-runtime.cjs 從它與現有訂單／需求投影產生 functions/shared/receiving-runtime.js，僅注入每請求身分、SDK 與共用 Core，執行時不使用 eval／VM，不另寫數量或扣帳公式。build-functions-core --check 同時驗證這份 Service 生成內容。隔離後端每次交易重新讀 users 當前 active／disabled／角色、原 Supply／Order／v2 ledger；權限為 admin／purchaser／warehouse，不接受 payload uid、role 或 claims 替代。供應更新在同一交易經既有 sanitizeSupply 更新 receivingSupplyOrders，不暴露成本。

本批新交易入口僅接受正常單品項 WAREHOUSE 客戶訂單 PO、尚未打單／出貨／送達／退貨的來源。已提交憑證以原身分／內容核對後可冪等重試，不再次入庫。舊一般收貨路徑不變，取消、服務型、直送、備庫、多品項與後續履約的此新傳輸尚未開放。無新增 Collection／Rules／Index／Listener，正式 index.js 不匯出，未部署 Firebase。

驗收邊界見 [整站驗收紀錄](full-site-emulator-boot-20261020.md)。


### 同 PO 收齊後原打單與分批寄出（2026-10-21，待 CI）

驗收須由原完整網站／真 Auth 連續完成同 PO 第二次收齊、收貨回覆中斷後刷新重試、原採購打單後刷新同 ID 確認、原倉庫批次表單分批出貨及回覆中斷後刷新確認。不替換任何 handler 或偽造 callable 成功，僅實際 HTTP 已成功後中斷回覆。另以真 Auth 覆蓋最後餘量不同 ID 競爭、同 ID 並行、錯數量／批號／效期拒絕、全收後超收拒絕及出貨後原已提交 receipt 重試。此案例仍非完整訂單送達／退貨或 Preview 驗收。

本批本機語法與建置一致性檢查已通過；真 Auth、Chrome 及全套 Emulator／Rules 的執行結果以本批 PR 最新 CI 為準。未部署 Firebase，未修改正式資料。


### 同 PO 出貨後分批送達與不重扣驗收（2026-10-21，待 CI）

延伸原 1280／390 px 完整網站與相同 PO／來源訂單，原業務登入後使用原「分批交貨」選單及送貨表單，分別確認 1+1+2 件。首筆及末筆真 HTTP 成功後丟棄回覆，刷新原站後用原 intent 重試；完整核對所有實體帳／憑證不變與總共三筆 deliveryRecords。另跑真 Auth 同 ID 並行、不同 ID 競爭、錯意圖／超額／錯同步／無來源／扣帳憑證竄改、目前角色／所有權及停用拒絕。不得用假的 Callable 或直接改 deliveredQty 完成驗收。

本機建置一致性與語法檢查已通過；完整真 Auth／Chrome／Emulator／Rules 結果以本批 PR 最新 CI 為準。未部署 Firebase，未修改正式資料。

首輪整站驗收發現：原 openPartialDeliveryForm 在 renderDeliveryModal 已回填原待確認意圖後，又清空 deliveryQty。現於本機 v2 入口重新呼叫同一 renderer 恢復原數量／來源，不改寫 intent、不另造交易。既有 desktop／phone delivery smoke 同步改走原開表單函式，覆蓋此重整恢復回歸；修 src 後已重建 app.js 並更新靜態版本。修正後全套 CI 仍待執行，不將首輪失敗當通過。


- 採購 v2 出貨來源的退貨量必須沿原 itemDispatchState 的累計實收退貨快照進入 Workflow，不能使用 normalizedOrderItems 為補送顯示排除 CLOSE 後的 returnedQty。回歸須實際執行 normalize→dispatch→procurement，不能只 stub dispatch 且傳未正規化品項；保持 Core 對事件／投影一致性及未支援 REPLACE 的拒絕，並保留不同訂單共存的整站測試。


- 原退貨申請 UI 驗收須走原選單／表單／Client Service／真 Rules，並在角色切換與重載後核對待收清單、撤回及實貨零變更。v2 原實收尚未整合申請與物流角色前，customerReturn Service 的 SALEABLE／INSPECTION／DAMAGED 及 HOLD 轉庫存不得寫入該來源。不可只在頁面隱藏按鈕；原 receipt 已提交的冪等核對保留。下一階段必須沿唯一 commitLocationReturn 整合，不能另開入庫 writer 或直接以業務 token 假扮倉管。


- 商務退貨申請的 Rules 路徑只允許 returnRequests／returnPending／returnRequestMutationIndex／updatedAt，並沿原 validCommercialReturnRequestMutation；不可為避開運算上限放寬其他訂單欄位、角色或所有權。pending 掃描仍須涵蓋最多三十筆。須驗真 Auth／Client 三十筆末端 pending 與全部撤回、上限／旗標／夾帶實收成本及所有權拒絕，以及原同 ID／不同 ID 競爭與全套 Rules。前端與 firestore.rules 需配套發布，不得宣稱已部署。


- Client 退貨申請同 ID 並行可能先被 Rules 以舊提案拒絕；不得因此允許覆寫原申請的 createdAt 或重建 ID。僅在 permission-denied 後，以既有 runRoleTransaction 唯讀查 users／orders，核對目前啟用角色、真 Rules 所有權與原 UID／完整意圖；完全匹配才確認既有結果。callback 每次清空前次 confirmed 值，其他拒絕保留，禁止 fallback writer。純申請欄位的無效提案應直接拒絕，不串入其他更新驗證耗盡預算。


- v2 申請實收必須沿 commitLocationReturn 原交易，以可選 requestId 綁定原 operationId／hash；不可另寫一筆庫存交易後才回填申請。交易內讀真實物流角色及待收申請，核對已收量與原 linked events、申請餘量、出貨／lot／movement，原子建立 customerReturnReceipts。未帶 requestId 不得擴張原業務權限，有同品項待收時須走申請實收。舊 hash、完成後原 ID 重試、撤回／實收競爭與雙收貨人競爭須驗證。原 UI、固定意圖／未知回覆恢復、Preview／正式啟用在本契約批次仍未完成。


## 2026-10-21 申請實收的前端傳輸準備（UI 未開放）

receiveV2CustomerReturnEmulator 僅在明確 YUSHIN_V2_RETURN_RECEIPT_EMULATOR 與實際 demo-yushin 本機 Auth 9099／Functions 5001 開啟。所有 await 後核對 UID／role／capability；禁止 fallback legacy writer。固定意圖與刷新確認、並行衝突、當前後端停權和失敗回讀需有行為及真 Auth 測試。原 UI 尚未開放，下一階段必須補明確 shipment／lot 選擇、可見 pending 入口與 1280／390px 真 Browser 實收驗收後才能接按鈕。

本機 Node 1642／1642 通過；新增真 Auth 整合與完整 CI 結果以本批 PR 為準。未部署 Firebase、未變更正式資料或角色；詳細契約與未驗收邊界見 transaction-ui-integration-20261018.md 同日章節。


## 2026-10-21 原倉管退貨收貨畫面（本機 Emulator 試點）

本節取代上節原 UI 未接線的本機限制。僅明確 YUSHIN_V2_RETURN_RECEIPT_EMULATOR 與既有本機 demo gate 開啟；原正式／Preview 及 Functions index 不變。所有非同步回覆核對 UID／角色／session generation／原表單；resetSessionData 清除舊畫面，不刪待確認意圖。未知結果凍結表單且不能新建意圖；已確認交易後刷新失敗須明示成功並阻止再次提交。接線須驗收原1280／390px、分批實收、每批成功回覆遺失後重整確認、最終 returnPending=false 仍有確認入口，保留 legacy／撤回／成本隱私／全套 Rules 回歸。

本機 Node 1648／1648 通過，零失敗／略過；新增6項UI行為測試。原站真Auth／Chrome與完整CI結果以本批PR為準。未部署Firebase，未修改正式資料或角色。

同分頁的待收清單同時載入時，使用 queue generation 拒絕較舊回覆；收貨後的新清單不能被前次慢查詢或舊錯誤覆蓋。


## 2026-10-21 採購草稿非同步載入保護（已實作，待完整 CI）

非同步草稿初始化須在資料準備期間停用會被回填的輸入與提交入口，並在每次 await 後核對原視窗 generation／UID／角色。關閉、失敗、session reset 與舊回覆不得污染新草稿；以延遲載入行為測試與原站雙尺寸驗收覆蓋。


## 2026-10-21 文件製作與採購確認分離（已實作，待完整 CI）

文件輸出禁止呼叫採購承諾、在途修復或恢復交易。新增入口沿原 Service；確認前以原 UID／角色／單號及完整意圖保存 sessionStorage checkpoint，未知回覆保留原意圖，由獨立確認入口續傳。採購與 incoming 仍是既有可恢復分段流程，沒有宣稱跨所有品項已合為單一後端交易。欄位 change 只更新金額與缺價提示，禁止重建正在輸入的相鄰欄位；供應商 change 不重建品項表。
本節取代先前「產生 PDF 即登記採購」的操作契約；正式 Firebase 尚未部署。

補充：尚未確認的 DRAFT 文件可以編輯原單；同一 purchaseOrders 文件以 documentRevision 遞增、交易內比對預期版本，舊畫面不得覆蓋他人的修改或已確認單據。相同內容的未知回覆重試回原版本，不重複修改；確認意圖帶原版本，後端拒絕過期確認。載入視窗有未儲存內容時不能直接確認，須先儲存；只有已確認文件鎖定。此補充取代前述草稿一律鎖定／不可更新的描述。
