# BUSINESS_RULES — 核心交易數量與資料權威

版本：2026-10-15。此文件是目前程式與既有稽核文件的**已實作規則／目標缺口**對照，非正式環境驗收證明。

## 名詞與公式






### 指定收貨倉的共同預留分配（2026-10-17）

已實作：`reservation-core.planReservationReceipt` 共用於正常來源訂單收貨，以及已入庫自由庫存的缺貨再分配。收貨需求仍由 `Receiving.applyReceiptToOrderItem`／Workflow 決定；自由庫存仍沿用採購需求投影，已下訂在途不重複占貨。新契約僅計算實際收貨倉的公司／分倉實貨與預留差額，沿用原始帳驗證及 `reservationStockDeltas`，不選擇或搬動其他倉。

來源收貨模式只增加本次真實入庫量；再分配模式不新增實貨，受公司、該倉可用量及原 receipt／transfer checkpoint 限制。無效原始庫存／自由調撥途中量或帳目不足，在更新訂單、批次、需求及 checkpoint 前拒絕。合法單倉小數的操作數量與浮點庫存差額分開回傳，避免把浮點差誤列成額外分配量。取消來源 KEEP_STOCK 及獨立備庫入庫保留原流程。

純 Core 已驗證 v2 locations 在實際收貨倉增加預留並保留其他位置；StockPermissions／Rules 的多倉欄位阻擋完整保留。**多倉資料庫交易仍未啟用**，不能將此純計算或單倉 Emulator 當成完整多倉驗收。無新增查詢、讀寫、集合、Rules、索引、Listener、正式資料遷移或部署；其餘多倉取消／調撥／保管與 Preview 全流程仍待接線。

### 撤銷與退貨的共同庫存／預留投影（2026-10-17）

已實作：`reservation-core.planReservationReturn` 為送貨撤銷、客戶退貨及退貨縮量的共同數量契約。正常訂單撤銷送貨會還原實貨與本單預留；補送退貨同步增加／完整扣回預留；CLOSE 結案退貨只增加／扣回自由實貨；已取消訂單不重建預留，既有殘留須完整釋放。差額沿用 `reservationStockDeltas`，原始帳目沿用 `validateReservationBalance`，產品／倉位檢查與正向出貨共用。

公司、分倉或預留帳不足、缺公司帳、無效原始數量、明確品項投影不符時，先拒絕，再進行原批次的讀取與還原；不使用歸零掩蓋差額。縮減結案退貨後仍須足夠覆蓋其他訂單預留及自由調撥途中量。Service 不再自行解讀上述數量，沿用原事件去重、批次及角色交易；Core 純提案不是獨立重試憑證。

本契約只處理指定單倉，不得用單倉帳釋放其他位置的預留；多倉寫入阻擋維持，完整多倉還原與跨倉退貨尚未完成。直送獨立入庫、待檢品質及 Preview 全流程仍需後續驗收。無新增讀寫、Query、Listener、Collection、Rules、索引、正式資料遷移或 Firebase 部署。

### 原出貨批次的共同還原檢查（2026-10-17）

已實作：`inventory-core.planLotRestoration` 共用於出貨撤銷、客戶退貨與退貨縮量。Service 先按原批次 ID 去重讀取，再由 Core 核對全部批次的產品、倉庫及原始餘量；同一批次的多筆分配先合計後只寫一次。缺批次、錯產品／倉庫、無效數量及合計扣減不足時，在任何批次寫入前整筆拒絕。合法歷史小數／數字字串保留。

`reverseLotAllocations` 保留原 `costLotId` 血緣，不新增成本讀取或重算採購成本。現行 Service 不會把原倉的批次還原到另一倉；指定退貨倉與原批次倉不一致時安全拒絕，跨倉退貨需後續獨立的來源與目的批次契約，不能靠改 batch.warehouseId 完成。直送退貨的獨立入庫與待檢流程維持原入口，不在本批整合範圍。

不新增集合、Rules、索引、Query 或 Listener；重複批次改為一次交易讀取／寫入。公司／預留的負向數量計算、完整多倉還原、角色全流程與 Preview 驗收仍須繼續，不代表整套退貨與撤銷已全面統一。沒有正式 Firebase 部署、資料遷移或刪除。

### 指定來源倉的共用出貨扣帳（2026-10-17）

已實作：`reservation-core.planReservationIssue` 接收產品、實際來源倉、本次數量、預留帳及公司／該倉的原始庫存，統一產生出貨後的實貨與預留數量。`delivery-stock` 的正向出貨已接此核心，訂單送貨與倉庫出貨共用；批次挑選、交易內重讀、打單限制、事件識別碼與權限仍由原 Service／Infrastructure／Rules 負責。缺公司帳、異常數量、產品／倉位／明確品項預留不符時先拒絕，不先寫批次或用 clamp 掩蓋差異。

舊單維持原格式，支援合法小數及業務保管；允許未預留出貨的既有入口僅能使用本單預留加真正自由庫存，不可動用別單預留或自由調撥途中量。扣帳後的預留差額沿用 `reservationStockDeltas`，沒有第二套分倉公式。出貨撤銷與客戶退貨目前仍使用原有流程，尚未接入新版多倉出貨契約。

同一純核心已驗證 v2 locations 的指定倉分批扣量，保留其他倉預留並更新總量；缺額仍存在時不誤標完成。**此為多倉計算契約，不是多倉資料庫交易完成**。現行 StockPermissions 與 Rules 的位置欄位保護完整保留；不能先寫 v2 或把純測試當成多倉 Emulator 驗收。沒有新查詢、集合、索引、Rules、正式資料遷移或部署；現行出貨讀寫數量不增加。

### 預留同步與生命週期的共同帳目驗證（2026-10-17）

已實作：`reservation-core.validateReservationBalance` 共用於取消／恢復與一般訂單預留同步。在交易內驗證原始公司／分倉 onHand、reserved、transferFreeInTransit 與預留量；無效數量、預留不足及明確保存的品項 reservedQty 不符時整筆拒絕，不透過歸零縮量清帳。重新配置時亦驗證舊產品／倉庫帳；合法歷史小數與數字字串保留。缺少品項 reservedQty 的歷史資料沿用預留帳，不補寫或遷移正式資料。

同步的釋放量使用完整差額；callback 重試重置本次回傳及快取通知目標，並重讀驗證帳目。本批不新增查詢、寫入、集合、Rules 或索引；這是 Service／Core 防護，不代表所有原生寫入的 Rules 已完成同等稽核。多倉 ledger、完整服務型訂單與 Preview 全流程仍未完成。

### 無法單倉滿足時的多倉數量預覽（2026-10-17）

當安全的單倉選擇無法滿足品項，系統在交易內以最新公司及各實體倉可用量計算多倉只讀預覽，讓操作人員看到分倉數量與未覆蓋缺口。採購在途與自由調撥途中量不得當作實貨；預覽不能直接儲存或出貨。待實體倉調撥後應重新同步原單，不因預覽產生採購需求或變更任何庫存。


