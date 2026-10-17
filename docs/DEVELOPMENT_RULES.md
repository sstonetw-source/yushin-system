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

- v2送達確認一律使用 `commitShipmentDelivery`／`projectShipmentDelivery`，目前僅demo-yushin Emulator；來源必須連結真實倉庫出貨及扣帳movement。確認不能呼叫現有會再扣庫存的delivery-stock Service，不可將新版與legacy事件混用。權限沿現有商業生命週期：admin或本人sales／engineer。修改須驗證真實預留→分倉寄送→分批送達／再寄下一批，並在執行時檢查送達確認僅讀3份文件、只寫orders；退貨／撤銷與前端／需求投影未整合前不可開放。

- v2送達撤銷必須使用 reverseShipmentDelivery，不能呼叫會補回實貨的舊delivery-stock撤銷。確認／撤銷／批次追溯須共用原身份、投影與shipment proof；操作ID不可跨動作重用。部分送達混合批次的實物退貨，須由操作者明確指定lotId／qty，不可猜FEFO或最後批次。planLocationReturnTrace僅唯讀，不可直接套其預覽進正式寫入；真正退貨入庫仍需另案整合所有帳與重試證據。

- v2實物原倉退貨一律走 `commitLocationReturn`（僅demo-yushin Emulator），共用 `projectShipmentReturns`／`planExplicitShipmentReturn`／`planReservationReturn`／`planLotRestoration`。不得直接提交唯讀追溯結果；須同交易重讀原出貨、先前入庫憑證、全部來源倉批次及原始帳。CLOSE／REPLACE 不可覆蓋他倉預留。已有退貨後的新打單／出貨／送達仍須獨立整合，不得解除現行入口阻擋來宣稱補送已完成。修改須跑 emulator-location-shipment 的分次、五角色、重送、競爭與末端失敗回滾。

- 訂錯貨以退貨CLOSE＋一般重新下單為主要流程；不能為此開放未完成的原單補送。新入口呼叫既有空白 openOrderModal／commitOrderCreation，只帶客戶及 returnReorderSource，禁止複製錯誤商品、價格、舊預留或收款。來源關聯需納入草稿及固定 pending ID，首次同交易驗證實收CLOSE／客戶／所有權，重送不能更換來源。現行前端CLOSE不重做，後端僅新請求未指定 settlement 時預設CLOSE；勿批次重寫舊REPLACE或改變其重試hash。

- v2 `dispatchPreparedQty` 的交易寫入新增內部 `commitLocationDispatchPreparation`（僅 demo-yushin Emulator），必須驗證 role、syncAttemptId、單品項 v2 ledger、已寄出投影及預留合計，使用 `Fulfillment.warehouseShipmentState` 計算可打單額度。前端 `prepareOrderDispatch` 尚不可直接操作 v2；不可只因打單時不扣實貨便繞過 Firestore 權限。重送需以固定 `dispatchRecords/v2-{operationId}` 連結原始意圖，禁止使用新 ID 重新消耗相同額度。測試須覆蓋先打單部分→寄出→再打單→第二倉寄出與同步併發及權限拒絕；此能力沒有 Callable／Preview／正式部署。

- 單品項 v2 尚未履約訂單的取消／恢復僅在 `demo-yushin` Emulator 內使用 `commitSingleItemLocationLifecycle`；絕不可直接讓舊 `setOrderLifecycleStatus` 對位置版本 2 寫入單倉預留。此 Service 從交易內重讀真正角色、來源、v2 ledger、原候選倉、公司及分倉數量並呼叫共同 `planLocationReservation`。若有任一採購需求（包含取消狀態）、供應、收貨、打單、物流或退貨事件即安全拒絕；直到採購需求同步與部分出貨取消完整接線並通過 Preview 才可對外開放。重送須固定 receipt ID 與 hash；不可以客戶端按鈕隱藏取代後端權限。

- `procurementDemands` 的 SALES_ORDER ID 是 `encodeURIComponent(YushinProcurementDemand.demandIdForSource({sourceType:'SALES_ORDER',sourceId,sourceItemId}))`，不能讀取未編碼路徑假設沒有已存在的採購需求。v2 `commitSingleItemLocationLifecycle` 針對零供應承諾／零收貨的正式需求以同交易同步 `CANCELLED`／恢復，再由共同 `YushinWorkflow.procurementQuantities` → `YushinProcurementDemand.fromSalesOrder/demandDocument` 產生待採購量。任何真實供應承諾、送達或退貨進度仍須使用未來整合後的權威交易，不可只改 `status`。`functions/shared/workflow-core.js` 與 `procurement-demand-core.js` 是 `modules/` 的 build 同步檔，禁止手工分叉、必須執行 `tools/build-functions-core.cjs --check`。此操作限 Emulator。
