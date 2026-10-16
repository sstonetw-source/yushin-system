# 交易核心統一：實作對照與驗收進度

盤點基準：main `e7886b412671244ea27b1e5f47d3a5a67d4c5b68`。
本文件為本階段的持續更新清單；舊版 V2 計畫與歷次修正紀錄是歷史證據，不能直接當作剩餘工作或正式部署證明。

## 結論與範圍

現況是「已有共同計算與多個受控交易，但尚未證明所有入口、舊資料與正式環境全面一致」。不同入口不等於有漏洞；共用函式存在也不等於全部入口已接入。
本輪讀取各核心模組、app.js 相關入口、Rules 與現有測試；未修改正式資料、權限、Collection、Index、查詢或 Listener。

## 交易入口對照

| 動作 | 入口與共同函式 | 必須一致的資料／提交邊界 | Rules 對照 | 判定與剩餘驗收 |
|---|---|---|---|---|
| 建立訂單／估價單轉單 | saveNewOrder、markQuoteAsDeal → createOrResumeNewOrder → synchronizeOrderInventory | orders；逐品項 reserveSingleOrderItem 同步預留、公司／分倉、採購需求；來源文件另有可重試同步 | orders create、validNewOrderSourceSync、來源連結驗證；inventoryReservations、stockOperations | 共同同步已存在；整張建單不是單一交易，必須保留 pending／failed 工作狀態。轉單併發及重試仍需共同情境驗收 |
| Forecast 轉單 | createOrderFromForecast → createForecastOrdersDirectly → synchronizeOrderInventory | 訂單與 Forecast backlink 同 batch；庫存同步為後續階段 | forecasts、orders、來源同步證據 | 與手動建單的建立方式不同；不能宣稱已完全共用建立入口，需核對失敗回覆後的防重複策略 |
| 預留 | reserveInventoryForNewOrder → reserveSingleOrderItem；reservation-core | 每品項交易：訂單、inventoryReservations、inventory、warehouseStocks、procurementDemands、movement | validReservationSource、reservationCreateWriter／reservationUpdateWriter、businessReservationDemandUpdate | 單倉共用計算已接；一單多品項是逐項提交，不是整單原子。多位置尚未啟用 |
| 採購／部分採購 | printPurchaseOrder、markPurchaseItemOrdered、registerInitialSelfOrderSupply | supplyOrders、purchaseOrders、自行訂貨、來源品項、需求、在途庫存及成本；各入口各有提交程式 | purchaseOrders、supplyOrders、validSelfOrderSupplyCreate、procurementDemands | 數量已有共同 workflow／demand 計算；寫入編排仍分散，需逐入口相同情境驗收後抽共用提交，不直接大規模替換 |
| 收貨／部分收貨 | openSupplyReceipt、背景 receipt tasks → receiveSupplyOrderRecord；receiving-core | 實收、批次／成本、在途、來源預留與需求同筆交易；多單自由庫存分配為後續 checkpoint | receipts、inventoryLots、inventoryLotCosts、supplierReceiptDispositionAllowed、業務直送收貨證據 | 已有 operationId 與重試；到貨成功而分配待完成是明確的兩階段，不應強行合為無上限大交易 |
| 打單 | markOrderItemDispatchPrepared → itemDispatchState／fulfillment-core | dispatchPreparedQty 與工作索引；不可因此扣實貨 | orders 的限定 operational update、dispatchRecords | 已有共同可出貨計算；需與各出貨入口驗收打單上限 |
| 倉庫直接寄客戶 | inventory-workspace commitInventoryShipment；倉庫批次呼叫相同入口 | 出貨紀錄、送貨紀錄、預留、庫存、批次及成本 | orders、deliveries、inventoryMovements、stockOperations | 與業務送貨仍有不同提交函式；資料責任不同，先驗證相同扣帳規則，不機械合併 UI |
| 業務送貨／快速送貨／修改或撤銷送貨 | quickCompleteDelivery、saveDeliveryRecord、deleteDeliveryRecord、quickCancelAllDelivery → applyInventoryDeliveryDeltaInTransaction | 送貨紀錄、實貨／預留、批次扣回與成本 | businessPhysicalDelivery、businessDeliveryRecordChange、orders operational update | 部分共用庫存 delta；與倉庫出貨需對照併發／回覆遺失／確切批次退回 |
| 取消／恢復 | quickSetOrderLifecycle、saveOrderLifecycleStatus → adjustInventoryReservationForLifecycle → planReservationLifecycle | 整單讀取後同交易更新訂單、預留、公司／分倉與需求；已採購、已到貨不清零 | validOrderCancellationTransition、businessLifecycleDemandCancelUpdate／RestoreUpdate | 共同交易已接；仍需核對 CLOSE 退貨、取消供應處置及不同角色交叉情境，不能只看單一路徑測試 |
| 取消供應商未到貨部分 | cancelSupplyOutstanding、cancelPurchaseOrderOutstanding → cancelOutstandingSupplyRecord | 供應商承諾、在途與來源品項／需求同交易更新；客戶取消不自動撤銷採購 | supplyOrders、supplierCancellationResolution、procurementDemands | 有獨立商業意義，保留操作；批次採購取消逐筆提交，不是整批全成全敗 |
| 客戶退貨 | customer-cancellations saveReturnRecord → commitCustomerReturnReceipt；releaseCustomerReturnHold | 業務提申請；收貨確認後才記實收；可售入庫或隔離，保留原批次追溯 | returnReceiptOrderUpdate、customerReturnReceipts、inventoryLots／庫存證據 | 現行實收建立 settlement:CLOSE，不自動補送；新需求不可假定所有退貨都會重新開需求 |
| 調撥／業務保管 | commitWarehouseTransfer → commitWarehouseTransferReceipt；main-warehouse-transfers | 來源扣帳與途中責任；目的倉點收後入帳；業務保管不生成客戶送貨事實 | stockTransferRequests、stockTransfers、transferSourceStock／TargetStock／Aggregate | 發出、收回分屬真實時間事件，不能合為一次交易；自由庫存分配同樣有 checkpoint |