### 庫存策略與清單封存（2026-10-16）

- 策略只接受 NO_STOCK／SAFETY_STOCK／ORDER_ONLY；安全庫存須有限正數，其餘策略將目標量設為零。只改規劃欄位，不取消既有需求／PO 或修改實貨。
- 固定操作 ID 對應原身分與完整意圖，零差異也留 audit 憑證。回覆遺失、快取刷新失敗後沿用原 ID；相同憑證只回傳目前狀態，不撤銷後來的新設定／恢復。記憶體待確認狀態不保證跨重載／裝置去重。
- 封存僅管理員視角；公司、分倉與實際批次須全部有效且為零，包含預留、採購及調撥在途。恢復不要求零庫存；封存不是刪除。超過各 200 分倉或批次時拒絕，沒有無界掃描或自動遷移。

| 名稱 | 來源／定義 | 禁止混用 |
| --- | --- | --- |
| 訂購量 | `orders.items[].orderedQty / qty`，以實際品項為準 | 不因供應、補貨、調撥而改變客戶訂購量 |
| 累計出貨 | `deliveryRecords`／`deliveredQty` 的毛額（gross）事件累計 | 退貨後補送可大於原始訂購量，不截斷歷史事件 |
| 需要補送的退貨 | `returnRecords` 中非 `settlement='CLOSE'` 的數量 | 不補送退貨不能再製造需求 |
| 有效交付 | 毛額送貨 − 需要補送的退貨，依各模組輸入契約做下限 0／顯示上限 | 不把 `deliveredQty` 同時當毛額及有效量，不得重複扣退貨 |
| 尚待交付 | `max(0, orderedQty − effectiveDeliveredQty)` | 不等於待採購量 |
| 現貨 | `inventory` 公司總帳、`warehouseStocks` 各倉帳的 `onHand` | 不把途中調撥當目的倉已入庫 |
| 預留 | `inventoryReservations.quantity`，交易時同步公司／分倉 reserved | 不等於實貨扣除；分倉加總需與公司帳核對 |
| 可用庫存 | `onHand − reserved − transferFreeInTransit`（有此欄位時）下限零 | 不可只看公司總帳就假設單一倉能供應 |
| 採購在途 | `max(0,supplyOrderedQty − receivedQty)` | 不計入 onHand；不因建立 PO 直接入庫 |
| 缺口 | `max(0, outstandingQty − reservedQty)` | 不等於未下單數量 |
| 待採購 | 倉庫供應 `max(0, shortageQty − inTransitQty)`；直送依直送供應契約 | 不可把已下訂在途需求再重複採購 |
| 備貨／打單 | `dispatchPreparedQty` 表示打單準備事件量 | 不等於交付或扣減實貨 |

權威函式方向：`YushinFulfillment.deliveryQuantities`（PR #92）、`YushinWorkflow.projectItem`、`YushinInventory.normalizeStock`、`YushinReservation` 的預留計算；不同呼叫入口不得複製公式。

## 流程與寫入最小契約

- **下單／轉單**：來源可來自 UI、估價單、Forecast；重複執行不能產生額外訂單、預留、採購需求。同一品項的預留／需求同一 Firestore transaction；若整筆單有逐項 checkpoint，必須可重試與辨識已完成。
- **補貨需求併發**：同一安全庫存需求的不同正式 PO 必須在交易內讀取並更新相同 `procurementDemands/{demandId}`，不能只信任開表時的 `demandOrderedQty`。舊需求已取消、識別不一致、數量超過剩餘需求須拒絕；未指向具體補貨需求的手動庫存 PO 各品項使用每張 PO 專有需求 ID，不共享其他 PO 的數量。
- **一般採購**：建立 PO 與 supply event，增加在途，不增加庫存；部分採購不能讓實際需求重複下單。安全庫存的「建立採購單」入口只準備表單，不應先更新 `procurementDemands`；使用者確認儲存後，由 `commitFormalPurchaseOrder` 在同一交易寫入 PO、Supply 及需求，避免未採購的幽靈需求。
- **收貨**：`supplyOrders`、`receipts`、`inventoryLots`、`inventoryMovements`、`inventory/warehouseStocks` 及來源品項的必要資料以受控交易更新；累計不能超過有效已下訂量。部分收貨重試不可重覆加庫存。
- **打單／出貨／送達**：備貨量、累計送貨與實際扣庫存是不同事件；倉庫交業務保管不代表已送客戶。
- **取消／恢復**：不得重複釋放／重複預留；非補送退貨不產生新需求。須檢查每個 itemId 唯一性及現有公司／分倉庫存。
- **退貨**：紀錄必須包含是否補送及實際入庫；不補送退貨與補送退貨不得共用一個扣法。
- **調撥**：來源倉扣出、途中量、目的倉點收必須可追蹤；公司總庫存不得憑調撥增加。多倉分批位置模型尚未全面啟用。
- **直送**：`DIRECT_SHIP` 不得增加公司倉庫 `onHand`，供應商訂購與實際直送確認留獨立事件。
- **服務訂單**：`Service` 產品型別不得創造虛擬實貨／批號。**目前尚須補完整的流程與 Rules 驗收，不得視為已完成**。

## 一致性守則

1. 同一交易需要的文件更新必須一起成功或一起失敗；跨多個交易 checkpoint 需要明確 attemptId／狀態與失敗恢復。
2. 操作識別碼須能防止頁面重複點擊、網路重試及交易 callback 再執行造成重複入帳。
3. 前端按鈕停用不能代替 Firestore Rules；資料寫入應經 `runRoleTransaction` 及 `StockPermissions` 既有安全契約，或經過驗證的等效後端交易。
4. 授權角色：admin、sales、engineer、purchaser、warehouse。以登入者真實身份為準，切換顯示視角不提升資料寫入權限。
5. 變更資料模型前，先列出每個 collection、索引、Rules、查詢、函式和測試的影響；在 Preview/Emulator 驗證，正式資料不得自動清空。

此文件的流程細節應與 `docs/system-architecture-20260923.md` 及 `docs/workflow-consistency-audit-20261014.md` 核對；尚未解決的多地點／端到端缺口不得標成完成。

## 補充：有效交付與收貨保留
- 訂單級有效交付由 `Fulfillment.projectOrderDelivery` 統一推導。不補送結案退貨計入歷史退貨量，但不重新創造交付需求。
- 收貨預留量使用 `Workflow.projectItem` 的可預留缺口，再依實收數量決定 `reservedDelta`，不自行重新計算累計交付。

## 收貨重試契約（2026-10-16，已實作）

同一到貨操作識別碼只代表一組供應單、數量、批號、效期與已保存的執行身分；內容不同不能以既存收貨憑證回報成功。原工作身分須跨入庫、進度修復及缺貨分配維持一致，切換後停止接續。實貨已提交的後續失敗需清楚回報，重試不得再次入庫。直送不建立公司庫存批號／效期，業務及工程師可用原工作重試，仍須具備該供應及來源訂單的確認資格。

