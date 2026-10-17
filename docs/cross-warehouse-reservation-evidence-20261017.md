# 同產品跨倉多品項的預留交易證明

基準：main `ceeac9d`（PR #130）。本批處理多筆各自單倉的預留，不啟用單品項多位置 ledger。

## 契約

- 沿用 StockPermissions.run、inventoryReservations、inventoryMovements、inventory、warehouseStocks，沒有第二份庫存帳或新集合。業務／工程師仍使用既有 stockOperations；管理員既有能力不變。
- 採購／倉管同一交易的同產品最多 5 筆預留，使用 reservationStockDeltas 判斷異動。跨倉時，每倉 movement 各自記錄證明；reservationIds 包含同產品全部品項，但第一筆代表必須來自該 movement 的倉庫。新增布林 crossWarehouse:true 選擇逐倉核對路徑，warehouseReservationIds 只列該倉品項，須為完整公司清單的唯一子集；每筆變動預留都必須在本倉清單內，不授予額外權限。
- Rules 對每個 movement 核對公司 reserved 差額等於所有列合計，分倉 reserved 差額等於該倉列合計。不同倉的增減可以互抵公司差額，不能互抵個別分倉差額。公司零差額且未寫公司帳時，憑證優先沿用同交易已讀取的實際文件參照，不猜測產品 ID 就是庫存文件 ID。不能借全公司或另一倉的 movement 代替；缺任一必要庫存／movement 或量不符，整個 transaction 拒絕。
- 每筆變動預留仍驗證原訂單品項、產品、歸屬與不可變來源；證明須連結同交易的新 movement，不可重用。跨倉合併預留／釋放不得搬動既有正量預留，JavaScript 與 Rules 都檢查每筆來源；原單筆調撥途中／到貨的專用證明保持原契約。
- 同倉群組沿用原快速核對，舊憑證沒有 crossWarehouse 欄位時仍相容。v2 locations 等位置欄位在共用交易及 Rules 的封鎖保持。

## 讀寫、發布與驗收

不增加 Query、Listener、Index 或獨立 checkpoint；重用交易快照與既有 movement，沒有新增正式資料遷移。Rules 會驗證原來的公司及指定分倉文件；跨倉群組先計算公司差額並驗證所有產品，成功後分倉差額只合計本倉子集並重用相同快照，不重複產品識別檢查，避免超過規則運算預算；最壞 5 筆、兩倉的新增、部分釋放、公司零差額與全釋放須以 Emulator 驗證。多於兩倉的最大批次及單品項多位置履約不在本批完成範圍。

Node 涵蓋兩操作角色、5 筆分組、部分釋放、公司零差額互換、全釋放、缺指定倉紀錄、5 筆上限及混合搬倉停止。Emulator 使用真正 StockPermissions，涵蓋五角色合法兩倉預留、兩操作角色的 5 筆／兩倉上限與釋放，並直接改動原生寫入測試錯公司／倉量、缺倉帳／movement、假布林及假同倉旗標。另有原生 batch 反例：非代表品項從第三倉移出卻不釋放原倉，必須拒絕。完整結果以 PR CI 為準。

本批前端與 firestore.rules 需配套發布；舊 Rules 會拒絕新跨倉合併證明，不能將 GitHub 合併當成正式 Firebase 已更新。未執行部署或正式資料修復，完整多位置預留、履約及 Preview 五角色全流程仍待整合。