## 權威資料與數量契約

| 資料 | 目前依據與整理原則 |
|---|---|
| 訂購內容 | orders.items 的穩定 itemId 與 orderedQty／qty；頂層首品項欄位只供相容與顯示 |
| 已送／實收退貨 | deliveryRecords／returnRecords 是 normalizedOrderItems 的履約來源；無紀錄舊資料有相容分支，需集中管理，不批量改寫 |
| 有效交付 | 累計送貨扣除需補送退貨；CLOSE 不重新開啟履約需求。它不是「客戶手上仍持有的實貨」；不得混作實物餘額 |
| 預留 | inventoryReservations 對應到訂單與品項；品項 reservedQty、公司／分倉 reserved 是交易內同步的投影，不可各自修數字 |
| 實貨 | 各位置庫存與批次明細須能對帳；公司彙總包括保管／途中責任的既有定義不可在重構時擅改 |
| 採購與到貨 | supplyOrders 與 receipts 追溯實際承諾／到貨；需求 orderedQty／receivedQty 與訂單供應欄位是必須一致的累計投影 |
| 採購在途 | 已承諾未實收；不等於可用現貨；供應商取消需保留已實收部分 |
| 工作狀態 | workflow-core／orderWorkIndexFields 產生工作索引；不能另外依 isOrdered／isArrived 自建流程 |

### 本輪已整併

fulfillment-core 新增 deliveryQuantities，normalizeItem 與 dispatchState 共用累計送貨、退貨及有效量的公式；workflow-core 的明確 grossDeliveredQty 入口使用同一公式。
保留既有 deliveredQty-only 代表有效量、explicit effectiveDeliveredQty（含零）優先的相容契約。主要 app 呼叫原已明確傳有效量，不能把舊相容入口直接判成現有錯算。
不改退貨結案／補送決策、不新增持久欄位；本輪未宣稱已整併全部 app 內紀錄彙總與寫入。

## 後續固定工作順序及完成門檻

1. 完成共同數量契約：本輪已集中一組公式；接續核對 app 記錄彙總、退貨 CLOSE 與舊資料相容的所有消費端。
2. 建單／轉單：確認同一來源重試不多建單；未完成預留不可進採購／打單／出貨。保留可觀察的同步狀態。
3. 正常及部分履約：同一批數量走正式採購、快速採購、自行訂貨、倉庫寄客戶與業務送貨，驗證相同不變量。
4. 取消／恢復／退貨：已採購承諾不能被抹掉；CLOSE 不補送；庫存不憑申請增加；後項失敗不得提交前項。
5. 多倉／直送／保管／服務：多位置待完整交易與 Rules 同批接線；服務須確認既有實作，不能讓無物流服務進入實貨流程。
6. 通過完整行為與 Emulator 交叉情境後才移除相應舊邏輯；正式上線另核對程式資源版本、Rules、Index 及五角色桌機／手機結果。