收貨必須能完整扣回核心計算的公司與分倉在途量；不足時整筆拒絕，不強制歸零。供應已指定來源訂單時，來源及唯一品項必須存在，產品／供貨方式與未到貨承諾須一致；正常訂單的預留帳、位置及數量須一致。缺來源不能擅自改當庫存補貨，缺入庫倉庫不能猜預設倉。取消來源僅在既有 KEEP_STOCK 決策下入自由庫存，不重建來源預留。上述是 Service 已實作的防護，不代表 Rules 與歷史資料已完成全面驗收。

## 建單與轉單提交（2026-10-16）

手動建單及估價單帶入仍共用正式訂單視窗；Forecast 單品項也沿用視窗，多品項直接建立一張訂單。各入口共用 `commitOrderCreation`，既有待確認 ID 重試以已保存的原單內容為準，不把修改過的表單覆蓋到已提交單據或庫存進度。身分／角色變更停止接續；已提交後變更不代表原交易回滾。

Forecast 多品項的新建交易重讀來源，核對存在、未取消／作廢、負責人及畫面提供的 updatedAt，訂單與來源連結同交易提交；來源更新衝突需重新整理。斷線或庫存初始化失敗保留瀏覽器內同帳號／同 Forecast 的待確認 ID，庫存完成後才清除。庫存與後續來源同步依然是分段流程；此機制不是跨裝置永久去重 ledger，也不禁止完成後另一次明確轉單。

## 庫存數量盤點提交（2026-10-16）

庫存卡片「修改庫存」經 `commitInventoryQuantity` 同交易調整公司總量、指定分倉、既有批次／未分批數量及 movement。沿用 `YushinInventory.quantityAdjustmentLots` 作為批次投影，不建立另一套批次扣減算法；盤盈不臆測成本。採購、倉管與管理員可使用，業務／工程師無此能力。

每次視窗內的待確認作業保留固定 ID 與原內容。同 ID 核對目標量、產品／庫存文件、倉庫、備註及原 UID／角色，回傳原差量，不重新套用目標量；即使後續已到貨或出貨也不覆蓋。零差量同樣寫入零數量異動憑證。未知回覆後修改內容會被擋下，須先確認原結果；關閉／重新開啟或重載不保證恢復原 ID，必須先查清既有結果，不宣稱永久跨視窗／跨裝置去重。

無效原始數量、預留大於現有、盤點後不足以支撐公司／分倉預留、產品／倉庫識別不符與批次超過分倉總量均拒絕，不使用正規化歸零掩蓋。保留舊單倉缺分倉文件的明確 fallback；它仍由呼叫端依已載入倉庫主檔判斷。盤點不等於完整庫存對帳或盤點期間凍結進出貨，新的獨立盤點仍以提交時庫存計算差量。

## 手動新增、批號調整與報廢（2026-10-16）

三種入口與 Excel 預覽後的確認共用 `commitManualInventoryAdjustment`。每列庫存、分倉、批次、初始成本與異動一起提交；整批逐列完成，確認成功列移除，未確認列保留原操作 ID。原 ID 比對型別、產品、倉庫、有效差量、批號／效期及原 UID／角色；成本有權角色的初始庫存另核對原成本。改內容不能把已提交操作當新提交，跨列換帳號後停止後續及 UI 更新。ID 僅留在視窗記憶體，重開或重載前須先確認結果。

初始庫存只接受正數；報廢轉為負差量，普通調整可正可負但不可零或無效。公司與分倉調整後不能小於已預留量。正調整建立新批次；負調整／報廢同步扣 `inventoryLots`，有指定批號／效期時只扣符合批次，不足拒絕；無指定則共用 FEFO。原批次來源／效期／receipt 身分不重寫，舊列表鏡像不能當第二份數量權威。

採購／管理員新增庫存必填實際成本，可明確填零；倉管只建立受保護的 costPending，不取得實際成本讀權限。一般盤盈或補足歷史未分批餘額不臆測取得成本。主檔已停用／不存在、必要批號／效期缺漏、保管倉或明確 Service 品項均拒絕。這不代表完整服務訂單與歷史資料已完成驗收。

## 庫存批次顯示與查詢（2026-10-16）

庫存清單的批號／效期以 `inventoryLots` 剩餘量為準，舊 inventory.lots 不作顯示或批號命中的回退來源。零餘量不顯示為可用批次；未知或錯誤資料顯示讀取狀態，不當成零庫存。只載入部分批次時明列「尚未讀完」，按需讀下一頁；完整讀完沒有剩餘批次，也不代表沒有未分批實貨。已讀列依共同 FEFO 排序，未完整時不承諾列出全庫最早批次。

貨號／品名／廠牌維持原索引搜尋；批號需完整且區分大小寫，效期使用 YYYY-MM-DD。批號／效期直接查實際批次，與商品結果依 inventory 文件 ID 去重；超過單頁需載入更多，讀取失敗不顯示為搜尋完成或沒有庫存。舊批號只留在鏡像、實際批次已耗盡時，不再單憑鏡像命中。

## 2026-10-17 預留選倉與途中量（已實作）

自動選倉與真正增加預留使用同一可用量：onHand − reserved − transferFreeInTransit，最低為零，並受公司可用量上限約束。預設倉只有調撥途中量時，不能優先於有實際可用貨品的其他倉；單一其他倉僅足部分數量時，採購只列真正未覆蓋量。active:false、systemCustody、warehouseType:CUSTODY 及 custody- 位置均不可承接新訂單初始化預留，包含位置已被供應進度鎖定的情況。

本批仍維持單品項單倉交易；需多倉合併的情境繼續拒絕，並不代表多倉拆量或保管交付流程已完成。未改正式資料、Rules 或部署。

## 後端雙倉分批預留的邊界（未啟用）

Callable API 不接受使用者提供的角色、庫存總量或指定倉庫；只接受訂單 ID、固定重試 ID 及 2–5 個來源品項的目標預留數量。品項識別／倉庫／產品／可交付量及操作權限均在單一 Firestore Transaction 中重讀。數量差額使用唯一 Reservation Core；預留不得超過訂單剩餘有效交付需求，不得使公司或分倉預留與自由調撥途中量超過實貨。退回或重新分配仍需對照當前預留並保存操作憑證，前端直接寫入路徑尚未取消。這是階段性後端接線基礎，沒有宣布多倉出貨可用。

## 單品項雙倉原子提交（2026-10-17，僅 Emulator）

