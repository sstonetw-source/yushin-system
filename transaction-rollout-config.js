// Production transaction rollout settings. This file is loaded synchronously
// before app.js; merging code must never enable a live transaction writer.
// Enabling requires a separate reviewed release, matching server-side gate,
// verified asset versions, and an explicit production authorization.
(function (scope) {
    'use strict';
    scope.YUSHIN_PRODUCTION_QUICK_PURCHASE_CONFIG_VERSION = '20261030-1';
    scope.YUSHIN_PRODUCTION_QUICK_PURCHASE = false;
    // #311: safe-by-default authority switch for whole-order reservations.
    // Production activation requires a separate approved backend gate and release.
    scope.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND = false;
    // Once an approved cutover sets this true it must never be rolled back to
    // false; an outage then blocks submission instead of reviving the SDK writer.
    scope.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED = false;
})(globalThis);
