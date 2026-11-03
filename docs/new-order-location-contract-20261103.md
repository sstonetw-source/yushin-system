# 新建單權威預留契約（2026-11-03）

唯一預留 writer 仍為 `commitOrderReservation`，唯一權威文件仍為
`inventoryReservations/{orderId}__{itemId}`。新建單直接產生：

- `locationSchemaVersion: 2`，`locations: [{warehouseId, reservedQty}]`；零預留為空陣列。
- `quantity` 等於所有位置的預留總和；`shortageQty` 與訂單品項一致。
- ledger 不再包含單倉 `warehouseId`；品項的 `warehouseId` 仍表示供應／履約指定倉。
- `lifecycleWarehouseIds` 由同筆交易實際查核的啟用實體倉組成，整單品項共用排序後的候選集合。
- 庫存差額、預留狀態及缺口由既有 `planLocationReservation` 計算，未新增庫存核心。
- 原子提交庫存、需求、預留、品項與完成憑證；重送使用既有 order/sync 憑證。
- Movement ID 同時綁定 orderId 與 syncAttemptId，避免兩張單共用同步 ID 時撞號。
- 新初始化拒絕任何已存在的預留帳；不採用舊零帳或執行歷史資料轉換。

後續讀取器接受 1–2 個唯一候選實體倉；保留原兩倉上限、最新角色檢查、
位置包含關係、冪等憑證、供應與批次追溯及交易原子性。
既有每品項單倉配置政策保留，需跨倉分配時仍中止，不以格式修改偷改配置規則。

## 驗證及發布界線

新增實際 Firestore Emulator 測試以正式初始 writer 接打單、出貨、送達、
取消／恢復與原批次結案退貨，分別驗證一倉與兩倉候選、送達不扣庫及重送不重複入庫。
原 Auth Callable 建單→手動採購／PO→收貨測試改驗 v2 原生來源；不以 Admin 補旗標轉換預留。

這批不改 Functions 開關、Rules、正式資料或正式路由。
GitHub Pages 的來源資產版本更新不等於 Functions 已部署。
**尚不能宣告完整上線**：超過兩倉、部分生命週期入口原有五品項限制、直送生命週期、
新庫存零主檔初始化、正式舊 writer 封鎖與角色驗收，仍須逐項解除後集中發布。
部署初始 writer 前必須連同相容的後端及前端版本受控發布，禁止單獨上傳本檔案。
