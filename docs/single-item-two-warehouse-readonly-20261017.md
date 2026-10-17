# 單一訂單品項雙倉預覽（2026-10-17）

狀態：**已實作唯讀後端權威規劃，尚未接線、尚未開放 v2 實際預留**。

## 功能與責任

`functions/single-item-location-service.js` 的 `planSingleItemTwoWarehouse` 使用已存在的 `modules/reservation-core.js` → `functions/shared/reservation-core.js` → `planLocationReservation` 作唯一數量計算來源。一次 Firestore Admin SDK Transaction 讀取：

1. 登入 UID 對應 users 角色／停用資料；業務與工程師須為原訂單負責人。
2. 訂單、唯一品項、產品主檔（服務商品不可入庫）、未取消的訂單狀態。
3. 公司 inventory、兩個候選實體 warehouses 及 warehouseStocks。
4. inventoryReservations 舊預留；來源品項與既存預留必須一致。

客戶端輸入僅限 `orderId`、`itemId`、`warehouseIds`（剛好兩個）；不得提供可繞過驗證的角色、庫存或數量。函式僅回傳未提交的 `locations[].reservedQty`、公司和分倉 reserved 差額、缺貨及扣除供應在途後的待採購量。

範例：單一訂單品項訂購 10，A 倉現貨 4、B 倉現貨 8、公司總可用 12 → 提案 A 預留 4、B 預留 6。**未修改任何庫存**。

## 防護與限制

- 本 Service 不是已啟用的 Cloud Callable，`functions/index.js` 不匯出，前端不呼叫。
- 不新增 Firebase 集合、欄位、索引及 Rules，也沒有正式資料遷移／部署。
- 業務保管、停用倉庫、服務商品、取消、已出貨或異常庫存會拒絕。
- 這不是 v2 的交易提交；現行收貨／打單／送貨／取消／恢復／退貨／調撥仍只接受舊單倉位置帳，須完成全入口寫入相容與 Preview 驗收後才能解除阻擋。
- `tests/emulator-single-item-location.cjs` 驗證真 Firestore Emulator 的兩倉配置、公司上限、供應在途不入庫、角色、取消、異常與**零寫入**。純單元測試 `tests/single-item-location-service.test.js` 檢查不信任多餘輸入且沒有匯出 Callable。

## 下一步

先完成 v2 庫存原子提交 Service 的驗證，再接送貨、收貨、取消、恢復、退貨、保管及調撥的共同位置契約。確認所有服務與 Rules 相容之後，才可以在 Preview 發送真實 v2 寫入。
