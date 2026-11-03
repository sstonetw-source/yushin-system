// Production transaction rollout settings. This file is loaded synchronously
// before app.js. This activation release must not merge without explicit
// production cutover approval; routine code merges must not enable writers.
// Enabling requires a separate reviewed release, matching server-side gate,
// verified asset versions, and an explicit production authorization.
(function (scope) {
    'use strict';
    scope.YUSHIN_PRODUCTION_QUICK_PURCHASE_CONFIG_VERSION = '20261102-qp-activation-1';
    // Prepared only: a separately authorized release must enable both sides.
    scope.YUSHIN_PRODUCTION_DELIVERY_CONFIRMATION_BACKEND = false;
    scope.YUSHIN_PRODUCTION_DELIVERY_CONFIRMATION_LEGACY_BLOCKED = false;
    scope.YUSHIN_PRODUCTION_DELIVERY_REVERSAL_BACKEND = false;
    scope.YUSHIN_PRODUCTION_DELIVERY_REVERSAL_LEGACY_BLOCKED = false;
    scope.YUSHIN_PRODUCTION_DISPATCH_BACKEND = false;
    scope.YUSHIN_PRODUCTION_DISPATCH_LEGACY_BLOCKED = false;
    scope.YUSHIN_PRODUCTION_SHIPMENT_BACKEND = false;
    scope.YUSHIN_PRODUCTION_SHIPMENT_LEGACY_BLOCKED = false;
    scope.YUSHIN_PRODUCTION_ORDER_LIFECYCLE_BACKEND = false;
    scope.YUSHIN_PRODUCTION_ORDER_LIFECYCLE_LEGACY_BLOCKED = false;
    const host = String(scope.location?.hostname || '').toLowerCase();
    const path = String(scope.location?.pathname || '');
    scope.YUSHIN_PRODUCTION_FORMAL_PURCHASE = ['yu-shing-company.web.app','yu-shing-company.firebaseapp.com'].includes(host)
        || (host === 'sstonetw-source.github.io' && (path === '/yushin-system' || path.startsWith('/yushin-system/')));
    // #311 approved cutover: the deployed backend has independent server gates.
    // Only the approved HTTPS GitHub Pages origin and repository path may enable it.
    const orderReservationProductionSite = scope.location?.origin === 'https://sstonetw-source.github.io'
        && (path === '/yushin-system' || path.startsWith('/yushin-system/'));
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
