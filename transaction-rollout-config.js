// Production transaction rollout settings. This file is loaded synchronously
// before app.js; merging code must never enable a live transaction writer.
// Enabling requires a separate reviewed release, matching server-side gate,
// verified asset versions, and an explicit production authorization.
(function (scope) {
    'use strict';
    scope.YUSHIN_PRODUCTION_QUICK_PURCHASE_CONFIG_VERSION = '20261031-order-res-1';
    scope.YUSHIN_PRODUCTION_QUICK_PURCHASE = false;
    const host = String(scope.location?.hostname || '').toLowerCase();
    const path = String(scope.location?.pathname || '');
    scope.YUSHIN_PRODUCTION_FORMAL_PURCHASE = ['yu-shing-company.web.app','yu-shing-company.firebaseapp.com'].includes(host)
        || (host === 'sstonetw-source.github.io' && (path === '/yushin-system' || path.startsWith('/yushin-system/')));
    // #311 approved cutover: the deployed backend has independent server gates.
    // Only the approved HTTPS GitHub Pages origin and repository path may enable it.
    const orderReservationProductionSite = scope.location?.origin === 'https://sstonetw-source.github.io'
        && (path === '/yushin-system' || path.startsWith('/yushin-system/'));
    scope.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND = orderReservationProductionSite;
    // Once an approved cutover sets this true it must never be rolled back to
    // false; an outage then blocks submission instead of reviving the SDK writer.
    scope.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED = orderReservationProductionSite;
})(globalThis);
