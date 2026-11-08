'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const html = source('index.html');
const css = source('styles.css');

test('desktop account menu retains the signed-in controls and mobile navigation', () => {
    assert.match(html, /class="auth-menu-toggle btn-secondary"[^>]*aria-expanded="false"/);
    for (const id of ['authUserLabel','viewAsRoleSelect','authMenuContent']) {
        assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
    }
    for (const handler of ['switchViewRole(this.value)', 'openPersonalSettings()', 'handleLogout()']) {
        assert.ok(html.includes(handler), handler);
    }
    assert.match(css, /@media screen and \(min-width: 641px\)/);
    assert.match(css, /\.auth-status\.is-open \.auth-menu-content/);
    assert.match(css, /@media screen and \(max-width: 640px\)[\s\S]*?\.auth-menu-content/);
    assert.match(html, /class="mobile-nav-toggle"[^>]*aria-expanded="false"/);
    for (const page of ['quote','forecast','products','orders','purchasing','inventory','equipment','admin']) {
        assert.ok(html.includes(`data-main-nav="${page}"`), page);
    }
});

test('product row keeps common actions visible and gates extra actions by capability', () => {
    const code = source('src/features/products/product-management.js');
    const start = code.indexOf('function productManagementRow(');
    const end = code.indexOf('\n}\n', start) + 2;
    assert.ok(start !== -1 && end > start);
    const context = {
        resolveBrandName: value => value,
        isBrandPriceListActive: () => true,
        productManagementSelection: new Set(),
        canEditPage: () => true,
        escapeAttr: String,
        escapeHtml: String,
        inlineJsValue: JSON.stringify,
        canManagePendingProductMaster: () => true,
        canDeleteProductMaster: () => true
    };
    vm.runInNewContext(code.slice(start, end), context);
    const product = {productId:'P-1',productName:'Test',brandName:'Brand',listPrice:120,isFrequentlySold:true};
    const row = context.productManagementRow(product);
    const actionCell = row.split('<td data-th="操作"')[1];
    const direct = actionCell.split('<dialog')[0];
    assert.match(direct, /copyProductInformation/);
    assert.match(direct, /openProduct360/);
    assert.doesNotMatch(direct, /deleteProductMaster|openProductMasterEditor|setProductFrequentlySold/);
    assert.match(actionCell, /showModal\(\)/);
    assert.match(actionCell, /setProductFrequentlySold/);
    assert.match(actionCell, /openProductMasterEditor/);
    assert.match(actionCell, /deleteProductMaster/);
    assert.match(actionCell, /btn-danger/);
    context.canManagePendingProductMaster = () => false;
    context.canDeleteProductMaster = () => false;
    const viewerRow = context.productManagementRow(product);
    assert.doesNotMatch(viewerRow, /product-row-more-trigger|deleteProductMaster|openProductMasterEditor|setProductFrequentlySold/);
});

test('admin account actions are in a dialog while mobile cards retain their own controls', () => {
    const code = source('src/features/administration/user-and-system-settings.js');
    const start = code.indexOf('window.renderAdminSalesTable = function()');
    const end = code.indexOf('\n};', start) + 3;
    assert.ok(start !== -1 && end > start);
    const rows = [];
    const nodes = {
        adminSalesBody: {innerHTML:'',appendChild(row){rows.push(row)}},
        adminSalesCardList: {innerHTML:''}
    };
    const context = {
        window: {},
        document: {getElementById: id => nodes[id], createElement: () => ({innerHTML:''})},
        allUsersCache: [{uid:'uid123456',name:'Luke',code:'L',email:'test@example.com',role:'sales'}],
        escapeHtml: String,
        escapeAttr: String,
        inlineJsValue: JSON.stringify,
        ROLE_LABELS: {admin:'管理員',sales:'業務',purchaser:'採購',warehouse:'倉管',engineer:'工程師'}
    };
    vm.runInNewContext(code.slice(start, end), context);
    context.window.renderAdminSalesTable();
    assert.equal(rows.length, 1);
    assert.match(rows[0].innerHTML, /class="admin-account-dialog"/);
    assert.match(rows[0].innerHTML, /toggleMustChangePassword/);
    assert.match(rows[0].innerHTML, /sendPasswordResetToUser/);
    assert.match(rows[0].innerHTML, /copyAdminUserUid/);
    assert.match(nodes.adminSalesCardList.innerHTML, /toggleAdminUserCardPanel/);
});

test('purchase filtering is unified and wide tables scroll inside their panel', () => {
    assert.equal((html.match(/id="poListSearch"/g) || []).length, 1);
    const toolbar = html.split('id="purchaseFilterToolbar"')[1].split('</div>\n\n        <div class="panel no-print purchase-replenishment-panel"')[0];
    assert.match(toolbar, /id="poListSearch"/);
    assert.match(html, /class="table-wrap po-history-table-wrap"><table class="workflow-list-table"/);
    assert.match(css, /#poListPanel \.po-history-table-wrap \{[^}]*overflow-x: auto/);
    const view = source('src/features/purchasing/purchasing-workspace.js');
    assert.match(view, /historySearch\.hidden = !\['history','receiving'\]\.includes\(view\)/);
    assert.match(view, /workSearch\.hidden = !\['ordering','receiving','dispatch','completed'\]\.includes\(view\)/);
});

test('warehouse form labels and print documents keep their own layouts', () => {
    for (const id of ['warehouseMasterName','warehouseMasterContact','warehouseMasterPhone','warehouseMasterAddress','warehouseMasterType']) {
        assert.ok(html.includes(`for="${id}"`), id);
        assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
    }
    assert.match(css, /#admin-warehouses \.warehouse-master-form \{ display: grid/);
    assert.match(css, /#appContainer :is\(#product-system,#order-system,#purchasing-system,#inventory-system,#admin-system,#equipment-system\) \{ max-width: 1440px/);
    assert.doesNotMatch(css, /#printableQuote[^\n]*max-width: 1440px/);
    assert.match(css, /@media print\s*\{/);
});
