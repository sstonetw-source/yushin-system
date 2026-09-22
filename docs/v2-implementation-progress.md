# V2 Implementation Progress — 2026-09-21

## Active branch
upgrade/v2-fulfillment-20260920
Base main: 7cf91049ac3dee5b24b9560241d941f24e648c6e

## Implemented / in branch
- V2 capability-based Firestore Rules and indexes.
- Engineer = business + engineering capability.
- Firestore emulator role/workflow tests.
- Fulfillment quantity core module and tests.
- Supply core module and tests.
- Quantity normalization: ordered/reserved/shortage/supplyOrdered/received/dispatchPrepared/delivered/returned.
- Sales/engineer self-order flow with supplier, qty, actual unit cost, internal number and supplyOrders record.
- Purchaser dispatch gate: warehouse delivery requires dispatch-prepared quantity.
- Multi-item whole-order quick delivery is blocked; delivery must target an item.
- Item-level purchaser 待打單 action writes immutable dispatchRecords.
- Order work cards include 待打單 and 可出貨.
- CI syntax checks core modules and runs V2 fulfillment/supply tests.
- Long-write controls already use disabled/loading states in key modified paths.
- Formal purchase-order lines normalize into `supplyOrders`; receipts update the same records.
- Receipts and initial stock create authoritative `inventoryLots` with actual unit cost.
- Delivery and returns allocate/reverse exact lots and persist actual COGS.
- Manual orders and order copies preserve all line items.
- Product lookup, dashboard and inventory views use bounded queries.
- Personnel administration stores role, capability and responsible product lines.
- Product-line cost authorization supports both V2 `productLineId` and legacy `productLine`.
- Safety stock is editable through a narrowly scoped inventory rule.
- Business delivery can update only lot `remainingQty`; inventory movement ownership is persisted for Rules validation.

## Verification / release gates before main
- Automated Node regression suite: 117/117 passed on 2026-09-21.
- `node --check app.js`, core-module syntax checks and `git diff --check`: passed.
- Firestore emulator test cases, including scoped lot updates, safety stock and legacy product-line compatibility, passed in GitHub Actions run #307 on 2026-09-21.
- Full desktop/mobile five-role acceptance remains a deployment-environment task.
- Deploy Rules/Indexes only after manual acceptance; do not merge main from this implementation session.

## Concurrency note
This branch received concurrent V2 commits during implementation. Always refetch current blob SHA before every write and never force-update a stale file.

## 2026-09-21 Phase A receipt / lot update
- Formal PO receipt now creates authoritative inventoryLots + receipts with actual purchase unit cost.
- Supply self-order receipt and formal PO receipt converge on Inventory Lot as valuation source.
- Delivery transaction queries lots by productKey + warehouseId and allocates FEFO, FIFO fallback when no expiry.
- Delivery record persists lotAllocations and actual COGS.
- Warehouse delivery is blocked when no authoritative lot-cost record exists, preventing untraceable COGS.
- Added composite lot lookup index and FEFO/FIFO/COGS tests.
- Exact lot restoration, formal PO -> supplyOrders normalization and initial-stock lot creation are now implemented and covered by regression tests.

## 2026-09-21 chat continuation
- Audited Work-mode changes rather than replaying them.
- Fixed multi-item delivery deletion to reverse the removed item's product/warehouse/lot instead of top-level order product.
- Fixed return create/edit/delete to resolve the exact Order Item and validate against that item's delivered quantity.
- Removed an accidental purchaser-update clause from Forecast rules; dispatch permissions remain on Orders only.
- Added Rules regression coverage for Forecast isolation and warehouse receipt-scoped Order updates.

## 2026-09-21 cost-security audit
- Release blocker found during final audit: authoritative `inventoryLots` documents contain `unitCost` while the collection is readable by all active users.
- Hiding cost in the UI is insufficient because Firestore document reads expose all fields.
- Do **not** mark cost authorization acceptance complete until lot operational fields and protected lot cost are separated (or COGS is moved to a trusted backend).
- Current branch remains suitable for continued preview/testing, but this blocker must be resolved before merging to `main`.


## 2026-09-21 lot-cost isolation (#31)
- Split operational `inventoryLots` from protected `inventoryLotCosts`; new lot/receipt/movement writes no longer duplicate unit cost or COGS into business-readable operational collections.
- Formal purchasing cost is no longer readable merely because a sales/engineer user owns the customer order; own `SALES_SELF_ORDER` remains readable to its owner.
- Added admin-only paginated legacy cost-isolation migration UI. Run it before deploying the stricter Rules, then re-preview until legacy exposed-cost count is zero.
- Inventory analysis now joins operational lots/receipts to protected lot costs for purchase and stock valuation; incoming valuation remains derived from protected purchase orders.
- Historical COGS is reproducible by joining immutable delivery/return `lotAllocations` to protected `inventoryLotCosts`, without exposing cost to fulfillment users.
- Firestore emulator coverage proves sales/engineer/warehouse cannot read protected lot cost while admin/purchaser can; warehouse can create receipt cost without reading it back.
- CI run #393 passed syntax, regression, and Firestore Rules emulator after the isolation architecture landed. A later run validates historical COGS reconstruction.


## 2026-09-21 fulfillment hardening pass
- Batch receipt now reports partial commits accurately and refreshes PO/inventory before retry; missing warehouse blocks receipt.
- Every multi-item order, including direct ship, must use item-level delivery so later return/reversal has an unambiguous item.
- Delivery save/delete and return save/delete use duplicate-submit guards.
- Cancelled orders may still accept returns against goods physically delivered before cancellation.
- Cancel/restore reservation handling was rewritten item-by-item, retires legacy order-level reservation docs, and aggregates repeated product/warehouse stock state to avoid overwrite when two order lines share stock.
- Warehouse receipt permissions now match UI: warehouse can update only PO receipt workflow fields, not supplier/items/pricing.
- Shared inventory/warehouse stock/lot documents reject embedded cost; admin retains read access to legacy cost-bearing documents solely so the post-Rules migration can sanitize them.
- Corrected Firebase bootstrap sequence: full backup -> deploy migration-compatible Rules/Indexes -> admin migrations -> cost preview zero -> five-role acceptance.
- Legacy cost migration now also sanitizes warehouse stock and embedded order delivery/return allocation cost fields.

## 2026-09-22 order quick-start completion

- Added recent-order templates directly in the new-order modal.
- Added customer frequent-item suggestions derived from the bounded order cache.
- Added per-user local order drafts that survive modal close and page refresh, and clear only after a successful order save.
- Regression coverage increased from 142 to 144 tests.
- Added an admin-only read-only legacy-cost audit; it reports migration counts without exposing an execution button.
- Full backup coverage now matches governed collections and includes nested Forecast progress.
- CI #471 passed JavaScript syntax, 140 Node regression tests, and Firestore Rules emulator after these changes.
