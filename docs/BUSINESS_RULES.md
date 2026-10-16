# BUSINESS_RULES — 核心交易數量與資料權威

版本：2026-10-15。此文件是目前程式與既有稽核文件的**已實作規則／目標缺口**對照，非正式環境驗收證明。

## 名詞與公式

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
- **一般採購**：建立 PO 與 supply event，增加在途，不增加庫存；部分採購不能讓實際需求重複下單。
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
