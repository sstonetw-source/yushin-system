# V2 驗收清單

## 2026-10-21 — 他倉續出原介面整合（待本批完整 CI）

- #213 已合併：製作／編輯 DRAFT 採購文件獨立，只有「確認已採購」提交交易與在途；#214 已合併，完整 CI 2205 項通過，原站已驗收履約／CLOSE 退貨後第二張 PO 的 1＋2 分批實收及未知回覆重試。
- 本批在原出貨清單讀取 inventoryReservations 的權威位置，按倉庫分列、選取與確認；保留原 Shipment Service，沒有新 writer。只限 localhost demo-yushin 的既有 Shipment Emulator gate、CUSTOMER_SHIP，其他模式維持原流程。
- 一次最多核對 200 個品項，每批 20 個 server 點讀，不新增 Listener／Index／Collection／Rules。檢查真 Auth、角色、來源／產品／預留一致性；讀取失敗、帳號切換或版本過期不猜回來源倉。未知回覆仍顯示原倉／原數量，重送同 ID。
- 原 1280／390px 整站驗收接續第二張 PO 實收後，由另一倉出 5 件、丟失成功回覆、重整原列重試；來源倉不變、另一倉實扣一次、其他需求／目標訂單／送達／退貨不變。送達總數仍為 4，總出貨增為 9，尚有來源倉預留 3；不能宣稱全部履約完成。
- 本機 Node 1669／1669 通過，完整 Chrome／真 Auth／Emulator／Rules 以本批最新 CI 為準，通過才合併。未部署 Firebase，未修改正式資料與角色；多品項、剩餘送達及 Preview／正式啟用仍須後續驗收。

## 2026-10-20 整站啟動 gate
- 原首頁 + 完整 app.js / 模組 + 真實 Auth / Functions / Firestore，桌機與手機、五角色登入恢復、原導航取消及物流接手：新增 CI 驗收，通過前不可宣告完成。
- 詳見 [驗收邊界](full-site-emulator-boot-20261020.md)。不涵蓋正式部署、真實資料遷移或 PDF 匯出。

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

截至 2026-09-23，最新 main 已具備 iPhone 背景恢復保護與 Brand Master 只讀完整性稽核；Node regression 與 Firestore Rules emulator 仍須在每次 main 更新後全部通過。

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
- [ ] peer transfer：經倉與直送
- [ ] advance delivery：待商業定義確認後加入
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
- [ ] Brand Master 稽核正式來源缺漏為 0，再決定是否移除相容層

本批首次 CI 39627998910 在原站出貨列遇到背景重新讀取後未重畫的問題（54／56），未合併。修正原工作佇列 finally 在庫存頁重畫出貨清單，等待位置核對完成才顯示；新增非同步回歸測試，原站測試也等待清單與倉庫主檔就緒後選倉。其餘斷言與權威交易驗證保留，須以新 head 完整 CI 判定。

第二輪 CI 39629304557 診斷確認更深層原因：出貨後 normalizedOrderItems 的 legacy display shortage 與原始 items.shortageQty 不同，位置核對不可把顯示投影當原帳。本批改用原始來源 item 數量核對與版本失效，保留既有 normalize 與後端公式；新增出貨後投影差異回歸。前述兩輪皆非驗收完成，待新 head 完整 CI。
