/*
 * Browser-based screen-style smoke test; uses Chrome installed on the GitHub
 * Actions Ubuntu runner. No Firebase login or production data is accessed.
 * Render representative controls from all eight modules at desktop/mobile widths.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const project = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(project, 'index.html'), 'utf8');
const chrome = process.env.CHROME_EXECUTABLE_PATH || ['google-chrome', 'google-chrome-stable', 'chromium']
    .find(name => spawnSync('which', [name], { encoding: 'utf8' }).status === 0);
assert.ok(chrome, 'headless Chrome is required for desktop/mobile visual regression');

const controls = {
    quote: '#quote-system #qsub-create',
    quoteInactive: '#quote-system #qsub-my',
    quoteCompany: '#quote-system #sub-yushin',
    forecast: '#forecast-system #forecastCreateProbe',
    productCreate: '#product-system #createProductMasterBtn',
    product: '#product-system #productBrandProbe',
    order: '#order-system #orderWorkProbe',
    purchasing: '#purchasing-system #purchase-tab-work',
    purchasingInactive: '#purchasing-system .purchase-view-tabs > button:not(.active)',
    warehouse: '#inventory-system #inventoryStockTabBtn',
    warehouseReceiving: '#inventory-system #inventoryReceiveProbe',
    warehouseShipping: '#inventory-system #inventoryShippingMainBtn',
    equipment: '#equipment-system #equipmentCreateProbe',
    equipmentSecondary: '#equipment-system #equipmentExportProbe',
    equipmentDanger: '#equipment-system #equipmentDeleteProbe',
    administrator: '#admin-system #admin-sub-sales',
    analytics: '#admin-system #analyticsTabProbe',
    orderProgress: '#orderProgressProbe'
};
for (const id of ['qsub-create','sub-yushin','createProductMasterBtn','purchase-tab-work','inventoryStockTabBtn','inventoryShippingMainBtn','admin-sub-sales']) {
    assert.ok(html.includes('id="' + id + '"'), 'representative control was removed from index.html: ' + id);
}

const fixture = `<!DOCTYPE html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Control smoke</title>
<link rel="stylesheet" href="${pathToFileURL(path.join(project, 'styles.css')).href}">
<body>
<div id="appContainer" style="display:block">
  <div id="quote-system" class="content-section active">
    <div class="sub-nav quote-module-nav"><div class="sub-tab active" role="button" id="qsub-create">建立估價單</div><div class="sub-tab" role="button" id="qsub-my">全部估價單</div></div>
    <div id="quoteCreatePanel"><div class="sub-nav company-sub-nav"><div class="sub-tab active" role="button" id="sub-yushin">又鑫 (YS)</div><div class="sub-tab" role="button">辰星 (MS)</div><div class="sub-tab" role="button">鼎新 (DS)</div></div><div id="printableQuote">估價單編輯表單</div></div>
  </div>
  <div id="forecast-system" class="content-section active"><div class="toolbar forecast-toolbar"><button id="forecastCreateProbe">新增 Forecast</button></div><table id="forecastTable"><tbody><tr><td data-th="客戶">Forecast 範例</td></tr></tbody></table></div>
  <div id="product-system" class="content-section active"><div class="product-master-create-actions"><button type="button" id="createProductMasterBtn">新增產品主檔</button></div><div id="productSearchBrandButtons" class="product-brand-browser-list"><button class="product-brand-button active" id="productBrandProbe">廠牌</button><button class="product-brand-button">另一廠牌</button></div><table class="product-management-table"><tbody><tr><td data-th="產品">產品範例</td></tr></tbody></table></div>
  <div id="order-system" class="content-section active"><div class="order-work-cards"><button class="order-work-card active" id="orderWorkProbe">待送貨</button><button class="order-work-card">其他狀態</button></div><table id="ordersTable"><tbody id="ordersBody"><tr><td data-th="客戶">訂單範例</td></tr></tbody></table></div>
  <div id="purchasing-system" class="content-section active"><div class="purchase-view-tabs"><button class="active" id="purchase-tab-work">採購需求</button><button>採購單</button></div><table class="workflow-list-table"><tbody id="purchasePendingBody"><tr><td data-th="客戶">採購範例</td></tr></tbody></table></div>
  <div id="inventory-system" class="content-section active">
    <div class="purchase-view-tabs inventory-work-tabs"><button class="active" id="inventoryStockTabBtn">庫存清單</button><button>收貨</button><button>出貨</button></div>
    <div class="order-work-cards inventory-work-subtabs"><button class="order-work-card active" id="inventoryReceiveProbe">採購收貨</button><button class="order-work-card">退貨收貨</button></div>
    <div class="inventory-shipping-tabs"><button class="order-work-card active" id="inventoryShippingMainBtn">主倉庫出貨</button><button class="order-work-card">其他倉庫出貨</button></div>
    <div id="inventoryStockPanel"><div class="table-wrap"><table id="inventoryListTable"><tbody id="inventoryListBody"><tr class="inventory-compact-row"><td data-th="產品資訊">庫存範例</td></tr></tbody></table></div></div>
  </div>
  <div id="equipment-system" class="content-section active"><div class="toolbar"><button id="equipmentCreateProbe">新增儀器</button><button class="btn-secondary" id="equipmentExportProbe">匯出</button><button class="btn-danger" id="equipmentDeleteProbe">刪除</button></div><table id="eqListTable"><tbody><tr><td data-th="編號">儀器範例</td></tr></tbody></table></div>
  <div id="admin-system" class="content-section active"><div class="sub-nav"><div class="sub-tab active" role="button" id="admin-sub-sales">人員名單</div><div class="sub-tab" role="button">廠牌管理</div></div><div id="admin-statistics"><div class="sub-tabs"><button class="active" id="analyticsTabProbe">銷售分析</button><button>採購分析</button></div></div></div>
  <div id="deliveryModalOverlay"><div class="order-progress-tabs"><button aria-selected="true" id="orderProgressProbe">進行中</button><button aria-selected="false">已完成</button></div></div>
</div>
<script>
const selectors = ${JSON.stringify(controls)};
const checks = {};
for (const [name, selector] of Object.entries(selectors)) {
    const element = document.querySelector(selector);
    if (!element) { checks[name] = { missing: true }; continue; }
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    checks[name] = {
        background: style.backgroundColor, color: style.color,
        border: style.borderTopColor, radius: style.borderTopLeftRadius,
        minHeight: style.minHeight, height: rect.height,
        visible: style.display !== 'none', right: rect.right,
        viewport: innerWidth
    };
}
const report = JSON.stringify({ width: innerWidth, checks });
document.title = 'YSPROBE:' + btoa(report);
</script>
</body>`;

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ys-ui-controls-'));
const fixturePath = path.join(directory, 'controls.html');
fs.writeFileSync(fixturePath, fixture);

/* Playwright's browser context sets the real CSS viewport: 390px, not Chrome
 * CLI's 500px minimum headless window. Browser itself is installed on runner. */
