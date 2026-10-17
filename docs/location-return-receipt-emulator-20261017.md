# 原倉實物退貨入庫（2026-10-17）

狀態：僅 demo-yushin Firestore Emulator。`commitLocationReturn` 已有實際原子交易，不匯出 Callable、不接前端／Preview、不部署正式 Firebase。上一批唯讀追溯仍是預覽，不能代替本交易。

## 入口與權威計算

請求明確指定 orderId、itemId、shipmentId、syncAttemptId、固定 operationId、實際收貨 warehouseId、selections[{lotId,qty}]、date、reason、condition=RESTOCKABLE 及 settlement=CLOSE／REPLACE。只允許退回原出貨實體倉且品質可再入庫，破損／隔離／跨倉退回拒絕。不能輸入角色、價格、帳目或批號替代真實來源。批次選擇排序後雜湊，重排不會變成另一意圖。

權限沿現有客戶退貨生命週期：admin 或本人 sales／engineer；purchaser／warehouse 不因能查看追溯而取得客戶退貨決策權。這是既有權限的內部驗證入口，並未新增正式使用者權限或倉庫簽核 UI。

- `shipmentDeliveryContext(...,{allowReturns:true})` 共用帳號、所有權、來源同步、單品項實體訂單及歷史出貨／送達投影驗證。取消、同步未完成／已換 attempt、服務、保管與調撥途中均拒絕。
- `projectShipmentReturns` 以原出貨／送達事件與實物退貨事件推導累計退貨、CLOSE 數量、REPLACE 需求、有效交付及剩餘需求。原出貨、原送達及 gross deliveredQty 不刪減；CLOSE 視為商業已結清，REPLACE 才降低有效交付。
- `Inventory.planExplicitShipmentReturn` 驗證明確選定原批次，扣除同 shipment 先前每批實際退貨，合計不得超該筆已送達量。不能挪用另一筆出貨的額度，也不猜混合包裹中哪一批已送達。
- `Reservation.planReservationReturn` 對正常訂單正向 v2 CUSTOMER_RETURN 支援保留多倉 ledger：REPLACE 僅增加原倉預留；CLOSE 僅增加自由實貨，原倉／他倉既有預留及 shortageQty 均保留。舊單小數、取消及撤銷契約不變；多倉取消／退貨縮量尚未開放。
- `Inventory.planLotRestoration` 還原真實原批次，原批號／效期、產品／倉庫及 receivedQty 上限都需一致；不重建遺失批次，也不寫入未分批替代量。

## 交易與一致性

同一 Admin transaction 先讀 users、orders、固定退貨 movement、原出貨 movement，再有界查詢該訂單全部實際退貨 movements（包含訂單可能漏掉的憑證）、公司 inventory、原倉 warehouseStocks、inventoryReservations、warehouses，以及原倉產品全部 inventoryLots（包含零餘量，limit 201；最多接受200）。所有讀取在寫入前完成。

訂單退貨筆數先與實際入庫憑證數量核對，避免移除CLOSE快取後重新取得額度。每份先前退貨須與固定 movement 的完整 returnRecord、原請求 hash、產品／倉庫／品項／數量一致，不能刪改 order 快取來恢復額度。公司與來源倉原始帳須可容納現有預留及自由調撥途中量，ledger 與 item 預留、shortage 及尚待履約量須一致。分倉實貨必須精確等於權威批次餘量合計；不足或超額均拒絕，不自動修帳。

一次提交更新公司／原倉實貨、v2 預留與原倉預留、指定原批次餘量、orders 的 returnRecords／returnHistory／returnedQty／isDelivered，並 create 固定 `inventoryMovements/location-return-{operationId}`。保留原 deliveryRecords、warehouseShipmentRecords、累計寄出與送達；其他倉庫／批次／其他訂單預留不寫入。不額外讀取成本集合，也不回傳真實成本；movement 標記 costPending；成本結算不在本批。

固定 movement 保存 intentHash、原 actor UID／role、returnRecord 與原 result。相同 ID／意圖／身份只回原結果，不重新入庫；改意圖／身份拒絕。重試仍重新驗證帳號權限及訂單所有權，但已成功操作可在後續取消等狀態回覆原成功，不重寫新進度。來源訂單與共同庫存文件的併發衝突會重讀，不能退超剩餘已送達／原批次額度。任何末端 create 失敗均回滾全部變更。

一般10次 transaction get（其中兩次查詢）；批次最多200份，先前退貨最多199份，因此首次最多208份文件、後續最多407份。最多200個批次 update，加公司／分倉／ledger／order／movement 五次寫入。無 listener、無成本集合、無外部副作用；不新增索引或 Rules；沿原產品／倉庫查詢，另以 sourceId＋action 等值條件查詢該訂單退貨憑證。正式啟用前仍需在 Preview 確認查詢與索引。

## 本批限制與下一步

可以分次退貨、混合 CLOSE／REPLACE、重送及併發；可由 fulfilled ledger 恢復原倉補送預留。**REPLACE 目前只完成入庫與需求／預留恢復，尚未完成後續補送打單、再出貨、再確認送達的閉環。** 現有 v2 shipment／delivery／reversal 入口遇到非空 returnRecords 仍拒絕，避免舊投影重複扣帳；舊操作的無寫入 replay 仍可回覆原結果。唯讀追溯入口仍限尚無退貨的來源，後續部分退貨由本交易內重新驗證剩餘額度。

多品項、跨倉退回、破損／隔離、取消後退貨、退貨縮量／撤銷、成本結算、workCategories／採購需求同步、前端入口及 Preview 完整走單仍待整合。不能宣稱完整退貨／補送流程或正式 UI 已可使用。

## 本機驗證

完整 Node 測試1,512項全部通過；Firestore Emulator 組合58項全部通過（出貨／送達／撤銷／退貨41項、單品雙倉12項、分組預留5項）。包含實物CLOSE／REPLACE、fulfilled重新預留、混合批次分次退貨、五角色、固定ID重送／意圖衝突、競爭額度、刪改先前憑證／快取、原始帳與批次異常、末端movement失敗完整回滾，以及有界讀取／寫入及不讀成本集合。app與Functions共用產物一致性、JavaScript語法及差異格式檢查通過。完整 Rules、真實Auth／Callable及六組Chrome回歸結果以GitHub PR CI為準。

業務方向更新：因主要情境為訂錯貨，新請求未指定settlement時改預設CLOSE；明確REPLACE及既有操作不改。後續免費補送整合暫緩，優先一般重新下單；詳見 `wrong-item-return-reorder-20261017.md`。
