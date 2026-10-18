# 送達撤銷與明確批次退貨追溯（2026-10-17）

狀態：僅供 demo-yushin Firestore Emulator；新增真正的送達撤銷交易，以及**唯讀**退貨批次追溯。未開放 Callable／前端／Preview，未實作實物退貨入庫提交。

## 兩種作業分開

| 動作 | 事實 | 資料變更 |
| --- | --- | --- |
| 送達撤銷 | 更正一筆誤登的客戶送達，貨品仍已寄出 | 只移除選定 deliveryRecord、保留完整撤銷歷史並更新送達投影，不還原實貨／預留／批次 |
| 退貨追溯 | 操作人明確選出實際退回的原出貨批次及數量 | 只核對來源與預覽原批次還原量，canCommit=false，所有文件不變 |
| 實物退貨入庫 | 真的收到退回貨品，須決定品質、實際入庫倉及補送／結案 | 本批尚未實作，不能把上述任一動作當成完成入庫 |

部分送達不能推定混合包裹中哪個批次已到達。追溯請求必須明確列 selections[{lotId,qty}]，不能自動從最後一批或 FEFO 猜退回哪批。指定 lot 必須屬於選定的 shipment，單批不得超原出貨量，合計不得超過該 shipment 已確認送達量；不挪用另一倉／另一筆出貨的額度。

## 共用來源驗證

`shipment-delivery-service.js` 將 users／order 權限、當前 v2 出貨送達投影、原出貨 movement 證據抽為共同 helper；新增撤銷、確認及追溯共用，不複製數量公式或原出貨意圖雜湊。

- 每筆來源必須是同步已完成且 attempt 仍相符、未取消／結案的單品項 v2 實體訂單，沒有退貨／補送、保管或調撥進度。
- 原寄送的數量、產品、倉庫、收件快照、日期／備註及批次須符合固定 movement 與原 intent hash。批次陣列使用值比較，不依物件鍵插入順序判斷。
- 出貨／送達投影沿用 `Fulfillment.projectShipmentDelivery`，品項與訂單的快取數字必須一致。
- 確認與撤銷維持 admin 或本人 sales／engineer；purchaser／warehouse 不可代辦送達更正。唯讀追溯允許五角色，sales／engineer 仍限本人訂單，且回應不包含實際成本。

## 送達撤銷與重試

`reverseShipmentDelivery` 接受訂單、品項、目標 deliveryRecordId、獨立 operationId、來源 syncAttemptId、日期及必填原因。整筆撤銷指定送達紀錄，不做部分縮量；需要部分更正時仍須後續 UI 流程明確設計。

單一 transaction 一般讀 3 份文件（users、orders、原出貨 movement），只更新同一份 orders：刪除目標送達紀錄、下修品項／訂單 deliveredQty、重新計算 isDelivered，並在 deliveryHistory 保存 action=delete、source=shipment_confirmation_reversal、原紀錄 before、原因、操作者／角色、撤銷 operationId、意圖 hash 及原結果。

不讀寫 inventory／warehouseStocks／inventoryReservations／inventoryLots／成本，也不新增 movement。已全部送達後撤銷，只重新成為「已寄出、待確認」，不重新預留或產生可再次寄出的數量。

相同撤銷 ID 與原身份／意圖只回覆原結果；後續重新合法確認後，再重送舊撤銷不會覆蓋新的總進度。不同 ID 併發撤銷同一筆，只有一筆能刪除，另一筆發現已不存在而拒絕。確認與撤銷 ID 禁止跨動作重用。原送達 ID 仍保留在歷史，不能因重試而恢復已撤銷紀錄。重試回覆為原結果，畫面日後接線應另刷新現在的進度。

## 唯讀退貨追溯

`functions/location-return-trace-service.js` 的 `planLocationReturnTrace` 接受訂單、品項、shipmentId、syncAttemptId 及明確批次 selections。不能由呼叫者提供產品、倉庫、庫存、批號／效期、角色或價格。

