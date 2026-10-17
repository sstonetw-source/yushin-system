# 單一訂單品項雙倉預覽（2026-10-17）

狀態：**已實作唯讀權威規劃及僅限 Emulator 的原子提交；尚未接線，Preview／正式 v2 預留維持關閉**。

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
- 唯讀函式不會提交；新增內部提交僅供 Emulator 驗證。現行收貨／打單／送貨／取消／恢復／退貨／調撥仍只接受舊單倉位置帳，須完成全入口寫入相容與 Preview 驗收後才能解除阻擋。
- `tests/emulator-single-item-location.cjs` 驗證真 Firestore Emulator 的兩倉配置、公司上限、供應在途不入庫、角色、取消、異常與**零寫入**。純單元測試 `tests/single-item-location-service.test.js` 檢查不信任多餘輸入且沒有匯出 Callable。

## 下一步

v2 庫存原子提交已新增 Emulator 實作，仍須通過整合測試。接續送貨、收貨、取消、恢復、退貨、保管及調撥的共同位置契約。確認所有服務與 Rules 相容之後，才可以在 Preview 發送真實 v2 寫入。

## Emulator 原子提交（2026-10-17，新增）

`commitSingleItemTwoWarehouse` 與唯讀規劃共用同一交易內讀取及 Reservation Core。只允許 `FIRESTORE_EMULATOR_HOST` 已設定且 Admin Firestore 的實際 projectId 為 `demo-yushin`；未匯出 Callable、未接入前端，Preview／正式寫入仍關閉。

提交輸入新增固定 `attemptId` 與來源 `syncAttemptId`，其餘僅限訂單、品項及兩個候選倉 ID。限來源同步 pending、attempt 相符且尚無採購／收貨／物流進度的品項。五角色以 users 的真實角色核對；業務／工程師限本人訂單。既有預留所有權、產品、品項及公司／各倉帳目須一致。

單一交易一起更新公司／兩倉 reserved、原 `inventoryReservations/{orderId}__{itemId}` 的 v2 locations、訂單品項 reservedQty／shortageQty，以及各倉 movement 與 `reservationOperationReceipts/single-v2-{attemptId}`。不增加 onHand、批次、採購在途或新集合。v2 ledger 移除舊 warehouseId；訂單原 warehouseId 仍為來源提示。沒有新增 Query、Listener 或索引；每次首次執行固定讀取 10 份文件（使用者、憑證、訂單、產品、公司帳、兩倉主檔／帳、預留），首次雙倉正差額最多寫入 8 份文件，交易衝突可重讀。

相同操作 ID 比對原 UID、角色、來源同步及正規化意圖；已提交回覆重送只回傳原結果，不覆蓋後續訂單狀態。不同 ID 也必須重新讀取既有 ledger，不能重複預留；零庫存保存缺口及憑證，不創造虛擬實貨。任何驗證或 movement create 衝突皆整筆回滾。

新增 Emulator 案例：五角色提交／重送、同／異操作 ID 併發、兩訂單競爭庫存、公司上限及零庫存、變更意圖／身分／停用、過期同步、服務商品、結案、停用倉、異常帳及投影、已有收貨／備貨、舊單倉轉 v2、晚期寫入衝突回滾及原 ID 重試。仍須等待 CI 實際執行後才能將此批驗證記為通過。

下一步為收貨／出貨／取消／恢復／退貨／保管／調撥的完整位置契約及 Preview 全流程驗收。此內部提交能力不是可用的多倉功能，正式資料及 Rules 均未變更。

### 本批本機驗證結果

- Node 應用測試 1,493／1,493 通過，0 失敗；app 與 Functions 共用 Core 建置一致、修改來源語法及 diff 檢查通過。
- Java 21 + Firebase CLI 15 + Firestore Emulator：單品項雙倉 12 案例及既有分組雙倉 5 案例合跑，共 17／17 通過，0 失敗。
- 首次合跑發現兩測試檔共用 A／B 倉主檔，負例的保管倉設定干擾既有測試；本套件改用 V2-A／V2-B 隔離後重跑全通過，並保留實際交易內的併發驗證。
- 本機完成上述驗證後，使用者已於 2026-10-17 明確授權本批公開推送及完整 CI 通過後合併。完整 Rules、Auth Callable、瀏覽器測試交由本批 PR 的 CI 執行；CI 通過前不得合併，不以本機 Admin Emulator 案例替代完整 CI。
- 未部署 Firebase、未變更正式資料及使用者權限；後續完整多倉履約仍待完成。