async function checkControls() {
    const { chromium } = require('playwright-core');
    const browser = await chromium.launch({
        executablePath: spawnSync('which', [chrome], { encoding: 'utf8' }).stdout.trim(),
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    try {
        for (const [label, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]]) {
            const page = await browser.newPage({
                viewport: { width, height },
                isMobile: label === 'mobile',
                hasTouch: label === 'mobile',
                deviceScaleFactor: label === 'mobile' ? 2 : 1
            });
            await page.goto(pathToFileURL(fixturePath).href, { waitUntil: 'load' });
            const title = await page.title();
            assert.ok(title.startsWith('YSPROBE:'), `${label}: browser did not report computed styles`);
            const report = JSON.parse(Buffer.from(title.slice('YSPROBE:'.length), 'base64').toString('utf8'));
            assert.equal(report.width, width, `${label}: expected a ${width}px CSS viewport, got ${report.width}`);
            for (const [name, value] of Object.entries(report.checks)) {
                assert.ok(!value.missing, `${label}: ${name} element missing`);
                assert.ok(value.visible, `${label}: ${name} hidden`);
                assert.ok(value.height >= 43.5, `${label}: ${name} smaller than 44px (${value.height})`);
                const primary = ['forecast', 'equipment', 'productCreate'].includes(name);
                const neutral = ['quoteInactive', 'purchasingInactive', 'equipmentSecondary'].includes(name);
                const danger = name === 'equipmentDanger';
                if (primary) {
                    assert.equal(value.background, 'rgb(49, 92, 133)', `${label}: ${name} primary action`);
                } else if (neutral) {
                    assert.equal(value.background, 'rgb(233, 227, 216)', `${label}: ${name} neutral action`);
                    assert.equal(value.border, 'rgb(181, 173, 160)', `${label}: ${name} neutral border`);
                } else if (danger) {
                    assert.equal(value.background, 'rgb(152, 84, 79)', `${label}: ${name} destructive action`);
                } else {
                    assert.equal(value.background, 'rgb(237, 242, 246)', `${label}: ${name} selected state`);
                    assert.equal(value.border, 'rgb(49, 92, 133)', `${label}: ${name} selected border`);
                }
                assert.equal(value.radius, '8px', `${label}: ${name} corner radius`);
                if (label === 'mobile') {
                    assert.ok(value.right <= report.width + 1,
                        `${label}: ${name} overflows viewport ${value.right} > ${report.width}`);
                    if (name === 'productCreate') {
                        const btnWidth = await page.locator('#createProductMasterBtn').evaluate(node => node.getBoundingClientRect().width);
                        const containerWidth = await page.locator('.product-master-create-actions').evaluate(node => node.getBoundingClientRect().width);
                        assert.ok(Math.abs(btnWidth - containerWidth) <= 1,
                            `${label}: create product action must fill the mobile content width`);
                    }
                }
            }
            if (label === 'mobile') {
                const recordStyles = await page.evaluate(() => {
                    const rows = ['#forecastTable', '.product-management-table', '#ordersTable',
                        '#purchasing-system .workflow-list-table', '#inventoryListTable', '#eqListTable'];
                    return rows.map(selector => {
                        const tbody = document.querySelector(`${selector} tbody`);
                        const tr = tbody.querySelector('tr');
                        const cell = tr.querySelector('td');
                        return { selector, well: getComputedStyle(tbody).backgroundColor,
                            padding: getComputedStyle(tbody).paddingTop,
                            card: getComputedStyle(tr).backgroundColor,
                            cell: getComputedStyle(cell).backgroundColor,
                            right: tr.getBoundingClientRect().right };
                    });
                });
                for (const row of recordStyles) {
                    assert.equal(row.well, 'rgba(0, 0, 0, 0)', `${row.selector}: no colored list well`);
                    assert.equal(row.padding, '0px', `${row.selector}: no extra wrapper padding`);
                    assert.equal(row.card, 'rgb(253, 252, 251)', `${row.selector}: warm white card`);
                    assert.ok(['rgba(0, 0, 0, 0)', 'rgb(253, 252, 251)'].includes(row.cell), `${row.selector}: no beige cell`);
                    assert.ok(row.right <= width + 1, `${row.selector}: card overflow`);
                }
                const quoteBackground = await page.locator('#printableQuote').evaluate(node => getComputedStyle(node).backgroundColor);
                assert.equal(quoteBackground, 'rgb(233, 227, 216)', 'quotation editor stays warm sand');
            }
            console.log(`UI browser smoke ${label} ${report.width}px: ${Object.keys(report.checks).length} control types passed`);
            // A sticky environment notice must not intercept dialog actions,
            // even when a mobile dialog is scrolled against the top edge.
            await page.evaluate(()=>{
                document.body.innerHTML='<div class="preview-environment-banner">本機 Emulator｜隔離測試資料，未連接正式 Firebase</div>'
                    +'<div class="eq-modal-overlay active" style="padding:0"><div class="eq-modal-box">'
                    +'<button id="dialog-close-probe" onclick="this.dataset.clicked=1">關閉視窗</button></div></div>';
            });
            await page.locator('#dialog-close-probe').click();
            assert.equal(await page.locator('#dialog-close-probe').getAttribute('data-clicked'),'1',label+': environment notice cannot cover dialog actions');
            await page.close();
        }
    } finally {
        await browser.close();
    }
}
checkControls()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