驗收情境至少包括：正常全量、部分到貨／送貨、同產品多品項、取消後供應商同意／不同意、恢復、退貨 CLOSE／歷史補送、直送、保管、調撥途中、重複點擊、成功回覆遺失、交易重跑、後一品項失敗及角色切換。每一情境檢查訂單、需求、供應、預留、公司／分倉、批次、成本與紀錄，不以測試數量換算完成率。

## 驗證與發布

- 原始 main：本輪實際執行 1,112 項 Node 應用測試通過。
- 本輪新增跨模組數量契約、部分送貨→退貨→補送、舊相容與瀏覽器腳本載入順序驗證。
- 修改後實際執行 1,116 項 Node 應用測試全部通過；兩個修改模組的語法及 git diff 空白檢查通過。
- Node VM 載入不是實際瀏覽器驗收；正式登入、Emulator 及正式資料測試沒有由這些結果代替。
- 本輪無 Rules／Index 變更，也沒有正式部署。GitHub PR／CI 結果另記，不以 PR 建立代表 CI 通過。

### 2026-10-16 入口追查補正

上一批僅將快速取消／恢復移入 Service，狀態表單仍有獨立交易。此批把兩者接到 `setOrderLifecycleStatus`，保留表單日期／原因編輯能力，並驗證相同值重試、僅編輯中繼資料不動預留、庫存調整失敗不提交狀態。另將舊版送貨推估清除改為受保護交易，阻擋 stale modal 或 transaction retry 清掉新建立的實際送貨紀錄。其他送貨寫入入口仍待後續統一。

### 2026-10-16 訂單送貨入口統一

訂單頁的一鍵完成、一鍵撤銷、送貨新增／編輯、誤登更正四入口已移至 delivery-records Service，共用受保護交易與最新打單可出貨量核心驗證；消除 UI transaction 內讀取品項選單。補上樂觀完成連點誤觸撤銷、同表單成功回覆遺失、transaction 重跑、相同編輯／撤銷重試、取消訂單、CLOSE 與補送退貨投影及原批次／成本的測試。多筆相同批次回補先加總再寫入。此為訂單頁範圍；不代表倉庫工作區出貨、永久 idempotency ledger、多倉或服務型訂單全面完成。

### 2026-10-16 倉庫出貨接線

單筆／批次倉庫寄客戶的 commitInventoryShipment 已移至 warehouse-shipment Service，與訂單送貨共同使用可出貨量及有效交付投影；業務領貨、調撥仍是不同事實，不機械合併。補上操作識別碼的完整內容衝突檢查、歷史撤銷防重放、單筆倉庫／寄送資訊快照核對。測試包括跨入口更正後重試、交易 callback 重跑、回覆遺失、庫存失敗無部分寫入。尚待多倉拆量、服務型訂單及其他交付流程／正式環境驗收，不以本批取代整體完成門檻。

### 2026-10-16 調撥服務邊界

調撥寄出、點收及批次搬移實作已移至 warehouse-transfer Service，保留客戶送貨／倉庫移轉／業務保管的事實差異。寄出與點收分屬不同交易；自由庫存點收後的缺貨分配繼續使用既有 checkpoint，補上原 UID／角色在分配前後及完成標記內的核對。另補交易內批次產品／來源倉庫一致性及單筆業務交付快照。新增交易重跑、跨階段身分切換、候選批次改變的測試，保留既有調撥途中／點收重試／公司總量／custody 測試。主倉需求建立與取消、其他 UI 寫入、多倉拆量及 SERVICE 流程仍未完成。

### 2026-10-16 主倉備貨需求

