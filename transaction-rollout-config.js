// Production transaction rollout settings. This file is loaded synchronously
// before app.js. This activation release must not merge without explicit
// production cutover approval; routine code merges must not enable writers.
// Enabling requires a separate reviewed release, matching server-side gate,
// verified asset versions, and an explicit production authorization.
(function (scope) {
    'use strict';
    const host = String(scope.location?.hostname || '').toLowerCase();
    const path = String(scope.location?.pathname || '');
    const orderReservationProductionSite = scope.location?.origin === 'https://sstonetw-source.github.io'
        && (path === '/yushin-system' || path.startsWith('/yushin-system/'));
    scope.YUSHIN_PRODUCTION_QUICK_PURCHASE_CONFIG_VERSION = '20261104-transaction-activation-1';
    // Authorized activation: match the deployed production backend and database retirement gates.
    // Overwrite stale global values; the caller must never inherit an unintended true gate.
    scope.YUSHIN_PRODUCTION_RECEIVING_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_RECEIVING_LEGACY_BLOCKED = orderReservationProductionSite;
    // Backend failure never revives the retired browser writer.
    scope.YUSHIN_PRODUCTION_CUSTOMER_RETURN_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_CUSTOMER_RETURN_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_CUSTOMER_RETURN_REQUEST_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_CUSTOMER_RETURN_REQUEST_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_DELIVERY_CONFIRMATION_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_DELIVERY_CONFIRMATION_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_DELIVERY_REVERSAL_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_DELIVERY_REVERSAL_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_DISPATCH_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_DISPATCH_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_SHIPMENT_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_SHIPMENT_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_ORDER_LIFECYCLE_BACKEND = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_ORDER_LIFECYCLE_LEGACY_BLOCKED = orderReservationProductionSite;
    scope.YUSHIN_PRODUCTION_FORMAL_PURCHASE = ['yu-shing-company.web.app','yu-shing-company.firebaseapp.com'].includes(host)
        || (host === 'sstonetw-source.github.io' && (path === '/yushin-system' || path.startsWith('/yushin-system/')));
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
