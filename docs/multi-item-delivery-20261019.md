# 多品項出貨後獨立送達確認與撤銷（v2 Emulator 試點）

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

仍未完成：退貨後的多品項送達撤銷、多品項退貨 receipt writer、多品項履約後收貨／取消與恢復、完整 Auth Browser/Preview E2E；因此**正式系統 v2 仍維持停用**，沒有對外部署。


## 多品項送達撤銷（基準 main 6d7c930d／PR #175）

已實作、待本批 CI：原 `reverseShipmentDelivery` 共用原多品項來源驗證與 `projectOrderShipmentReturns`。確認／撤銷共用同一個整單出貨憑證 reader，最多 40 筆；撤銷再以原 `readLocationReturnProofs` 驗證沒有隱藏的入庫憑證。只允許 2–5 個正常實體倉品項、completed 初始化且整單沒有退貨；已有 CLOSE／REPLACE 退貨或取消來源仍拒絕。這不是新增退貨更正規則。

撤銷必須指定原 deliveryRecordId，核對品項、商品、原送達 intent hash 與原實際出貨。交易只移除該筆送達、附加原完整 before／actor／reason／intentHash／result 歷史、更新選中 item.deliveredQty 與整單合計；其他品項與全部實貨／預留／批次／出貨憑證保留。撤銷使整單重新待送達；不能再次寄出相同貨品。重新確認需新 ID，原確認 ID 不能復活已刪除紀錄；原撤銷 ID 重試只回歷史結果，不覆蓋後來新確認的數量。角色仍為即時 admin／本人 sales 或 engineer。

無新 Collection、持久欄位、Rules、Index、Listener 或資料遷移。首次多品項撤銷有 4＋S 次 transaction.get 呼叫：users、orders、一次既有退貨 proof query、S 個整單出貨 movement，再核對選定出貨一次（S≤40）；只寫 orders 一份。重送仍只讀 users／orders，驗證當前角色後回原 result；不重新執行撤銷。

新增九項真實 Emulator 案例，涵蓋三／五品項（含同商品不同列）、五角色與停用／所有權、回覆遺失與固定 ID／意圖／actor／角色綁定、同／不同 ID 競爭、不同品項並行撤銷與確認、損壞 sibling 出貨憑證／隱藏退貨／偽造原意圖、錯來源／日期／同步識別／狀態、真實 CLOSE 退貨拒絕及末端 ALREADY_EXISTS 回滾。既有完整兩品項流程追加全單送達→撤銷第二品項→重新確認→舊撤銷重送的驗收。CLOSE 拒絕案例由原單品項 writer 產生退貨後 seed 獨立 sibling，僅代表 reader 的拒絕驗證。

本地一般 Node 1,557／1,557 通過；本地缺 Java 21／Firestore Emulator 及 Chrome，因此新增真實交易、Rules／Auth／瀏覽器與全部回歸以 PR CI 通過為準。正式 UI／Callable 與 v2 閘門維持停用，完整 Auth Browser／Preview E2E 仍待驗收。
