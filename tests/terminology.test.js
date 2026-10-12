const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const html = read('index.html');
const app = read('app.js');

test('retired UI wording stays out of HTML and dynamic modules, preserving legacy import recognition', () => {
    const names = ['index.html', 'app.js', ...fs.readdirSync(path.join(__dirname, '../modules')).filter(n => n.endsWith('.js')).map(n => `modules/${n}`)];
    for (const name of names) {
        const source = read(name).split('\n').filter(line => !/^\s*(\/\/|\/\*|\*|<!--)/.test(line) && !line.includes('fallbackBrand') && !line.includes('Firebase 儲存空間')).join('\n');
        assert.doesNotMatch(source, /訂購狀態|訂購日期|訂貨方式|交由採購訂貨|交由採購處理|占用|Product Master|價格表|批量/, name);
    }
    assert.match(app, /\^\(Product Master\|Product Import\|又鑫_Product_Import\)/);
    assert.match(html, /不會占用 Firebase 儲存空間/);
});

test('desktop headers and mobile labels share reservation wording and manual stock names', () => {
    assert.match(html, /<th>已預留<\/th>/);
    assert.match(app, /data-th="已預留"/);
    assert.match(html, /<th>預留數量<\/th>/);
    assert.match(html, /＋ 手動新增庫存/);
    assert.match(html, /value="initial">手動新增庫存（含期初庫存）/);
    const fn = app.match(/function inventoryAdjustmentTitle\(type\) \{[^\n]+/)[0];
    const context = vm.createContext({});
    vm.runInContext(fn, context);
    assert.equal(context.inventoryAdjustmentTitle('initial'), '手動新增庫存');
    assert.equal(context.inventoryAdjustmentTitle('scrap'), '報廢');
    assert.match(app, /又鑫_庫存批次匯入範本\.xlsx/);
    assert.match(html, /<label>採購方式<\/label>/);
    assert.match(html, /<th>採購日期<\/th>/);
    assert.match(app, /採購日期：\$\{escapeHtml\(value\('poDate'\)\)\}/);
});

test('help assigns printing to administration while keeping shipment, delivery and receiving distinct', () => {
    assert.match(html, /待行政打單的倉庫出貨品項；行政完成打單後，由倉庫辦理出貨/);
    assert.match(html, /採購端作業已完成的品項：倉庫品項已由行政完成打單，原廠直送品項已確認到貨/);
    assert.doesNotMatch(html + app, /倉庫待打單品項|採購端已完成打單|公司倉打單仍由採購/);
    const source = read('modules/page-help.js');
    assert.match(source, /行政打單、倉庫出貨、業務送貨/);
    assert.match(source, /實際點收後才入庫/);
    assert.match(source, /寄給業務後仍須登記送達客戶/);
    assert.match(read('modules/warehouse-logistics.js'), /保留訂單預留；業務送達客戶時再登錄送貨/);
});