初始 pending 同步以原 syncAttemptId 提交；尚無供應／收貨／物流進度才接受。所有數量由交易內最新來源與 Reservation Core 決定，不接受呼叫者提供角色或庫存。公司／各倉差額守恆，實貨不變，原預留位置不擅自搬移。固定 attemptId 憑證綁定原 UID／角色與意圖；相同操作回覆原結果，不重新寫入，即使原單後續取消也不把成功交易重做。新 attempt 重新規劃並核對來源同步，不能重複預留。此能力無 Callable 或 UI，僅 demo-yushin Emulator；完整履約尚未啟用。

## v2 倉庫寄出與客戶送達分離（2026-10-17，僅 Emulator）

倉庫分批寄出以 warehouseShipmentRecords 保存指定倉與批次，扣實貨及該倉預留；不新增客戶 deliveryRecords、不增加 deliveredQty、不把 isDelivered 設為完成。warehouseShipmentState 沿用 dispatchState 的準備量預算演算法，但消耗量來自 warehouseShippedQty。原客戶交付流程未切換，兩種事件目前禁止混用；後續簽收必須確認已寄出量且不得再次扣庫存。三個倉庫操作角色可以提交，sales／engineer 禁止；同 ID、同身分同意圖重送不重扣。無批次或打單不足、來源／收件快照變更、異常帳、201 批次或退貨／保管／調撥進度均拒絕。

## v2 客戶送達確認（2026-10-17，僅 Emulator）

倉庫寄出才扣庫存；客戶送達依 shipmentId 確認，與真實扣帳 movement 核對。單筆出貨的累計確認不得超額，不能借用另一筆出貨；確認日期不得早於寄出日期。確認不再讀寫庫存／預留／批次或建立 movement。admin 可代辦、sales／engineer 限本人訂單、purchaser／warehouse 不可代辦。原 ID／原意圖重送只回傳原結果；不同 ID 仍受交易內最新剩餘額度限制。兩個 Service 共用 projectShipmentDelivery，允許部分送達與後續寄送交錯；全部寄出不代表全部送達。未開放 legacy事件混用、退貨／補送與UI入口。

## v2 更正送達與退貨追溯（2026-10-17，僅 Emulator）

送達撤銷不等於實物退貨：只移除誤登送達、保存原紀錄／原因／操作者／獨立操作ID並更新送達投影，不加庫存、批次或預留。全數送達後撤銷只回到已寄出待確認，不能再寄一次。原確認與撤銷ID不可跨動作或撤銷後重用；重送只能確認原結果，不覆蓋後來的新確認。退貨追溯必須明確指定原shipment內的實際lotId／qty，不能從部分送達猜批次；數量受單批出貨及該shipment已確認量雙重上限。只產生原倉／原批次的read-only預覽，尚未提交真正退貨、補送或結案。

### v2原倉實物退貨（2026-10-17，Emulator）
`commitLocationReturn` 僅接受原出貨倉的 RESTOCKABLE 明確批次，總量扣除先前實際退貨後不得超該 shipment 已送達量。權限維持 admin／本人 sales／engineer。CLOSE 增自由實貨、不再補送；REPLACE 同時恢復原倉預留與需求，其他倉既有預留不動。寄出／送達歷史保留，由共同 return projection 計算有效履約。補送再打單／出貨／送達閉環、破損及跨倉退回尚未完成，現有入口遇到退貨仍擋下；詳見 `location-return-receipt-emulator-20261017.md`。

### 訂錯商品的預設處理（2026-10-17）
退貨實收後結案（CLOSE），可銷售品依實際處置入自由庫存，不自動恢復原訂單補送預留。需買正確商品時走一般新訂單，重新選商品／確認數量價格，僅保留原退貨來源關聯；不繼承已收款／已開票狀態。未實收的退貨申請不能作為新入口來源。例外免費補送不是主要流程，既有明確 REPLACE 與舊資料不自動改寫；退款、折讓或抵用獨立處理。

### v2 打單與寄出的時間點（2026-10-17）

- `commitLocationDispatchPreparation`（Emulator-only）以目前的單品項預留、累計寄出及已打單量呼叫權威 `warehouseShipmentState`，只增加 `dispatchPreparedQty` 並建立相同交易的 `dispatchRecords` 憑證。不能重複打單超過待打單額度，不能以已寄出卻尚未送達的量重印同一次出貨。錯誤來源同步、退貨／REPLACE、倉位預留總和錯誤、非法角色與取消單皆拒絕；不同操作 ID 併發仍由同一訂單 Firestore Transaction 序列化。
- `commitLocationShipment` 仍是唯一 v2 寄出扣帳者；`commitShipmentDelivery` 只確認送達。現在 Emulator 的 v2 寄送測試使用真正打單 Service 取代原本直接覆寫 `dispatchPreparedQty` 的測試捷徑；首次預留完成 checkpoint 尚未真正接到整體訂單生命週期。
- 此路徑不表示既有前端打單頁／`dispatchRecords` 查詢及 Rules 已能支援 v2；不得將僅 Emulator 的後端記為上線。

### 單品項 v2 初始取消與恢復（2026-10-17，Emulator-only）

僅允許尚無供應、收貨、打單、寄送、送達及退貨歷史，並且沒有 `procurementDemands` 來源文件的單品項雙倉預留。取消一次釋放 v2 `locations` 全部原預留，保留產品、來源識別及兩個候選倉，訂單狀態／公司 reserved／兩倉 reserved／明細／movement／receipt 原子提交；不扣或新增 `onHand`。恢復根據交易當下的公司與各倉實際自由庫存**重新規劃**，別單占用或倉庫停用不得偷挪，缺口保留為 shortage，採購在途不能當作實貨。固定 operationId 驗證原意圖與 UID／角色並返回原結果，不能重複釋放或重新預留。已有打單、履約、採購需求、供應及歷史更正的完整取消／恢復仍由現行既有 Service 負責，v2 尚未接線，不得用本試點繞過其他程序。

### v2 初始取消時的採購需求（2026-10-17，Emulator-only 修訂）

原先 v2 無採購需求試點擴充為**允許已建立但未下任何供應商訂單的採購需求**。採購需求以與既有應用程式一致的 URI 編碼來源 ID 讀取。取消同步改為 `CANCELLED`、`remainingToOrderQty=0`，不刪除歷史 `requestedQty`；恢復按當下實貨及已預留數量經 Workflow + Procurement Demand 核心計算剩餘採購需求，既有文件恢復為 PENDING，不存在但有缺口時新增。真實供應商訂購／收貨、權限身份錯誤、需求來源／庫存位置不一致或陳舊需求狀態時禁止此路徑，不能以沒有打單為理由取消供應商義務。A/B 兩倉預留、公司保留、訂單狀態與採購需求在同一交易；不修改實貨。這尚未提供正式網站使用。

### 部分交付後取消剩餘需求（2026-10-17，Emulator-only）

