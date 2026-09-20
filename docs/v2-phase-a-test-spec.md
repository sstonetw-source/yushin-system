# Phase A Test Specification

These tests are intentionally specified before implementation. Add executable tests alongside each targeted code change; do not create brittle tests that only assert source strings when behavior can be tested.

## Fulfillment quantities
1. ordered=20, available=8 -> reserved=8, shortage=12.
2. ordered=20, available=20 -> reserved=20, shortage=0.
3. ordered=20, available=0 -> reserved=0, shortage=20.
4. two items reserve independently.
5. partial receipt=5 against shortage12 -> received +5, reserved +5, shortage remaining7.
6. second receipt=7 -> shortage0.
7. repeated receipt operation with same idempotency key has no second effect.

## Supply
8. purchaser route starts not-ordered until actual supply/PO record exists.
9. sales self-order immediately contributes to supplyOrderedQty.
10. engineer self-order has same business capability.
11. stock replenishment has no orderId/itemId requirement and never creates customer dispatch task.
12. self-order requires qty, supplier and cost.

## Dispatch
13. reserved qty becomes purchaser pending-dispatch qty.
14. customer-visible shippable qty remains 0 before purchaser marks paperwork done.
15. mark paperwork qty8 -> dispatchPreparedQty +8 -> shippable8.
16. cannot mark more than ready/reserved unprepared qty.
17. duplicate mark action cannot double increment.

## Delivery
18. cannot deliver more than dispatchPrepared remaining qty.
19. delivery qty reduces onHand and reserved only at physical delivery.
20. partial delivery leaves remaining quantities independently active.
21. multi-item delivery affects only target itemId.
22. return affects target item/qty and creates traceable movement.

## Lots / cost
23. expiry lots allocate FEFO.
24. no-expiry lots allocate FIFO by receipt date.
25. delivery stores lotAllocations.
26. COGS is sum(qty * actual lot unitCost), not latest product master cost.
27. reversal restores exact allocated lots when applicable.

## Lifecycle
28. cancel releases only outstanding reserved quantities and is idempotent.
29. restore re-reserves available qty without double reservation.
30. billing toggles both directions and logs old/new/operator/time.

## Roles
31. sales can own Forecast/Quote/Order.
32. engineer can own Forecast/Quote/Order and use equipment functions.
33. purchaser can assist create quote/order only with responsible sales ownership.
34. warehouse cannot change commercial price/owner.
35. unauthorized sales/engineer cannot retrieve protected product cost.
36. admin can view all.

## Performance invariants
37. list loaders stay paginated.
38. full-history search does not perform unbounded collection get.
39. dashboard queries are bounded/filtered.
40. write actions have in-flight/idempotency protection.
41. long-running import/migration UI exposes progress or explicit processing state.
