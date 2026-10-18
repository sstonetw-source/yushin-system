# 多品項出貨後獨立送達確認（v2 Emulator 試點）

基準 main `7013df0c`（PR #174）。本批延伸**既有** `functions/shipment-delivery-service.js` 的 `commitShipmentDelivery`，沿用權威 `projectOrderShipmentReturns`，不建立第二套交付 writer，也不新增送達量計算公式。正式 Callable、網站 UI、Firestore Rules、部署與真實資料均不變。

## 責任與資料來源

- 真實送達不是出貨。送達確認只能引用已成立且有不可變實際扣帳 movement 的倉庫出貨，**絕不再次扣除公司／分倉庫存、預留或批次**。
- 多品項只允許 2–5 個唯一且來源完整的實體倉商品、正常訂單、已 completed 初始化；混合 SERVICE／DIRECT_SHIP、轉移途中與來源快取錯誤整單拒絕。原單品項送達、送達撤銷及退貨追溯仍使用原契約，未擅自擴張其入口。
- Transaction 先讀真實登入 UID 的目前使用者 profile；原權限為 admin、本人 sales／engineer。重讀整張訂單及所有出貨／送達／退貨事件，以既有整單履約 Core 核對各品項及訂單總數、狀態。
- 整單出貨憑證最多 40 筆，逐一核對 immutable movement 的批次、實際扣帳、source 身分及原意圖 hash；真實退貨入庫仍由原 `readLocationReturnProofs` 核對，CLOSE-only、不得隱藏 sibling 憑證。
- 同一 transaction **只更新選中 item 的 deliveredQty**，保留所有兄弟 items；`orders.deliveryRecords`、`deliveryHistory`、整單 `deliveredQty`、`isDelivered` 由完整投影一次寫回。原單品項結果欄位保持相容；多品項增加 `itemIsDelivered` 便於區分「本項送達」與「整單完成」。
- 固定 operationId 與 actorUid／即時角色／intent hash 綁定；網路重送得到原結果，其他 actor 或篡改量不得冒用。不同品項並行提交時同張 orders document 的 Firestore Transaction 自動重試。

## 驗收與未開放範圍

本批新增九組真正的 Firestore Emulator 測試：分倉分品項累計、全品項完成、部分送達、五角色（實際只允許原三個業務角色）、固定 ID／競態、不同品項同時確認、不可變扣帳損壞與隱藏退貨、無效兄弟投影、送達提交失敗回滾。既有 Node、Rules、Auth/Callable 及 Chrome 回歸由 PR CI 確認。

仍未完成：多品項送達撤銷、多品項退貨 receipt writer、多品項履約後收貨／取消與恢復、完整 Auth Browser/Preview E2E；因此**正式系統 v2 仍維持停用**，沒有對外部署。
