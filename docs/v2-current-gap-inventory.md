# V2 Current Gap Inventory

## 2026-10-21 — 他倉續出原介面整合（待本批完整 CI）

- #213 已合併：製作／編輯 DRAFT 採購文件獨立，只有「確認已採購」提交交易與在途；#214 已合併，完整 CI 2205 項通過，原站已驗收履約／CLOSE 退貨後第二張 PO 的 1＋2 分批實收及未知回覆重試。
- 本批在原出貨清單讀取 inventoryReservations 的權威位置，按倉庫分列、選取與確認；保留原 Shipment Service，沒有新 writer。只限 localhost demo-yushin 的既有 Shipment Emulator gate、CUSTOMER_SHIP，其他模式維持原流程。
- 一次最多核對 200 個品項，每批 20 個 server 點讀，不新增 Listener／Index／Collection／Rules。檢查真 Auth、角色、來源／產品／預留一致性；讀取失敗、帳號切換或版本過期不猜回來源倉。未知回覆仍顯示原倉／原數量，重送同 ID。
- 原 1280／390px 整站驗收接續第二張 PO 實收後，由另一倉出 5 件、丟失成功回覆、重整原列重試；來源倉不變、另一倉實扣一次、其他需求／目標訂單／送達／退貨不變。送達總數仍為 4，總出貨增為 9，尚有來源倉預留 3；不能宣稱全部履約完成。
- 本機 Node 1667／1667 通過，完整 Chrome／真 Auth／Emulator／Rules 以本批最新 CI 為準，通過才合併。未部署 Firebase，未修改正式資料與角色；多品項、剩餘送達及 Preview／正式啟用仍須後續驗收。

## 2026-10-20 驗收範圍更新
- 新增原 index/app/模組整站啟動案例，涵蓋五角色登入恢復與取消→物流接手。測試設計與尚存邊界見 [本批說明](full-site-emulator-boot-20261020.md)；未通過 CI 不視為驗收完成。
- 本機通過仍不等於正式資料遷移、正式部署或所有業務流程驗收完成。

盤點基準：main 7cf91049；本文件供 Work 模式避免重複大範圍分析。

| Area | Main current state | V2 target | Action |
|---|---|---|---|
| Order model | items[] + legacy top-level compatibility | itemId + qty-level lifecycle authoritative | keep compatibility; move mutations to item qty |
| Manual order | single-item modal | multi-item editor | replace UI/save path without changing quote number |
| Copy order | copies root/first-item style fields | copy complete items[] | fix |
| Reservation | item-level foundation exists | qty-level source of available/shortage | harden transactions/idempotency |
| Status | legacy isOrdered/isArrived/isDelivered still present | derived qty states | retain legacy read compatibility; stop new business dependence |
| Purchasing | formal purchaseOrders + multi-item partial PO | generic supply records incl self-order/replenishment | add compatible supply layer |
| Self-order | not complete | sales/engineer can create restricted self-order with cost | add |
| Receipt | batch receipt/partial receipt exists | supply record -> receipt -> lot -> auto reservation | normalize itemId linkage |
| Dispatch paperwork | no authoritative qty-level stage | purchaser 待打單/已打單, then 可出貨 | add |
| Delivery | partial item delivery foundation | cannot exceed dispatchPrepared available qty; lot allocation | harden |
| Cancel/restore/return | legacy whole-order paths remain | item/qty-safe and idempotent | rewrite targeted mutations |
| Inventory cost | lot concepts exist but reporting still mixed | independent receipt batch cost, FEFO/FIFO COGS | port suitable PR26 logic |
| Search/filter | pagination exists; some root-only fields remain | all items searchable without loading history | rebuild tokens/index query |
| Product search | price/product data exists | fast server-bounded product+available inventory lookup | add |
| Price ownership | productCosts restrictions exist | product-line responsible sales/engineer maintenance | add role/line authorization |
| Users | role/salesCode/handoff foundation | editable role, active, product-line responsibilities | extend |
| Engineer | equipment-oriented and order read legacy | business + engineering capabilities | update UI + Rules |
| Analytics | bounded date query foundation | admin-only, delivered-date sales, lot COGS, hide cost toggle | revise |
| Dashboard | no V2 action dashboard | actionable counts/alerts | add after core |
| Performance | pagination/in-flight guards partly exist | every mutation immediate feedback; long jobs progress | enforce per phase |
| Tests | regression workflow + phase1 tests | V2 business invariants + rules tests | expand before main |

## PR #26 reuse candidates
Do not merge PR #26. Re-implement/cherry-pick concepts only after comparison with current main:
- transaction-safe order/reservation
- FEFO lot deduction
- delivery lotAllocations and reversal
- tighter role/ownership rules
- composite indexes
- Firestore emulator permission tests
- pagination/full-history-query fixes

## Legacy compatibility rule
Do not mass-delete root item fields or booleans in Phase A. New logic should use normalized items while keeping old records readable. Migration/backfill occurs only after core tests are green.


## 2026-09-21 branch re-audit
The table above is the original baseline, not the remaining-work list. PR #30 now implements the major V2 targets: multi-item order/copy, item reservations, formal/self/replenishment supply, partial receipt, dispatch gate, item delivery, exact lot reversal/return, bounded search, product-line authorization, engineer business capability, protected lot-cost analytics, dashboard, and expanded regression/rules tests.

Additional hardening completed after the baseline:
- legacy `isOrdered/isArrived` no longer presented as V2 workflow truth;
- Product Master first-load failures are retryable;
- warehouse creation has immediate feedback and permission-denied diagnostics;
- stock replenishment must use a warehouse PO path;
- partial batch receipt reports committed rows accurately instead of implying an atomic rollback;
- all multi-item orders require item-level delivery, including direct-ship orders;
- cancel/restore reservations are item-aware and aggregate repeated product/warehouse stock safely;
- delivery/return mutations have duplicate-submit guards; returns remain possible for goods delivered before cancellation;
- shared operational stock and lot documents reject embedded cost; admin retains migration-only access to legacy cost-bearing docs;
- legacy migration sanitizes inventory, warehouse stock, lots, receipts, movements, and embedded delivery/return allocation costs;
- backup now includes all governed top-level collections plus Forecast progress subcollections.

Remaining external gates are Firebase deployment/migration and manual desktop/mobile five-role acceptance. Do not merge main until those are complete.