更新初始 v2 取消限制：訂購 10、已寄出且確認送達 2、剩餘未打單 8，可取消剩餘預留 8；不得沖回已出貨實貨或清除送達歷史。恢復目標為未交付 8，再按當下自由實貨分配，缺口透過相同採購需求核心計算，不得重新預留完整 10。已打單量須等於累計出貨量，所有已出貨量須已確認送達；若有途中貨、退貨、供應商採購／收貨、全部交付或錯誤出貨憑證則拒絕。允許同步從未向供應商下單的既有需求；需求取消保留歷史量。此為既有內部 Service 的擴充，尚未開放正式操作。

### 客戶取消與供應商承諾（2026-10-17，v2 Emulator 接續）

客戶訂購 10、實貨預留 7、供應商已訂 3 未到貨：客戶取消只釋放預留 7 並停止追加採購；供應商訂單仍有效，採購需求雖標記 CANCELLED，orderedQty 與 remainingToReceiveQty=3 仍保留，公司／分倉 incoming 不變。恢復時既有供應承諾涵蓋 3，最多再預留現貨 7，不可同時預留完整 10。若採購另依供應商答覆取消該供應，使用原 `cancelOutstandingSupplyRecord` 更新供應／需求／訂單承諾／在途；再恢復客戶訂單時依最新實貨及未取消承諾重算缺口，絕不重開原已取消 supply。

本批僅支援尚無任何實際收貨、退貨、途中送貨及剩餘打單的雙倉單品項。承諾與來源憑證不一致、PO 停止但 supply 尚有效、incoming 帳不足或超過 50 筆供應時原子拒絕。已收貨後的分倉入庫／再配置及供應商答覆操作的完整 v2 前端仍未驗收；供應商不同意取消的 KEEP_STOCK 決策不得由客戶取消自動代填。

### 雙倉來源的實際收貨（2026-10-17，Emulator-only）

例：訂購 10，A 預留 4、B 預留 3、供應採購 3；A 實收 1 後，只有 A 變為 5、B 保持 3，公司實貨／預留加 1、採購 incoming 減 1，缺口由 3 變 2；再收 2，預留合計 10、缺口 0。收貨、打單、出貨與送達仍是不同事件，收貨不得寫送達紀錄。若客戶已取消，採購必須先選原有「供應商不同意取消，到貨轉庫存」；實收只增加自由庫存並更新收到的供應摘要，不能重啟已釋放的預留。

任何來源訂單（含取消中）缺少原 reservation 時拒絕收貨，不再以缺帳推定可自由入庫。v2 另核對公司與其他預留倉的完整帳目、來源需求／PO、真實收貨角色；停用收貨倉、混合位置版本、錯誤帳目、超收、重複 ID 變更意圖均拒絕或整筆回滾。既有 v1／直送正常流程保留。此為 Emulator 試點；來源已出貨／退貨、已收貨後的 v2 生命週期與完整 Preview 尚未完成。

### 部分／全部收貨後取消及恢復（2026-10-17，Emulator-only）

本節取代 v2 取消／恢復對所有已收貨訂單的阻擋。例：原預留 7、採購 3，已收 1 後實貨／預留 8、在途 2。客戶取消釋放預留 8，實貨 8 與在途 2 不變；恢復最多再預留 8，另由在途 2 涵蓋，不重採購或把實貨扣回。若已全部收 3，取消／恢復不新增 incoming 或採購需求。若採購另取消未到貨 2，保留已收 1 的歷史；恢復只有當下缺口需要重新採購，不復活原已停止的供應。

恢復的權威在途是有效 supplier orderedQty 減累計 receivedQty；當原實貨已被其他訂單占用，仍按當下自由實貨重規劃。取消中經 KEEP_STOCK 實收的貨也可恢復，不能把已收到的部分繼續算為在途。所有正量收貨須可追溯至原 v2 receipt／入庫 movement／lot，收貨憑證不能重用同一入庫批次，逐供應 cumulativeReceivedQty 必須連續且等於供應／訂單／需求摘要。

### 部分出貨後的採購與收貨（2026-10-17）

單品項 v2 倉出貨的缺口＝訂購量－已實際寄出量－仍持有的預留。客戶尚未確認送達的途中貨已離倉，不得再次預留，也不得產生採購需求；客戶送達狀態仍只由確認紀錄決定。再次收貨只補尚未寄出缺口，其餘依原自由庫存流程；累計收貨、供應進度及在途量維持原權威。

收貨交易須核對每筆原始出貨的實際 inventoryMovements 扣帳與批次配置；缺失、竄改、來源不符或出貨／送達快取不一致均拒絕整筆。退貨後收貨仍不在此試點範圍；途中貨取消限制不因本次解除。只完成 Emulator 內部交易，完整 UI／Preview 尚待驗收。

### v2 自由庫存跨訂單分配（2026-10-18，Emulator-only）

指定有效的另一張單品項 v2 缺貨訂單，使用既有 Reservation Core 的 `planReservationReceipt(addsStock:false)`：只增加指定倉及公司 reserved、減少該訂單 shortageQty，不改實貨或其他倉預留。交易內拒絕取消／進度不符、服務品項、採購或送貨已啟動、供應紀錄存在、需求投影不符及超額分配。採購需求 `procurementDemands` 與預留同交易更新；操作 movement 為冪等憑證，已無缺口或自由實貨時不做無效寫入。此為 Emulator 指定目標交易，**不是完整 FIFO 自動分配或前端已開放**；不能以本試點替代已上線的單倉分配。

### 自由庫存 FIFO 協調與進度（2026-10-18，Emulator-only）

單品項雙倉指定位置釋出後，既有 `advanceAutomaticFreeStockAllocation` 依 Reservation Core 的日期／訂單／品項優先順序選擇下一張有效 v2 缺貨訂單；每呼叫只套用最多一筆既有自由庫存交易，絕不在掃描階段改帳。真正分配仍由 `planReservationReceipt(addsStock:false)` 決定，不把在途當實貨。缺貨 candidate 的 productKey/status 查詢每狀態不超過 50 筆，否則拒絕以免錯誤宣稱全域 FIFO。source order／品項／同步與權限在實際提交再交易內重讀。

batch checkpoint 儲存在既有 `reservationOperationReceipts`，紀錄固定 runId、actor／hash、maxQty、累計 allocatedQty、pending 及 processedSteps；對來源訂單的單筆 movement 固定 operationId，已提交未更新 checkpoint 時可重送並只累加一次。各筆是獨立原子交易、整批可恢復但**非跨訂單原子化**。多倉自動觸發、50 筆以上分頁、已採購混合、完整前端接線與 Preview 尚未完成。

### 多倉 FIFO 分頁與日期（2026-10-18，Emulator-only）

v2 初始 Ledger 優先順序日期必須來自交易內讀取的來源訂單（orderDate/date/createdAt，格式有效才保存），不是由頁面自由輸入。自由庫存協調器以共同 `compareReservationPriority` 對 active/shortage 候選進行完整有界掃描，每頁 50 筆、每次最多 500 筆；超過安全上限不得分配，以免 FIFO 遺漏較舊訂單。沒有可用日期的既有 ledger 沿用目前 Core fallback 排序，屬歷史限制而非已完成訂單日回補。每個分配 transaction 仍須驗證來源與實際庫存，不能使用查詢結果直接寫帳。

