# 又鑫公司系統 V2 升級計畫

基準：main @ 7cf91049ac3dee5b24b9560241d941f24e648c6e
開發線：upgrade/v2-fulfillment-20260920

## 不可變更
- GitHub main 為正式來源；先在 preview/upgrade branch 驗證。
- 估價單單號沿用目前機制，不修改。
- 手機與桌機同一套系統。
- 儀器系統維持目前架構，只做權限/效能相容。
- 重要資料採作廢/停用/軟刪除。
- 新功能不得靠一次讀取全部歷史資料完成。

## 角色
- admin：全部資料、角色視角、管理與分析。
- sales：Forecast、估價、訂單、自行訂貨、產品/售價/庫存查詢。
- engineer：商務能力 + 工程能力；可有自己的 salesCode、Forecast、估價、訂單、自行訂貨與業績，另有儀器/保養/維修。
- purchaser：看全公司採購需求、正式 PO、打單；可協助建立估價/訂單但必須指定 responsible sales。
- warehouse：收貨、Lot/Expiry、庫存調整。

## 核心資料原則
Order Item + Quantity 是最小履約單位。
每個 item 應能表達：
orderedQty, reservedQty, supplyOrderedQty, receivedQty, dispatchPreparedQty, deliveredQty, returnedQty, shortageQty。
狀態盡量由數量推導，不依賴整張 order boolean。

## 核心流程
1. Forecast（sales/engineer 自己；admin 看全部）
2. Quote（多角色可協助建立；operator 與 responsible sales 分離）
3. Order（估價轉單/手動/複製都建立同一多品項模型）
4. 建單先 reserve 可用庫存，不減 onHand。
5. shortage 選 purchaser ordering 或 sales/engineer self-order。
6. 訂貨記錄支援 PURCHASING_PO / SALES_SELF_ORDER / STOCK_REPLENISHMENT。
7. Receipt 支援部分到貨，建立獨立成本 Inventory Lot；自動補 customer reservation。
8. 有 reservation 的數量進 purchaser「待打單」。
9. purchaser 在既有出貨系統打單後按「已打單」；該 qty 才成為 sales/engineer「可出貨」。
10. 實際送貨才 onHand -= qty 且 reserved -= qty。
11. 已報帳可 未報帳 <-> 已報帳 自由切換，每次留 audit log。

## 庫存與成本
- Available = On Hand - Reserved。
- 每次 Receipt 是獨立成本事件，不使用 moving average。
- 有 expiry 用 FEFO；無 expiry 用 FIFO。
- Delivery 保存 lot allocations，COGS 依實際消耗批次。
- Product Master cost 是最新/參考成本，不是歷史實際 COGS。
- Stock replenishment 無 customer order，收貨只增加庫存，不產生待打單。

## 產品查詢與價格表
商務角色可快速搜尋貨號/品名/廠牌/關鍵字並看到：售價參考、On Hand、Reserved、Available。
不得為搜尋先下載整份價格表。
價格表由負責產品線的 sales/engineer 維護；上傳 Excel 必須先分析/預覽差異，再確認寫入。
價格歷史保留；Quote/Order Item 保存建立時 snapshot，後續 Product Master 更新不得改歷史交易。
成本權限必須由資料層控制，不能只靠 CSS 隱藏。

## Admin
Dashboard action cards：待訂貨、待入庫、待打單、可出貨、已送貨未報帳、異常。
進銷存分析 admin only；可切換隱藏成本/毛利。銷售認列以實際送貨日期。
低庫存以 Available < Safety Stock。

## 效能與 UX Gate
- 一般按鈕按下立即 optimistic/loading 回饋並防重複點擊。
- 特殊長任務（價格表、批量庫存、migration、報表）必須顯示 loading；可計算時顯示進度百分比/筆數/階段。
- Loading 不可掩蓋不合理慢查詢。
- 列表 pagination；搜尋 server/index based；禁止全歷史 get 後前端篩選。
- Dashboard 使用 bounded queries/summary，不掃描全部歷史。
- Desktop + iPhone 都需驗收。

## 執行批次
A Phase 1-7：Order item/qty、Reservation、Supply、Purchasing workbench、Receipt、Lot cost、Dispatch/Delivery/Billing。
B Phase 8-11：手動多品項、產品快速搜尋、Product Master/價格表、成本權限。
C Phase 12-14：人員管理、能力型角色、估價權限。
D Phase 15-17：Dashboard、進銷存、安全庫存。
E Phase 18-21：效能總檢、Rules/Indexes、Migration、完整驗收。
