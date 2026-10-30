// Production transaction rollout settings. This file is loaded synchronously
// before app.js; merging code must never enable a live transaction writer.
// Enabling requires a separate reviewed release, matching server-side gate,
// verified asset versions, and an explicit production authorization.
(function (scope) {
    'use strict';
    scope.YUSHIN_PRODUCTION_QUICK_PURCHASE_CONFIG_VERSION = '20261030-po-1';
    scope.YUSHIN_PRODUCTION_QUICK_PURCHASE = false;
    scope.YUSHIN_PRODUCTION_FORMAL_PURCHASE = true;
})(globalThis);
