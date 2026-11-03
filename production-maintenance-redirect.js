'use strict';
// Client notice only. Database Rules and server gates enforce the actual freeze.
if (globalThis.YUSHIN_PRODUCTION_MAINTENANCE === true) {
    globalThis.location.replace(new URL('/yushin-system/maintenance.html', globalThis.location.href).href);
}
