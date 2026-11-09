# Stock writer cutover — staged; not deployed

This repository contains **one active source Rules file**, `firestore.rules`. Its
existing validation remains unchanged until a separately approved maintenance
cutover. Do not add a dynamic per-document `exists()`/`get()` flag to this file:
the valid five-reservation Firestore batch already approaches the platform's
1,000-expression request ceiling.

## One-time Rules artifact

Run `node tools/build-stock-cutover-rules.cjs --check` to validate that all
expected ledger matches exist. When the **production Rules deployment and
transaction cutover have each received specific approval**, generate the
backend-only Rules body from the reviewed `main` commit:

```sh
node tools/build-stock-cutover-rules.cjs --stdout
```

The output is a deployment input, **not a second application writer or a
fallback**. No GitHub Actions workflow automatically deploys it. The operator
must review the generated output, its source commit, and the resolved Firebase
project/database before supplying it to the approved Rules release mechanism.
Do not use Firebase Hosting or a Hosting preview channel.

The cutover output rejects all browser create/update/delete operations that
formerly mutated `stockTransferRequests`, `stockTransfers`, `inventory`,
`warehouseStocks`, `inventoryReservations`, `inventoryLots`,
`inventoryLotCosts`, `inventoryMovements`, and `stockOperations`. It preserves
existing reads and `inventory` planning/archive-only edits, with their
existing role/validation checks. Trusted Admin SDK backend operations bypass
client Firestore Rules; they must independently enforce authorization,
idempotency, concurrency, and inventory invariants.

**Important:** this is an intermediate protection for the stock ledgers, not
proof that all transaction endpoints have migrated. Order, purchasing,
receiving, fulfillment, return, and delivery writers and corresponding
feature flags must be audited separately before end-to-end cutover. A
front-end-only change cannot stop old cached clients; a deployed Rules
rejection can. Existing legacy clients might receive `permission-denied`;
do not restore their stock writer to conceal that failure.

## Approval and maintenance checklist

1. Identify the exact Firebase project, Firestore database, current deployed
   Rules hash, Functions inventory, non-Hosting frontend release, and latest
   `main` commit. Verify there are no in-flight operations.
2. Obtain **separate** approvals for (A) non-Hosting frontend publishing,
   (B) Firebase backend deployment (including these Rules), (C) exact
   production transaction data cleanup, and (D) transaction entry cutover.
3. Arrange the approved maintenance window and disable legacy transaction
   writes server-side **before** any transaction-data cleanup. Confirm old
   browser, installed web-app, and mobile shortcuts fail closed.
4. Run emulator integration tests for the generated Rules, verify permissions
   for real roles, and verify that each trusted transaction endpoint is live.
   Record the test run and reviewed source/Rules SHA.
5. Deploy only to the approved project/database and verify the live Rules
   release hash. Never run a Firebase Hosting deploy.
6. Independently inventory every target collection/subcollection and document
   count, retain nontransaction master data, and follow the approved cleanup
   and opening-stock initialization checklist.
7. Exercise end-to-end order/reservation/purchase/receipt/dispatch/delivery/
   cancellation/return, duplicate/concurrent/failure recovery, and reconcile
   company and warehouse stocks before enabling staff transactions.
8. If a check fails, **keep old browser writers blocked** and staff writes
   paused. Fix the backend and reverify; never fall back to legacy stock
   mutation Rules or a second writer.

Production Rules/Functions deployment, production data deletion, and entry
switching were **not performed** by this change.