主倉需求建立／取消已移至 main-transfer-request Service；公司與分倉備貨預留由 Reservation.planMainTransferHold 統一規劃後同交易提交。修正主倉備貨可用量未扣自由庫存調撥途中量的缺口；取消保留量不足時整筆拒絕，不縮減釋放量。新增核心邊界、重試、CANCELLED 不重開、SHIPPED 不可取消、交易失敗無部分寫入，以及成功後刷新失敗／終止狀態的 UI 回饋測試。未完成範圍仍包括多倉拆量、SERVICE 商品、其他分散寫入與正式環境驗收。

### 2026-10-16 自行訂貨雙入口合併

建單自動同步與手動自行訂貨共用 commitSelfOrderSupply，移除兩套重複供應／需求／來源訂單寫入。保留初始同步與手動登記的不同權限／同步時機，並固定原 UID／角色跨品項接續。手動作業識別碼在 transaction 外建立、同表單失敗重試沿用，回覆遺失不重複登記；相同 ID 不同內容拒絕。新增供應／需求／訂單整筆失敗、部分訂貨、直送、零成本、角色／帳號切換、核心缺失及 UI 重試測試。此批不涵蓋正式 PO、快速採購、多倉拆量、SERVICE 流程與正式環境驗收。

### 2026-10-16 快速採購服務邊界

快速採購交易移至 commitQuickPurchase，沿用 ProcurementDemand 與 Receiving 純規則及固定 supply ID。確認前捕捉 UID／角色，服務入口、交易 callback 重跑與讀取後均核對；callback 外固定 actor／時間，每次嘗試清空輸出。保留原供應快照、後續真實缺貨追加與 incoming 修復、不增加讀取。新增原子失敗、交易重跑、身分切換、邊界驗證測試。固定 supply ID 不是永久意圖 ledger，舊確認碰到後續等量需求仍待加強；正式 PO、多倉拆量、SERVICE 與正式環境驗收未完成，無 Firebase 部署或資料刪除。

### 2026-10-16 正式 PO 核心交易

正式 PO 建立抽至 commitFormalPurchaseOrder，PO／供應／需求／來源訂單同交易提交。修正同來源品項拆列時需求僅存最後一列的缺口，改為逐列累計、每需求一次寫入；同一備庫需求重複列暫要求合併，不臆測合併語意。新增原單號相同內容及供應紀錄核對後的只讀重試，內容或 actor 衝突拒絕，保留取消／到貨現況。測試涵蓋 callback 重跑、提交失敗無部分寫入、拆列、零成本、備庫／直送、身分切換、缺供應與內容衝突。正常建立不加讀取，既存 PO 重試每列加一筆 supply read。Incoming 分段 checkpoint、跨段身分固定、多倉拆量、SERVICE 與正式環境驗收仍待處理；無 Firebase 部署或資料刪除。

### 2026-10-16 在途分段同步收斂

registerPurchaseIncoming 固定建單／重試原 UID／角色跨 PDF 及逐品項接續，交易讀取後與提交後重新核對。每品項交易增加一筆已知 PO read，重查供應連結、原單終止狀態與供應歸屬。以 Receiving 投影計算剩餘在途，拒絕無效數量／超額到貨、公司或分倉不足以完整扣回、混用產品倉庫識別，移除預設倉庫猜測。快取採成功交易實際產品／倉庫，丟棄的 callback 結果不可外洩。測試涵蓋跨品項部分失敗續跑、帳號切換、舊畫面遇已取消原單、缺連結、數量異常、完整扣回及重跑不重複計入。保留逐供應 checkpoint，不宣稱整張 PO／incoming 已單交易；多倉拆量、SERVICE 及正式環境驗收尚待處理，無 Firebase 部署或資料刪除。

### 2026-10-16 採購取消／結清

cancelOutstandingSupplyRecord 補上原因／原身分／供應歸屬與正式 PO 連結驗證。缺來源文件、承諾量或公司／分倉 incoming 不足，均整筆拒絕，不以 clamp 掩蓋；保留已到貨及直送語意。整單停止移至 stopPurchaseOrderOutstanding，最後重讀原單及所有供應後 transaction 結清，移除 UI 直接 set；分段失敗與最後提交失敗都可接續，不重複扣回。成功後刷新失敗不誤報交易失敗。增加已知文件讀取：正式單列原 PO、整單啟動 PO 與最後 PO／各供應。無新查詢／Listener／Collection／Rules／Index，無部署或資料刪除；整張 PO 仍非單交易，多倉拆量、SERVICE 及正式環境驗收未完成。
