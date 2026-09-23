# Phase 0 / Phase 1 Gap Analysis — 2026-09-23

Branch: `upgrade/system-control-phase0-phase1-20260923`
Baseline main: `7e7c955503ddc0136872ffc2f4466a212ecfe6e0`

## Findings

### C — must keep / already provides target architecture
- `modules/fulfillment-core.js`: item-level reservation, receipt, dispatch, delivery and return quantities.
- `modules/supply-core.js`: formal source types `PURCHASING_PO`, `SALES_SELF_ORDER`, `STOCK_REPLENISHMENT`, partial receipt, lot allocation and reversal.
- `modules/workflow-core.js`: stock / standard purchase / peer transfer allocation and controlled advance-to-customer release.
- Firestore rules already separate commercial ownership (`ownerUid` / `salesCode`) from purchaser and warehouse workflow permissions.
- Firestore collections already include `purchaseOrders`, `supplyOrders`, `inventoryReservations`, `receipts`, `dispatchRecords`, `deliveries`, `inventoryMovements` and audit logs.
- Order and quote history already use 50-row pagination and backend `searchTokens` full-history search.
- Existing tests cover rules plus fulfillment, reservation, supply and workflow cores.

### B — compatibility / migration-sensitive
- Legacy order booleans `isOrdered`, `isArrived`, `isDelivered`, `isBilled` still exist in new-order records. Do not remove until all render/update paths and historical documents are verified.
- Legacy commercial ownership is represented by `ownerUid` + `salesCode` + `salesName`. Keep as authoritative compatibility fields while adding creator metadata.
- Order-level `status` remains in use beside item-level workflow quantities. Do not replace it wholesale with a second state machine.
- Existing `purchaseStatus` is already updated when formal purchase orders are created. Preserve this behavior.

### A — safe removal candidates
No code is approved for deletion yet. The current pass found compatibility-sensitive workflow code, so deletion requires call-site and UI verification first.

## Phase 1 actual gaps

1. Creator vs owner metadata is incomplete on primary commercial documents.
   - Quotes select a responsible salesperson and persist `salesName`, `salesCode`, `ownerUid`, but do not consistently persist creator identity/role.
   - New orders persist the current salesperson as owner, but do not consistently persist creator identity/role.
   - Forecast progress has creator metadata, while the forecast root record does not consistently carry it.
2. The existing architecture should be extended, not replaced.
   - Do not introduce a parallel `salesOwner` state machine that conflicts with `ownerUid` / `salesCode`.
   - If a display/API alias is needed later, derive it from the existing ownership fields.
3. Before enabling assisted order creation, UI selection of responsible salesperson must be checked; quote creation already supports selecting the responsible salesperson.
4. Firestore Rules must preserve immutable ownership during normal edits while allowing purchaser/engineer assisted commercial-document creation under the existing scoped rules.

## Next implementation slice

Small, backward-compatible change:
- Add `createdByUid`, `createdByName`, `createdByRole` to newly created quote / forecast / order root documents.
- Preserve `ownerUid`, `salesCode`, `salesName` as commercial ownership.
- Do not migrate or rewrite historical records in this slice.
- Add/adjust tests before any legacy-field cleanup.
