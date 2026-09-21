# V2 Current Gap Inventory

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
