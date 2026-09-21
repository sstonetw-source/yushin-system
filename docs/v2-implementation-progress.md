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

## Still required before main
- Complete purchaser formal PO -> generic supplyOrders linkage.
- Receipt -> inventoryLots independent cost records.
- Auto-fill reservations after partial receipt.
- FEFO/FIFO allocation integrated into actual delivery transaction and lotAllocations/COGS persistence.
- Cancel/restore/return exact item+lot reversal.
- Remove remaining legacy manual isOrdered/isArrived buttons.
- True multi-item manual order editor and full multi-item copy.
- Server-bounded Product Master/price/inventory quick search (no full catalog load).
- Product-line responsibility + price import preview/history.
- Personnel UI capability/product-line fields.
- Dashboard and admin-only 進銷存.
- Safety stock.
- Performance sweep for remaining unbounded queries (notably Product Master overlay/equipment).
- Full desktop/mobile five-role acceptance.
- Only after green tests: deploy Rules/Indexes and merge main.

## Concurrency note
This branch received concurrent V2 commits during implementation. Always refetch current blob SHA before every write and never force-update a stale file.

## 2026-09-21 Phase A receipt / lot update
- Formal PO receipt now creates authoritative inventoryLots + receipts with actual purchase unit cost.
- Supply self-order receipt and formal PO receipt converge on Inventory Lot as valuation source.
- Delivery transaction queries lots by productKey + warehouseId and allocates FEFO, FIFO fallback when no expiry.
- Delivery record persists lotAllocations and actual COGS.
- Warehouse delivery is blocked when no authoritative lot-cost record exists, preventing untraceable COGS.
- Added composite lot lookup index and FEFO/FIFO/COGS tests.
- Remaining high-priority integrity work: exact lot restoration for edited/deleted partial delivery and returns; formal PO -> supplyOrders normalization; initial-stock lot creation.
