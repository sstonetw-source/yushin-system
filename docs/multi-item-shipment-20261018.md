# 多品項雙倉出貨（v2 內部試點）

基準 main `c347e344`（PR #173）。沿用既有 `commitLocationShipment`，不新增 writer 或第二套 Core。目前僅允許 `demo-yushin` Firestore Emulator，不提供正式 Callable／UI，也未修改 Rules、正式資料或 Firebase 部署。

## 流程與唯一來源

1. 來源訂單須初始化完成、具所有權、1–5 個唯一實體倉商品，且沿用原雙倉；混合服務、直送、停用商品與調撥途中整單拒絕。
2. 使用現有 `projectOrderShipmentReturns` 先驗證整單出貨、送達、退貨事件，再從選定品項的原 `warehouseShipmentState` 計算打單可出貨量。
3. 同一 Transaction 讀取每個品項的 v2 ledger、來源所有權、兩個原候選倉、預留／缺口及公司與各分倉合計。歷史出貨一律核對不可變 inventoryMovement 與原意圖 hash；退貨入庫證明沿用共同讀取器，不能因快取刪除而放行。
4. 真正扣帳仍使用既有 `planReservationIssue`、批次分配與交易，只有選定品項預留、庫存、批次餘量及出貨進度變更；兄弟 items 原樣保留。打單、出貨與送達不可混同。
5. 固定 operationId 綁定真實 UID／角色／意圖，同一操作重試不得重扣；競爭操作在 Transaction 重新驗證權威來源。單品項原流程不變。

## 範圍與驗收

多品項歷史出貨上限暫定 40 筆，整單事件及品項數仍受既有 Core 200 事件／5 品項限制；這是 Firestore 成本及交易讀取的試點安全邊界，不可靜默忽略超出的憑證。

新增六組 Firestore Emulator 整合測試，覆蓋雙倉批次扣帳、五筆同產品、身分權限、冪等競態、損壞兄弟憑證與末端寫入碰撞。Node、Rules、Emulator、Chrome 的最終結果以本 PR 的 CI 為準，未通過前不宣稱驗收完成。

**尚未完成**：多品項獨立送達 writer、已履約後收貨、取消／恢復、CLOSE 退貨的端對端整合，以及真實登入瀏覽器／Preview UI 驗收。正式 v2 功能仍保持關閉。