### v2 庫存釋放後的可恢復配貨觸發來源（2026-10-18，Emulator-only）

取消訂單釋放已預留實貨，或可再入庫的 CLOSE 退貨讓實貨變成自由庫存時，必須由來源交易內的同一 movement 保存實際已釋放數量。恢復預留及 REPLACE 補送不是自由庫存，不能發布釋放訊號。物流角色可用來源 movement 取得固定 batch ID 並繼續既有 FIFO 協調器；權限、來源交易憑證與當前物理庫存仍需再次檢查，重複操作不可重複扣帳。未建立背景自動執行、原廠／採購到貨接線、超過試點批次規模及正式端到端驗收。

### v2 收貨後剩餘自由實貨的再分配來源（2026-10-18）

收貨原子交易已先入庫，僅 `receipts.autoAllocationQty>0` 且 `reservationLocationSchemaVersion===2`，有一致的原 receipt movement 與 inventoryLot 物理憑證時，才可作為 v2 缺貨再分配來源；同一訂單正常收貨先供來源預留的數量不能再次配給別人。來源訂單已取消時，該供應需有已核定 `KEEP_STOCK` 決策，禁止因客戶取消便虛構收到實貨。批次進度使用 receipt 原 movementId 的固定雜湊，重新呼叫同一來源不重複扣帳。此為 Emulator 內部可呼叫流程，尚非正式網站自動通知／配貨。

### 訂單取消／CLOSE 退貨後段配貨的執行界線（2026-10-18，Emulator-only）

來源訂單取消或真實可再上架的 CLOSE 退貨**先由原交易獨立完成**；後續調撥其他缺貨訂單必須在來源 transaction 完成後、重新驗證目前操作者的 admin/purchaser/warehouse 權限，才可經原自由庫存 Service 推進。業務可合法處理自己訂單的取消或退貨，但不能因此取得倉儲分配權。新增內部組合 API 對後續配貨失敗標記 recovery-pending 並保存來源 movementID，絕不能重複取消或退貨以掩蓋配貨失敗；同一來源 ID 重送只續跑原批次。單次最多 10 步、正常預設 5 步，有未完訂單持續以同 ID 續傳，不建立無界背景工作。正式觸發、身份安全接班與 Preview 驗收仍未完成。


### v2 自由庫存配貨進度完整性（2026-10-18）

已實作：既有 `advanceAutomaticFreeStockAllocation` 的每次 checkpoint 交易讀取（包含已完成重送及扣帳後結算）均經 `validateAutomaticFreeStockCheckpoint`。累計分配須為 0 至原 maxQty 的整數，步數為 0–1000；完成必須沒有 pending、具已知完成原因，quantity-reached 必須實際達到原額度。pending 必須具有完整且僅限既定欄位、正整數且不超過剩餘額度，操作 ID 必須依原 runId／步數／訂單／品項衍生。達 1000 步不可建立新指令。異常進度先拒絕，不自動改成完成、重設操作 ID 或推估已扣帳量。

沿用原 checkpoint、movement 與唯一自由庫存 writer；交易已提交但 checkpoint 結算失敗時，修復正確進度後仍以原指令重送，原 movement 確保不重複預留。不變更角色、Collection、Rules、Index、前端或 Callable，仍僅 demo-yushin Emulator。新增 Emulator 案例涵蓋完成憑證異常、pending 篡改與額度超限、扣帳後再讀進度異常及原 ID 續傳；實際執行結果以本批 PR CI 為準。完整 Preview、不同操作者安全交接及正式部署仍未完成。


### v2 配貨自動換人續傳（2026-10-18）

配貨批次續傳不再永久綁定第一位物流操作者。當前有效 admin／purchaser／warehouse 使用相同批次／來源事件續跑時，自動核對與接手；sales／engineer 沒有因此取得配貨權，原操作者停用也不阻止其他合格人員續作。無須新增日常手動交接步驟。

已完成部分只能按真實原 movement 結算，剩餘額度不重設；原 movement 操作者不得改寫。交接原子記錄前後操作者及必要的補結算量。舊程序在庫存 transaction 內若已非現任操作者，必須拒絕；兩人同時續跑仍受同一批次及固定操作 ID 約束。新操作者於真正扣帳時仍須有效且具原本配貨角色。此能力目前僅 Emulator，正式頁面與 Preview 尚未啟用。


### CLOSE 退貨後的剩餘履約（2026-10-18，Emulator-only）

本節取代先前「有任何退貨即不能繼續履約」的 CLOSE 限制。訂購 10、已出貨／送達 4、CLOSE 退回 1 後，剩餘 6 仍可用原 Service 打單、指定倉出貨及確認送達，累計出貨最多仍為 10，不增加為 11；該退回 1 已結案、成為自由實貨，不重新預留給原單。原退貨紀錄與累計送達保留，全部完成時沿共同投影判定。REPLACE 或混合 REPLACE 不在本次範圍。

同一批分次送達，可在先送達 2 件後先 CLOSE 退回 1，之後確認該批剩餘已寄出部分；不能因較晚確認而否定合法舊退貨。共同 `projectShipmentReturns` 改依日期排序退貨，累計退貨不得超過退貨當天（含當天）已確認送達量，不得借未來的送達回填早先退貨。

打單、出貨與送達每次新交易均核對真實退貨入庫 movement 與完整快取，刪除 returnRecords／歸零 returnedQty 不能隱藏實際入庫。重送沿原固定 ID，權限／實貨／預留／批次交易沿原邊界。功能僅 demo-yushin Emulator；正式前端與 Preview 全流程尚未啟用。


### CLOSE 退貨後的取消／恢復（2026-10-18，Emulator-only）

本節解除 CLOSE 退貨後取消／恢復的限制。訂購 10、已交付 4、CLOSE 退回 1 時，剩餘需求為 6；取消只釋放剩餘預留，不沖回已交付或退貨實貨。恢復以共同退貨投影的 outstandingQty 及真實供應在途規劃，不能把已結案的 1 件額外加回需求，不能重建整張 10 件的預留。

恢復會依當下可用庫存重新分倉，不承諾回到原配置。合法自由實貨可供應剩餘需求，包含已退回且可再入庫的貨品，但總量仍受剩餘需求／真實在途限制。取消期間若自由庫存已由別單取得，缺口以共同需求 Core 建立或恢復；不得挪用別單預留。實體數量、批次、退貨、累計寄出／送達、採購單及收貨憑證皆保留。

仍限已寄出全數確認、無額外已打單未出貨的單品項雙倉；REPLACE、混合補送、全數完成、取消中新增退貨及正式接線尚不在本批範圍。角色仍為 admin 或本人 sales／engineer，採購／倉管不能藉此取消或恢復商業訂單。


