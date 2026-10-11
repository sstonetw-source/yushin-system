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

## Remaining sequence

1. Finish A04 incrementally: demand/reservation identity and source-operation
   evidence for purchasing/warehouse writes. Inspect each existing transaction
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
