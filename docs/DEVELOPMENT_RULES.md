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