### CLOSE 結案退貨後收貨（2026-10-18，Emulator-only）

CLOSE 僅結清先前交付的退貨量，不增加原單補送需求；原單剩餘 PO 可繼續分次收貨。例 qty10、採購3、先收1、寄出並確認1、CLOSE退1，後續收2後累計收3、剩餘預留9、採購在途0；結案退貨作為自由實貨，不自動新增第11件出貨。其餘已寄出但尚未確認的量也不能被收貨再次預留。

先取消再收貨須由原採購保留採購轉庫存決策核准；取消狀態預留維持0，恢復只覆蓋尚未寄出需求，可依現有 Core 使用合法自由實貨。退貨、出貨、送達歷史原樣保留。交易內核對所有退貨憑證與快取，缺漏、變造、隱藏或 REPLACE／混合退貨拒絕，不得只清 returnedQty 繞過。此為內部 Emulator 能力，正式前端與 Preview 尚未開放。


### 取消中的 CLOSE 實物退貨（2026-10-18，Emulator-only）

取消訂單後，可把先前已確認送達的可再入庫商品退回原出貨倉，決策只允許 CLOSE。退回實物增加原批次、公司與原倉實貨；取消狀態與零預留／零缺口維持，不重新占回原單。例10件已寄出並送達4、取消剩餘6、再退1，恢復時需求仍為6，不因退回的已結案商品增加成7。合法自由實貨可依原預留規則用於剩餘需求或其他正常訂單。

必須保留原出貨／送達／退貨紀錄、累計交付與供應／PO／receipt／成本連結。取消來源須已完整釋放且無途中貨、額外打單或退貨更正，狀態投影不一致或憑證缺失一律整筆拒絕。admin／本人sales或engineer可決策退貨；倉管與採購不能因能收採購貨而代做客戶退貨。固定操作重送只回原結果，新增異動重新讀取當前狀態與角色。


### 取消後退貨可先查核剩餘批次（2026-10-18，Emulator-only）

取消後，admin／本人sales或engineer／purchaser／warehouse可唯讀查核原出貨批次及剩餘退貨額度；實際退貨決策權仍只有原商業角色。正常或取消來源已退過CLOSE的量，須依實際不可變入庫憑證扣除，不能清除訂單快取再取得額度，也不能拿別筆出貨的額度混用。

剩餘可退總量等於該shipment已確認送達減先前實際退貨；各批次上限等於原出貨批次減該批已退。混合包裹部分送達不能推定哪批已交付，仍須明確選批且同時受總量及單批限制。查核不預留、不入庫，不保證後續數量不變；提交時重新驗證。REPLACE／混合補送及取消狀態不一致、未釋放預留、途中貨／額外打單／更正歷史均拒絕此取消查核。


### 退貨登入身分與即時權限（2026-10-18，Emulator-only）

退貨Callable測試只接受Firebase驗證的登入UID，不能從payload指定他人UID／actorRole／auth。五角色維持原唯讀查核權限；實際客戶退貨仍只admin或本人sales／engineer。角色與active以交易內users文件為準，即使token已發出或自訂claim寫admin，現行倉管角色仍不能決策客戶退貨；降權／停用後連已完成操作的重送也需重新通過授權。

未登入、無效token、只有Auth帳號卻沒有有效users profile、非本人業務及來源同步已換attempt皆拒絕。固定ID相同意圖與身份重送只回原結果；改意圖或換人挪用原操作ID拒絕，同時重送不得重複入庫。上述由隔離demo Emulator驗證，尚未對正式使用者提供新入口。


### 初始化完成必須等待實際預留與需求同步（2026-10-18，Emulator-only）

退貨走單測試不再自行標記庫存同步完成，改用既有同步流程：啟動attempt、原雙倉預留、原採購需求同步、再完成來源checkpoint。例10件、可用7件，完成後預留7／缺口3、正式採購需求3；完成前後狀態均由原來源同步交易產生。

若預留已提交但需求同步尚未完成即中斷，來源維持failed／pending，後續物流及生命週期不能視為可用；原操作人重試以新attempt完成需求，不再占一次7件。舊工作晚回覆不能覆蓋新工作；完成回覆遺失須讀回真正completed結果，切換帳號不能代原帳號完成。既有角色／所有權與active檢查保持，不新增正式權限。


### 2026-10-18 實際打單入口續傳整合

打單只建立作業憑證並增加確認的打單累計，不扣實貨或確認送達。相同操作重試不包含後到貨；不同操作競爭同一打單基準時須重新確認。 詳見 [介面交易對照與驗收邊界](transaction-ui-integration-20261018.md)。已實作、待本批 CI；未部署 Firebase，單品項多位置仍未啟用正式介面。


### 2026-10-18 退貨實收 Service 接線

退貨申請不增實貨；實收 SALEABLE 才回原批次庫存，INSPECTION／DAMAGED 先 HOLD；確認可售後由同一 Service 轉庫存一次。CLOSE 不補送，重新購買仍是一般新訂單。這些既有規則未改，僅整合其 Service 責任與驗收。 驗收項目與限制見 [介面交易對照](transaction-ui-integration-20261018.md)。未部署 Firebase，完整 Preview 全流程尚待驗收。

### 2026-10-18 整單預留優先順序與原子性

整單雙倉試點依交易內來源 items 順序配置，不能用 payload 排序搶先預留；同產品各品項共用實貨額度。原 ledger 合計不可超過公司／分倉原預留。全選 1–5 個初始實體倉品項才可提交；混合服務／直送或有採購／履約進度時整單拒絕，不默默忽略。僅庫存預留階段原子，需求同步完成前仍為 pending。見 [詳細契約](multi-item-location-transaction-20261018.md)；正式介面未啟用。

### 2026-10-18 多品項出貨的商業邊界（待 PR CI）

多品項商品不可互相借用另一個 item 的打單量、持有庫存或批次；同品項也不能挪用未被原預留 ledger 指定的另一倉。公司與各分倉預留須覆蓋整單同商品各 item 的合計聲明。所有歷史出貨 movement 和退貨入庫憑證均須驗證，不能依快取推測庫存或整單交付。一次出貨只降低實貨、預留和批次餘額，**不代表客戶已送達**；各品項與整單有效交付仍由原 Fulfillment Core 統一投影。詳細限制見 [多品項出貨契約](multi-item-shipment-20261018.md)，目前僅 Emulator 試點。

### 2026-10-19 多品項送達與整單完成定義（待 CI 驗收）

每筆送達必須關聯真實且有扣帳憑證的原出貨，確認多少件只增加被選中品項的累積 deliveredQty；不動任何實貨、批次與預留。整單 deliveredQty 必須是權威 Core 算出的各品項合計，整單 isDelivered 只能在所有品項均符合交付完成時設為 true，不能因單一商品已送達便完成訂單。交易重試、權限和完整歷史證據核對參照 [多品項送達規範](multi-item-delivery-20261019.md)。正式網站尚未開放。


