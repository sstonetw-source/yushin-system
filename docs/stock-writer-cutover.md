# Stock writer cutover — production Rules published; employee entry still closed

**Production observation (2026-11-11, Asia/Taipei):** Firebase Console for
`yu-shing-company` / `(default)` shows Rules last published at 08:08. The live
Rules editor begins with `BACKEND-ONLY STOCK WRITER CUTOVER`, and all eight
observed `settings/*Cutover.backendOnly` flags (`orderTransfer`, `purchasing`,
`receiving`, `dispatch`, `shipment`, `delivery`, `return`, `lifecycle`) are `true`.
This is a read-only console observation, **not** a verified byte-for-byte
comparison of the deployed Rules with the current GitHub file.

The repository's active Firebase Rules deployment input is now
`release-candidates/firestore.backend-only-stock.rules` (see `firebase.json`);
`firestore.rules` is the generator's baseline. Do not add a dynamic
per-document `exists()`/`get()` flag to the hot inventory path: a valid
five-reservation Firestore batch already approaches the 1,000-expression limit.

These Rules gates are **not** Cloud Functions' independent `ENABLE_PRODUCTION_*`
execution flags. On 2026-11-11, self-order, supplier cancellation, main-warehouse
transfers, manual inventory, and inventory count still had production execution
flags set to `false` in the source deployment configuration. Deployed function
names and Rules gates alone do not make these workflows usable. Employee entry
still requires separate D approval.

## One-time Rules artifact

Run `node tools/build-stock-cutover-rules.cjs --check` to validate that all
expected ledger matches exist. For a **future authorized Rules update**,
verify the generated backend-only Rules against the reviewed `main` commit:

```sh
node tools/build-stock-cutover-rules.cjs --stdout
```

The output is a deployment input, **not a second application writer or a
fallback**. No GitHub Actions workflow automatically deploys it. Do not
redeploy the already-published Rules as an automatic next step. Any future
change requires a separately approved B scope, a review of the generated
output and source commit, and verification of the resolved Firebase
project/database. Do not use Firebase Hosting or a Hosting preview channel.

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
   (B) any new Firebase backend deployment (including future Rules changes),
   (C) any new production data cleanup, and (D) transaction entry cutover.
   The previously authorized 15-collection/229-document C cleanup completed
   on 2026-11-11; do not repeat it.
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

This documentation correction does **not** deploy Functions or Rules, alter
production data/flags, establish opening stock, or switch the employee entry.
Luke elected to create opening stock only after the system is ready.
