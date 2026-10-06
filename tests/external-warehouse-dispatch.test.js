const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root,'app.js'),'utf8');
const index = fs.readFileSync(path.join(root,'index.html'),'utf8');
const rules = fs.readFileSync(path.join(root,'firestore.rules'),'utf8');
const external = fs.readFileSync(path.join(root,'modules/external-warehouse-dispatch.js'),'utf8');

function body(start,end) {
    const a=external.indexOf(start), b=external.indexOf(end,a);
    assert.ok(a>=0&&b>a, 'external workflow section missing: '+start);
    return external.slice(a,b);
}

test('old warehouses remain internal, and only admin edits external warehouse type',()=>{
    assert.match(app,/function warehouseKind\(item\)/);
    assert.match(app,/warehouseType === 'EXTERNAL' \? 'EXTERNAL' : 'INTERNAL'/);
    assert.match(app,/const internal = warehouseMasterCache\.filter/);
    assert.match(app,/const editingId = String\(document\.getElementById\('warehouseMasterEditingId'\)/);
    assert.match(app,/if \(trueUserRole !== 'admin'\)/);
    assert.match(index,/id="warehouseMasterType"/);
    assert.match(index,/id="warehouseMasterEditingId"/);
});

test('external notices have a dedicated purchase/warehouse panel, old paperwork is internal only',()=>{
    assert.match(index,/id="externalWarehouseBody"/);
    assert.match(index,/id="externalWarehouseNoticeOverlay"/);
    assert.match(index,/modules\/external-warehouse-dispatch\.js\?v=/);
    assert.match(app,/window\.renderExternalWarehouseQueue\?\.\(\)/);
    assert.match(app,/if \(isExternalWarehouseId\(warehouseId\)\) return/);
    assert.match(app,/\['receiving','dispatch','completed'\]\.includes\(view\)/);
    assert.doesNotMatch(app.slice(app.indexOf('function renderPurchasingDispatchOrders'),app.indexOf('function pendingPurchaseLines')),/onclick="openWarehouseDispatchList/);
});

test('PDF generation is scoped and never changes stock or marks notice sent',()=>{
    const pdf=body('root.exportExternalWarehouseNotice = async function','root.markExternalWarehouseNotified = async function');
    assert.match(pdf,/addDocumentPagesToPdf\(pdf,pages,\{isolateRoot:stage/);
    assert.match(pdf,/DocumentDownloads\?\.savePdf/);
    assert.doesNotMatch(pdf,/tx\.update\(|tx\.set\(|runRoleTransaction\(/);
    assert.match(pdf,/尚未自動認定外倉收到通知/);
});

test('notification is explicit and idempotent; shipment uses atomic stock and order updates',()=>{
    const notice=body('root.markExternalWarehouseNotified = async function','root.confirmExternalWarehouseShipped = async function');
    assert.match(notice,/runRoleTransaction\(async tx/);
    assert.match(notice,/if \(snapshot\.exists\)/);
    assert.match(notice,/status:'NOTIFIED'/);
    assert.doesNotMatch(notice,/applyInventoryDeliveryDeltaInTransaction/);
    const shipped=external.slice(external.indexOf('root.confirmExternalWarehouseShipped = async function'));
    assert.match(shipped,/if \(notice\.status !== 'NOTIFIED'/);
    assert.match(shipped,/existingRecords\.some\(row=>row\.externalNoticeId===currentLine\.noticeId\)/);
    assert.match(shipped,/applyInventoryDeliveryDeltaInTransaction\(tx,itemOrder,qty,actor,draft\.orderId\)/);
    assert.match(shipped,/record\.movementId=stock\?\.movementId/);
    assert.match(shipped,/tx\.update\(orderRef,updates\)/);
    assert.match(shipped,/tx\.update\(noticeRef/);
    assert.match(shipped,/status:'SHIPPED'/);
});

test('Firestore Rules protect notice identity, role and shipment movement linkage',()=>{
    assert.match(rules,/match \/externalDispatchNotices\/\{id\}/);
    assert.match(rules,/allow create: if validExternalNoticeCreate\(id\)/);
    assert.match(rules,/allow update: if validExternalNoticeShipment\(id\)/);
    assert.match(rules,/allow delete: if false/);
    assert.match(rules,/id == orderId \+ '__' \+ data\.itemId/);
    assert.match(rules,/get\(whPath\)\.data\.get\('warehouseType', 'INTERNAL'\) == 'EXTERNAL'/);
    assert.match(rules,/getAfter\(movementPath\)\.data\.get\('type', ''\) == 'ship'/);
    assert.match(rules,/record\.get\('externalNoticeId', ''\) == id/);
    assert.match(rules,/externalWarehouseOrderShipmentUpdate\(id\)/);
});

test('sales order history can inspect external notice progress without stock changes',()=>{
    assert.ok(app.includes('viewExternalWarehouseStatus('));
    const view=body('root.viewExternalWarehouseStatus = async function','root.closeExternalWarehouseNotice = function');
    assert.ok(view.includes('loadWarehouseMaster()'));
    assert.ok(view.includes("db.collection('externalDispatchNotices')"));
    assert.ok(view.includes("notice?.status === 'SHIPPED'"));
    assert.ok(!view.includes('runRoleTransaction('));
    assert.ok(!view.includes('applyInventoryDeliveryDeltaInTransaction('));
});

test('external warehouse queue loads bounded notice history and warehouse identities',()=>{
    assert.ok(app.includes('loadRecentExternalWarehouseNotices?.()'));
    assert.ok(external.includes("orderBy('updatedAt', 'desc').limit(50)"));
    assert.ok(external.includes('root.renderExternalWarehouseQueue()'));
});