### 2026-10-19 多品項送達撤銷（已實作、待本批 CI）

誤登送達的撤銷只更正客戶確認，不能還原實貨或新增可寄出量。多品項僅正常、初始化完成、全單無退貨；退貨後更正仍拒絕。 僅 demo-yushin Emulator；未接正式 UI／Callable、未部署 Firebase，完整 Preview 仍未驗收。詳見 [同一份送達契約與驗收範圍](multi-item-delivery-20261019.md)。


### 2026-10-19 多品項履約後收貨（已實作、待本批 CI）

多品項收貨可在打單、部分出貨／確認或送達撤銷後繼續，只為未出貨的需求新增預留，不能把途中貨再次視為缺貨。整單無退貨、正常且初始化完成，取消／退貨後收貨仍未開放。 限 demo-yushin Emulator，未接正式 UI／Callable 或部署；詳見 [原收貨契約增補](multi-item-receiving-20261018.md)。


### 2026-10-19 多品項整單取消／恢復（已實作、待本批 CI）

整單取消僅關閉剩餘未寄出需求與釋放原預留，保留客戶已收貨與所有採購/實收事實；恢復仍扣除供應在途覆蓋，不能製造虛擬實貨。途中貨、額外打單、多品項退貨與全單已履約仍拒絕。 仍限 demo-yushin Emulator，正式 UI／Callable 未開啟，無部署。詳見 [同一份 lifecycle 契約增補](location-lifecycle-20261017.md)。

### 2026-10-19 多品項 CLOSE 退貨（已實作、待本批 CI）

正常多品項可按原出貨與明確批次分次退回原倉；CLOSE不增加原單補送需求，訂錯貨需要正確品項時另建一般訂單。原交付及其他品項保留，整單退貨與完成狀態由原Core彙總。取消中、多品項REPLACE及跨倉仍未開放。見 [原退貨契約增補](location-return-receipt-emulator-20261017.md)。


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

### 原介面撤銷客戶送達確認（2026-10-20，本機試點）

撤銷誤登簽收僅更正客戶收到的確認，貨仍維持已寄出；不回補實貨、不還原預留、打單或原批次。已有實物退貨仍不能撤銷。未知結果須先以固定操作核對，不可先新增另一個確認／撤銷；原後端交易負責最終權限與數量，UI 不另算。僅 demo-yushin 本機 Emulator 接線，正式／Preview 尚未啟用。

### v2 整單取消／恢復登入傳輸（2026-10-20，本機試點）

沿原整單生命週期取消未出貨需求、恢復時按當下實貨／在途配置；已送達、CLOSE 退貨及實貨批次歷史保留。登入傳輸不改變原規則。業務／工程師無物流配貨權限時，取消仍可成功，釋放來源保留待配貨；不能回報取消失敗、冒用物流身分或另建取消 ID。新 Callable 只在隔離 Emulator，原操作介面尚未接線。

本機原取消／恢復介面現以獨立旗標接上述原 Service；舊單、缺完整原候選倉或跨品項候選倉不一致安全拒絕。表單不能藉相同狀態另做日期／原因更正；前次結果未知須先核對固定原意圖，不能改狀態或換 ID。成功回讀訂單與原 history 後才更新畫面；配貨待處理顯示「取消已完成」，不視為取消失敗。正式／Preview 未啟用。

本機原庫存分配面板可列出取消釋放的待配貨來源。只有當前 admin／purchaser／warehouse 可讀取與接續；業務／工程師的取消成功不因此取得配貨權限。開頁及讀取更多只查進度；按原列才沿原來源與協調器配貨，每次至多五步，尚未完成留在原列。回覆遺失與跨物流操作者接手都使用相同來源及原批次。完成重送只核對，不重複預留；實貨、原取消及履約歷史不重寫。列表的「釋放／已分配」是原來源額度與批次進度，不宣稱為目前可用實貨。

瀏覽器驗收應涵蓋業務實際登入後取消、提交成功但 HTTP 回覆遺失、重開保留同一取消意圖、業務無權讀配貨來源、倉管實際登入接手並保留五步進度、再由採購實際登入接續同批次，以及最後只增加其他缺貨單預留、不增加實貨。此驗收使用隔離 demo Emulator，不代表 Preview 或正式操作完成。

Browser 發現的區域 SDK 入口修正只恢復既定後端連線方式，不放寬試點環境、角色、所有權、來源或數量限制；既有取消／配貨與其他履約數量計算不變。


## 正式採購多品項後端擴充（2026-10-20）

隔離正式採購一次限 1–5 個不同的 `(orderId,itemId)`；同來源重複列安全拒絕，須由未來介面契約先合併。每列由交易內最新來源／需求決定可採購量，任一列不合法則整張 PO、Supply、Demand、來源訂單均不提交。同張訂單買齊某列，不可移除其他未購列的 ordering 工作分類。單列陣列與既有單列請求具有相同冪等指紋；多列順序決定 supply ID，重排視為不同意圖並拒絕同號重用。

原按鈕後端試點只接客戶訂單實體入庫採購；手動備庫、直送與服務品項不得悄悄降級舊交易。採購金額與搜尋投影沿單一 Supplier Core，前後端共用；文件 metadata 不能傳入角色、任意總額或庫存結果。後端沿既有交易驗證數量，不將供應承諾視為在途或實貨；在途仍由原 `registerPurchaseIncoming` 獨立冪等同步。


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

同一張採購 4 件的 PO 以兩次各 2 件完成，收齊只代表該 PO 已收 4 件，不代表原訂單 12 件全部足額；原 7 件缺口仍有 3 件未採購。第二次收貨應將 incoming 歸零、累計 receivedQty=4、來源 reservedQty=9／shortageQty=3。打單 9 件不扣實貨；來源倉分批寄出 2+2 件後預留剩 5 件、缺口仍 3 件，客戶 deliveredQty 仍為 0，不得將實體寄出當作送達。

本批本機語法與建置一致性檢查已通過；真 Auth、Chrome 及全套 Emulator／Rules 的執行結果以本批 PR 最新 CI 為準。未部署 Firebase，未修改正式資料。


### 同 PO 出貨後分批送達與不重扣驗收（2026-10-21，待 CI）

倉庫兩次各寄出 2 件後，客戶可先收到第一批 1 件，再收到第一批剩餘 1 件，最後收到第二批 2 件。三筆送達分別關聯原出貨，不再扣實貨／預留／批次。全數已寄出的 4 件收到，不等於原 12 件訂單完成：reservedQty=5、shortageQty=3、dispatchPreparedQty=9、warehouseShippedQty=4，isDelivered 仍 false。已確認的來源出貨不能重複登記超額送達。

本機建置一致性與語法檢查已通過；完整真 Auth／Chrome／Emulator／Rules 結果以本批 PR 最新 CI 為準。未部署 Firebase，未修改正式資料。
