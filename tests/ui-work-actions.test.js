'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/shared/action-feedback.js'), 'utf8');

function makeWorkspace() {
    const nodes = new Map();
    const document = {
        getElementById: id => nodes.get(id) || null,
        createElement: tag => ({
            tagName: tag.toUpperCase(), children: [], hidden: false,
            setAttribute(name, value) { this[name] = value; },
            appendChild(child) { this.children.push(child); },
            replaceChildren(...children) { this.children = children; }
        }),
        body: {
            appendChild(element) { nodes.set(element.id, element); }
        }
    };
    const context = vm.createContext({
        document, currentUser: { uid:'user-a' }, currentUserRole:'purchaser',
        console: { warn() {} }
    });
    vm.runInContext(source, context);
    const api = vm.runInContext('({ beginUiWorkAction, uiWorkActionPending, uiWorkResultUncertain, clearUiWorkActions, renderUiWorkActions })', context);
    return { context, api, nodes };
}

test('a confirmed click immediately hides the pending row and shows one non-blocking job', () => {
    const { api, nodes } = makeWorkspace();
    let renders = 0;
    const action = api.beginUiWorkAction('purchase-item', 'order-a::item-1', '確認採購', () => { renders++; });
    assert.ok(action);
    assert.equal(api.uiWorkActionPending('purchase-item', 'order-a::item-1'), true);
    assert.equal(renders, 1);
    assert.equal(nodes.get('uiWorkActionStatus').hidden, false);
    assert.match(nodes.get('uiWorkActionStatus').children[0].textContent, /背景處理中 1 筆/);
    assert.equal(api.beginUiWorkAction('purchase-item', 'order-a::item-1', '重複採購'), null);
    action.finish('success');
    assert.equal(api.uiWorkActionPending('purchase-item', 'order-a::item-1'), false);
    assert.equal(nodes.get('uiWorkActionStatus').hidden, true);
    assert.equal(renders, 2);
});

test('a definite failure restores the row, and a lost reply remains explicitly unknown', () => {
    const { api, nodes } = makeWorkspace();
    const failed = api.beginUiWorkAction('product-status', 'p-1', '停用產品');
    failed.finish('failure');
    assert.equal(api.uiWorkActionPending('product-status', 'p-1'), false);
    const uncertain = api.beginUiWorkAction('warehouse-parcel', 'task-1', '寄貨確認');
    uncertain.finish('unknown');
    assert.equal(api.uiWorkActionPending('warehouse-parcel', 'task-1'), true);
    assert.match(nodes.get('uiWorkActionStatus').children[0].textContent, /待確認 1 筆/);
    assert.equal(api.beginUiWorkAction('warehouse-parcel', 'task-1', '重送'), null);
    const retry = api.beginUiWorkAction('warehouse-parcel', 'task-1', '原憑證核對', null, { resume:true });
    assert.ok(retry);
    retry.finish('success');
    assert.equal(api.uiWorkActionPending('warehouse-parcel', 'task-1'), false);
});

test('unknown result offers only explicit original-operation verification', () => {
    const { api, nodes } = makeWorkspace();
    let verifications = 0;
    const task = api.beginUiWorkAction('inventory-archive', 'i-1', '移出庫存', null,
        { onVerify: () => { verifications++; } });
    assert.equal(nodes.get('uiWorkActionStatus').children.filter(node => node.tagName === 'BUTTON').length, 0);
    task.finish('unknown');
    const button = nodes.get('uiWorkActionStatus').children.find(node => node.tagName === 'BUTTON');
    assert.equal(button.textContent, '核對原操作憑證');
    button.onclick();
    assert.equal(verifications, 1);
    assert.equal(api.beginUiWorkAction('inventory-archive', 'i-1', '全新移出操作'), null);
    const retry = api.beginUiWorkAction('inventory-archive', 'i-1', '核對原移出', null, { resume:true });
    assert.ok(retry);
    retry.finish('success');
});

test('the optimistic overlay is actor scoped and cannot repaint a different role', () => {
    const { api, context, nodes } = makeWorkspace();
    let renders = 0;
    const action = api.beginUiWorkAction('order-lifecycle', 'o-1', '取消訂單', () => { renders++; });
    context.currentUserRole = 'warehouse';
    assert.equal(api.uiWorkActionPending('order-lifecycle', 'o-1'), false);
    api.renderUiWorkActions();
    assert.equal(nodes.get('uiWorkActionStatus').hidden, true);
    action.finish('success');
    assert.equal(renders, 1);
    context.currentUserRole = 'purchaser';
    assert.equal(api.uiWorkActionPending('order-lifecycle', 'o-1'), false);
});

test('sign-out clears presentation tasks without allowing a late async callback to repaint', () => {
    const { api, nodes } = makeWorkspace();
    const task = api.beginUiWorkAction('product-status', 'p-2', '停用產品');
    api.clearUiWorkActions();
    assert.equal(api.uiWorkActionPending('product-status', 'p-2'), false);
    assert.equal(nodes.get('uiWorkActionStatus').hidden, true);
    task.finish('unknown');
    assert.equal(nodes.get('uiWorkActionStatus').hidden, true);
});

test('network ambiguity differs from a server rejection', () => {
    const { api } = makeWorkspace();
    assert.equal(api.uiWorkResultUncertain({ code:'unavailable' }), true);
    assert.equal(api.uiWorkResultUncertain({ code:'deadline-exceeded' }), true);
    assert.equal(api.uiWorkResultUncertain({ message:'連線中斷' }), true);
    assert.equal(api.uiWorkResultUncertain({ code:'permission-denied' }), false);
    assert.equal(api.uiWorkResultUncertain({ code:'failed-precondition' }), false);
    assert.equal(api.uiWorkResultUncertain({ code:'functions/permission-denied' }), false);
    assert.equal(api.uiWorkResultUncertain(new Error('lost reply')), true);
});

test('work-list integrations use UI overlays but keep their original commit services', () => {
    const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source('src/features/orders/lifecycle-workspace.js'), /beginUiWorkAction\('order-lifecycle'/);
    assert.match(source('src/features/orders/service-order-actions.js'), /beginUiWorkAction\('service-work'/);
    assert.match(source('src/features/purchasing/purchasing-workspace.js'), /uiWorkActionPending\('purchase-item'/);
    assert.match(source('src/features/inventory/inventory-workspace.js'), /uiWorkActionPending\('inventory-archive'/);
    assert.match(source('src/features/products/product-management.js'), /uiWorkActionPending\('product-status'/);
    assert.match(source('src/features/equipment/equipment-workspace.js'), /uiWorkActionPending\('equipment-disable'/);
    assert.match(source('src/features/purchasing/receiving-workspace.js'), /function receiptTaskInFlight/);
    assert.match(source('modules/inventory-workspace.js'), /receiptTaskInFlight\(s\.id\)/);
    assert.match(source('modules/warehouse-parcels.js'), /beginUiWorkAction\('warehouse-parcel'/);
    assert.match(source('modules/warehouse-parcels.js'), /root\.commitWarehouseParcelJob/);
});