`Inventory.planExplicitShipmentReturn` 驗證原出貨批次合計／唯一性及指定批次上限，沿用 availableReturnAllocations 取得來源。Service 同 transaction 讀回所選真實 inventoryLots，核對產品／原倉、批號／效期、非負整數餘量及原入庫量，再以既有 planLotRestoration 產生唯讀預覽；結果不能超過原入庫量。缺批次、換批號／效期、錯倉、錯產品或異常帳均拒絕。

讀取一般為 3 份共同來源文件＋N 個明確批次，N≤200；沒有 Query／Listener。返回 status=read-only、canCommit=false、原倉／原批次、選定數量及 lotRestorationPreview，不返回真實成本（零為占位，非估價）。不新增任何事件／憑證，也不修改 stock 或 orders；重複預覽不能被視為退貨已提交或可永久保留的入庫承諾。

此追溯只處理尚無任何退貨的單品項來源，且只預覽原出貨倉的原批次。實際入庫時必須在新交易重讀並驗證公司／分倉、批次、先前退貨、品質、實際收貨倉及補送／結案決策；不能直接寫入預覽結果。跨倉退回、已退過的剩餘額度及真正退貨原子提交仍待整合。

## 本機驗證

完整 Node 測試 1,507 項、Firestore Emulator 整合測試 46 項全部通過。Emulator 組合包含本批出貨／送達／撤銷／追溯 29 項、單品項雙倉預留 12 項、分組預留 5 項；另通過 app／Functions 共用核心產物一致性與差異格式檢查。完整 GitHub CI 的 Rules、Auth／Callable 及瀏覽器驗證以 PR 執行結果為準。

## 尚未完成

前端接線、workCategories／需求投影、真正 UI 打單、Preview 完整走單、多品項、部分更正送達、取消／恢復、實物退貨／補送／跨倉退回、收貨／保管／調撥仍未完成。現行 v2 客戶端寫入阻擋與正式資料完整保留。

後續進展：原倉可再入庫品已新增獨立的實物退貨交易，見 `location-return-receipt-emulator-20261017.md`；本文件的 trace 仍為唯讀，不能提交預覽。後續補送出貨／送達閉環仍未完成。


## 2026-10-18 更新：取消與既有 CLOSE 後的剩餘批次查核

本節取代先前trace只支援無退貨且正常訂單的限制。原 planLocationReturnTrace 現支援一致cancelled且已完整釋放的單品項雙倉來源；正常或取消來源若已有CLOSE，須先以同交易有界return movement query核對全部真實憑證，再傳選定shipment的priorReturns給原Inventory Core。取消scope與實際退貨writer共用，並唯讀核對ledger身份、released／quantity0／shortage0／locations空及item投影。

回傳新增confirmedQty、previousReturnedQty、remainingReturnQty與remainingLotAllocations，均為本次選量尚未提交前的額度。各批剩餘原出貨上限不代表均已送達，總退貨仍受remainingReturnQty約束；只驗證明確所選批次的目前實物資料。查核不寫入、不建立收貨憑證／預留，不讀成本／公司庫存／分倉庫存；canCommit仍false。預覽後他人先退貨，原writer必須重讀並拒絕超額，不能以舊預覽保證提交。

get呼叫正常4＋N、取消5＋N（N≤200）；return proof query limit201最多接受200筆，空快取亦核對，最多文件正常403／取消404，無新索引或Rules。新增六組Emulator與一組純Core測試：正常與取消CLOSE後逐批額度、跨shipment不混用、五角色、錯誤／隱藏憑證、取消ledger、途中／額外打單／REPLACE拒絕、201筆上限、零寫入／零成本及過期預覽後實際提交。結果以本批實際CI為準。

仍無正式Callable／前端／Preview或部署；REPLACE／混合補送後追溯、多品項、跨倉／品質隔離、更正／撤銷退貨及成本結算仍未整合。
