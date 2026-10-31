'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const bridge=fs.readFileSync('src/services/grouped-reservation.js','utf8');
const entry=fs.readFileSync('src/services/order-reservation.js','utf8');

test('deprecated grouped initial reservation and per-item fallback are absent',()=>{
 assert.doesNotMatch(bridge,/initialGroupedReservationCandidates|commitInitialGroupedReservationPreview/);
 assert.doesNotMatch(bridge,/groupedReservationPreviewCallable|sameWarehouseReservationPreviewEnabled/);
 assert.doesNotMatch(entry,/reserveSingleOrderItem|commitInitialGroupedReservationPreview/);
});
test('retired grouped preview flags do not route any new-order inventory writes',()=>{
 assert.doesNotMatch(bridge,/YUSHIN_PREVIEW_GROUPED_RESERVATION/);
 assert.doesNotMatch(bridge,/YUSHIN_PREVIEW_SAME_WAREHOUSE_RESERVATION/);
 assert.doesNotMatch(bridge,/commitGroupedWarehouseReservation/);
});
test('frontend initial adapter uses only authenticated whole-order callable identity',()=>{
 assert.match(bridge,/httpsCallable\('commitOrderReservationPreview'\)/);
 assert.match(bridge,/await callable\(\{orderId,syncAttemptId\}\)/);
 assert.match(bridge,/receiptId!=='order-sync-'\+orderId\+'__'\+syncAttemptId/);
 assert.doesNotMatch(bridge,/db\.collection\(|runRoleTransaction\(|batch\.commit\(/);
});
test('all environments refuse initial stock writes without the whole-order backend gate',()=>{
 assert.match(entry,/if\(typeof orderReservationBackendEnabled!=='function'\|\|!orderReservationBackendEnabled\(\)\)/);
 assert.match(entry,/舊版逐筆 SDK 寫入已停用/);
 assert.doesNotMatch(entry,/await loadWarehouseMaster\(true\)/);
});
test('the backend gate still has explicit production project and separate flags',()=>{
 assert.match(bridge,/YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND === true/);
 assert.match(bridge,/YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED === true/);
 assert.match(bridge,/projectId === 'yu-shing-company'/);
});
test('only the whole-order bridge is loaded before the order service',()=>{
 const build=fs.readFileSync('tools/build-app.cjs','utf8');
 assert.ok(build.indexOf('src/services/grouped-reservation.js')<build.indexOf('src/services/order-reservation.js'));
 assert.equal((entry.match(/await commitNewOrderReservationPreview\(/g)||[]).length,1);
});
