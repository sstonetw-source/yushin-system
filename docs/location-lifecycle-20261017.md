# 多位置取消／恢復核心（2026-10-17）

本批擴充既有 `YushinReservation.planLocationReservation`，不建立第二個預留核心。`nextStatus` 預設 `normal`；`cancelled` 不依賴訂單目標量或供應承諾，完整釋放所有既有位置，回傳空 locations、quantity/shortageQty/remainingToOrderQty 為零及 released 狀態。恢復傳入 normal、當下未交付量與未到貨承諾，仍保留可用的既有預留，供應承諾不算實貨。

完整來源先經 `reservationStockDeltas` 驗證，再以相同函式產生公司與各倉差額。禁止混合位置格式；提供 itemReservedQty 時必須與權威 quantity 一致。公司、所有可承接新預留的分倉及既有持有位置必須是非負安全整數，reserved 加 transferFreeInTransit 不得超過 onHand。停用實體倉可釋放舊預留，但不承接新增；保管位置仍須交原履約流程。缺失舊倉／舊庫存不能釋放。

現行單倉 `planReservationLifecycle` 同樣在取消／恢復前拒絕不可能的預留與途中量組合，保留歷史小數相容。實際取消／恢復 Service 的 shortageQty 直接採用既有核心輸出。純核心回傳 proposed change；呼叫者仍須在相同 transaction 讀取全數來源後套用，不能使用畫面快取或將重試結果重複加帳。

## 驗收與邊界

- 核心測試涵蓋取消、恢復、其他訂單競爭、停用倉、供應承諾、錯誤投影、混合版本、原始帳目異常、重複呼叫及 96 組狀態循環；確認 onHand 不變及公司差額等於分倉差額合計。
- 現行 Service 的 Node／Emulator 測試涵蓋 admin、sales、engineer，異常時訂單／預留／公司與分倉／需求均不變；修正帳目後可以原流程重試。
- 無新增 Firestore 讀寫、集合、查詢或索引，未改 Rules。計算沿用已讀快照，預留交易證明依舊由 StockPermissions 及 Rules 驗證。
- v2 仍是純核心提案：StockPermissions 與 Rules 持續拒絕多位置欄位。尚須整合多位置實際交易、逐倉 movement／證明、履約、調撥與五角色驗收後才能啟用，不因本批合併而改動歷史資料。

安全檢查範圍與既有缺口記錄於 `reservation-location-rules-audit-20261017.json`；這不是全系統安全認證。

## Emulator-only 單品項雙倉取消／恢復原子交易（2026-10-17）

新增 `functions/single-item-location-lifecycle-service.js`：`commitSingleItemLocationLifecycle` 僅允許 `demo-yushin` Emulator；獲授權的管理員／本人業務或工程師，在尚未採購、到貨、打單、寄出、送達、退貨且無採購需求文件時，使用共同 `planLocationReservation` 在一個 Admin SDK Transaction 同時釋放 A/B 預留與訂單狀態，並在恢復時按即時空閒實貨重新分配。先讀後寫、來源與投影精確比對；原倉停用不影響釋放但禁止新增。單一 `inventoryReservations` ledger 保存 `lifecycleWarehouseIds`，操作憑證與所有 movement 和總／分倉改帳一同提交；重送不重扣，異常及寫入衝突整筆回滾。完整 Emulator 案例包含競爭訂單、兩倉差額守恆、停用倉改配、五角色邊界（admin／本人 sales／engineer 操作）、來源錯誤、重送與碰撞。**部分出貨取消、已有採購需求、其他品項及全角色 Preview 尚未整合**；本流程無 Callable／UI，不能上線。
