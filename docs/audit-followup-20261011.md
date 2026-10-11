# 2026-10-11 audit follow-up

Continue from the latest GitHub `main`. The original audit baseline was
`442ab0b`; its findings are not all current defects and must be rechecked.

## Implemented before this follow-up

- `4ab0402`: block ambiguous automatic product matches, align pending-purchase
  work-card quantities, preserve explicit zero costs and flag zero-cost analysis,
  restrict warehouse initial-stock cost creation, clarify several loading states,
  briefly reuse scoped work queues, and discover all Node regression tests in CI.
- `dc5eff5`: preserve explicit zero sales prices in work-card totals.
- `132fd54`: saved delivery defaults, customer address snapshots and grouped
  branch dispatch/transfer requirements.
- `e25603b`: retain delivery defaults after administrator personnel reload.

## This follow-up: A04 quantity and warehouse identity boundaries

- Inventory and warehouse stock writes reject reserved quantities greater than
  on-hand stock, and reject negative or nonnumeric incoming quantities.
- Warehouse stock creation requires product/location identities. Updates preserve
  productKey, warehouseId and an existing nonempty productId. Transfers move
  quantities between stock rows; they do not relabel a stock row.
- No queries, indexes, production records, role grants or frontend flows changed.
- Validation: 844 application regression tests and 78 Firestore emulator tests
  passed. Positive transfer, custody and delivery cases remain covered; negative
  create/update cases cover administrators, purchasing and warehouse users.
- The rules require a separate Firebase deployment. A GitHub publication does
  not deploy Firestore rules. Real-role production writes have not been tested.

## Next A04 increment: demand and reservation sources

- Sales-order demands and reservations now carry the source item position.
  Rules verify the order/item/product and owning salesperson against the
  transaction's resulting order, including an atomic warehouse change.
- Demand writes reject invalid quantities, inconsistent remaining quantities
  and statuses. Source identities cannot be relabelled. Cancellation preserves
  already ordered supply so a later receipt remains valid.
- Reservation writes reject nonexistent sources, excess quantities, incorrect
  warehouses and nonzero reservations on cancelled orders. The transaction
  wrapper derives ownership and item position for all operational roles, using
  the same order snapshot before committing writes.
- Validation: 846 application tests and 80 Firestore emulator tests passed.
  No production records were written. Authenticated production acceptance is
  still outstanding.
- Publish the updated frontend before manually deploying these Firestore
  rules. GitHub publication does not deploy rules. Existing active documents
  acquire source metadata through normal supported writes; no bulk repair ran.
- A04 remains partial: replenishment-source evidence and atomic stock/movement
  evidence for purchasing/warehouse reservation writes need a separate change.
  Valid source metadata alone does not prove a matching stock mutation.

## Remaining sequence

1. Finish A04 incrementally: source-operation evidence for
   purchasing/warehouse writes. Inspect each existing transaction
   before restricting it; preserve receipt, cancellation, return and transfer.
2. Recheck A01/A02 against current code. Existing duplicate records and production
   totals require read-only reconciliation; never delete or merge live records
   merely to make a test pass.
3. Finish A05/A12/A13 cost completeness and report-period clarity. Preserve the
   current document-date reporting basis unless the user requests another basis.
4. A06: measure scoped reads with synthetic data before introducing pagination or
   aggregates. A07 automatic Node test discovery is already implemented.
5. Recheck A08-A18 individually; remaining loading messages, terminology, order
   entry sequence, role-view caches and mobile layout need focused changes.

Production desktop/mobile and real-role acceptance remains incomplete because
the current verification browser has no authenticated application session.
