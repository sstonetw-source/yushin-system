// Production transaction rollout settings. This file is loaded synchronously
// before app.js. This activation release must not merge without explicit
// production cutover approval; routine code merges must not enable writers.
// Enabling requires a separate reviewed release, matching server-side gate,
// verified asset versions, and an explicit production authorization.
(function (scope) {
    'use strict';
    const path = String(scope.location?.pathname || '');
    const orderReservationProductionSite = scope.location?.origin === 'https://sstonetw-source.github.io'
        && (path === '/yushin-system' || path.startsWith('/yushin-system/'));
    // The service workflow release requires Rules and Functions to be published first.
    scope.YUSHIN_PRODUCTION_SERVICE_CASE_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_QUICK_PURCHASE_CONFIG_VERSION = '20261112-full-backend-cutover-1';
    // Authorized activation: match the deployed production backend and database retirement gates.
    // Overwrite stale global values; the caller must never inherit an unintended true gate.
    scope.YUSHIN_PRODUCTION_RECEIVING_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_RECEIVING_LEGACY_BLOCKED = orderReservationProductionSite;
    // Backend failure never revives the retired browser writer.
    scope.YUSHIN_PRODUCTION_CUSTOMER_RETURN_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_CUSTOMER_RETURN_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_CUSTOMER_RETURN_REQUEST_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_CUSTOMER_RETURN_REQUEST_LEGACY_BLOCKED = orderReservationProductionSite;
    // Authorized production cutover. Each Callable has its own server gate,
    // identity/role validation and idempotency checks; never restore old writers.
    scope.YUSHIN_PRODUCTION_CANCELLED_PURCHASE_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_CANCELLED_PURCHASE_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_SUPPLY_CANCELLATION_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_SUPPLY_CANCELLATION_LEGACY_BLOCKED = orderReservationProductionSite;
    // Each main-transfer stage has its own backend gate and original operation ID.
    scope.YUSHIN_PRODUCTION_MAIN_TRANSFER_REQUEST_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_MAIN_TRANSFER_REQUEST_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_MAIN_TRANSFER_DISPATCH_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_MAIN_TRANSFER_DISPATCH_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_MAIN_TRANSFER_RECEIPT_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_MAIN_TRANSFER_RECEIPT_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_MAIN_TRANSFER_ALLOCATION_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_MAIN_TRANSFER_ALLOCATION_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_MANUAL_INVENTORY_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_MANUAL_INVENTORY_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_INVENTORY_COUNT_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_INVENTORY_COUNT_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_DELIVERY_CONFIRMATION_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_DELIVERY_CONFIRMATION_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_DELIVERY_REVERSAL_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_DELIVERY_REVERSAL_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_DISPATCH_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_DISPATCH_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_SHIPMENT_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_SHIPMENT_LEGACY_BLOCKED = orderReservationProductionSite;
    // Physical transfer/handoff remain role-checked by the production Callable.
    scope.YUSHIN_PRODUCTION_ORDER_TRANSFER_DISPATCH_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_ORDER_TRANSFER_DISPATCH_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_ORDER_TRANSFER_HANDOFF_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_ORDER_TRANSFER_HANDOFF_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_ORDER_TRANSFER_RECEIVE_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_ORDER_TRANSFER_RECEIVE_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_ORDER_LIFECYCLE_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_ORDER_LIFECYCLE_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_FORMAL_PURCHASE = orderReservationProductionSite;
    // Self-order uses a separate role-specific backend; sales/engineers must
    // not gain purchasing privileges through this activation.
    scope.YUSHIN_PRODUCTION_SELF_ORDER = orderReservationProductionSite;
    // #311 approved cutover: the deployed backend has independent server gates.
    // Only the approved HTTPS GitHub Pages origin and repository path may enable it.
    // #268 activation candidate: the independent server gate is already deployed.
    // Both settings are restricted to the same exact HTTPS production site.
    scope.YUSHIN_PRODUCTION_QUICK_PURCHASE = orderReservationProductionSite;
    // Retain this lock after cutover, including when suspending the quick route.
    scope.YUSHIN_PRODUCTION_QUICK_PURCHASE_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND = orderReservationProductionSite;
    // Once an approved cutover sets this true it must never be rolled back to
    // false; an outage then blocks submission instead of reviving the SDK writer.
    scope.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED = orderReservationProductionSite;
})(globalThis);
