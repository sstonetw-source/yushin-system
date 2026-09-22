# V2 驗收清單

## 自動測試
- [x] legacy single-item order 仍可讀
- [x] multi-item order 每 item 有 stable itemId
- [x] 訂20/available8 => reserved8 + shortage12
- [x] shortage 可分 purchaser/self-order
- [x] self-order 有 internal order number + cost + supplier
- [x] stock replenishment receipt 不建立 customer dispatch task
- [x] partial receipt 立即補 reservation
- [x] reserved qty 進 purchaser 待打單
- [x] purchaser 已打單 qty 才成為可出貨
- [x] partial delivery 只扣該 item/qty
- [x] delivery 扣 onHand/reserved
- [x] FEFO for expiry-managed lots
- [x] FIFO for no-expiry lots
- [x] delivery 保存 lot allocations / COGS
- [x] cancel/restore 不重複 reserve/release
- [x] return item/qty 正確
- [x] billing 可 true <-> false，留 audit
- [x] duplicate click 不重複寫入
- [x] engineer 可建立/管理自己的 Forecast/Quote/Order
- [x] engineer 有 salesCode/業績歸屬
- [x] purchaser 協助建單必須指定 responsible sales
- [x] sales/engineer 無未授權成本讀取 — operational `inventoryLots` 與受保護 `inventoryLotCosts` 已分離；Rules emulator 驗證 sales/engineer/warehouse 不可讀成本，歷史 COGS 由精確 lot allocations + protected costs 重建。正式 Rules 已部署；舊資料成本隔離仍列為資料清理 gate。
- [x] sales/engineer 無進銷存分析權限
- [x] product search 使用 bounded query
- [x] order/quote list pagination
- [x] dashboard 不掃全部歷史
- [x] price import preview before commit
- [x] quote number generator unchanged
- [x] Forecast admin / salesCode / ownerUid 三種正式查詢皆有 composite index

截至 2026-09-22，PR #32 合併前最新 Node regression 為 **142/142 通過**；Firestore Rules emulator 亦已在 GitHub Actions 通過。PR #32 已合併至 main（merge commit `7f6df3b`）。

## 人工驗收
- [ ] Desktop Chrome/Safari
- [ ] iPhone Safari
- [ ] Admin
- [ ] Sales
- [ ] Engineer（商務 + 工程）
- [ ] Purchaser
- [ ] Warehouse
- [ ] 現貨全數
- [ ] 部分現貨
- [ ] purchaser ordering
- [ ] sales/engineer self-order
- [ ] partial receipt
- [ ] partial dispatch paperwork
- [ ] partial delivery
- [ ] stock replenishment no customer
- [ ] multi-item mixed sourcing
- [ ] cancel/void/restore/return
- [ ] low stock/safety stock
- [ ] batch cost/COGS
- [ ] company existing shipping system handoff
- [ ] long operation shows progress/loading
- [ ] Firestore permission-denied UX

## Deployment gate
- [x] 完整備份清單包含 V2 fulfillment 與 protected cost collections
- [x] V2 查詢所需 inventoryReservations / inventoryLots / inventoryMovements / supplyOrders 索引已在 firestore.indexes.json
- [x] Forecast admin / salesCode / legacy ownerUid 複合索引已納入 main
- [x] Firestore indexes 已部署至 `yu-shing-company`，並於 2026-09-21 確認正式環境索引存在
- [x] PR #30 的 firestore.rules 已部署至 `yu-shing-company`（新版 Rules 保留 admin-only legacy migration read）
- [x] PR #32 已於 2026-09-22 合併 main
- [ ] 正式資料備份：使用者於 2026-09-21 決定免費方案不建立 managed backup，接受正式資料無快照可直接還原的風險
- [ ] 在 Firebase 專案執行舊資料成本隔離並重新預覽為 0
- [ ] 完成 Desktop / iPhone × 五角色人工驗收
