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
const chrome = ['google-chrome', 'google-chrome-stable', 'chromium']
    .find(name => spawnSync('which', [name], { encoding: 'utf8' }).status === 0);
assert.ok(chrome, 'headless Chrome is required for desktop/mobile visual regression');

const controls = {
    quote: '#quote-system #qsub-create',
    quoteCompany: '#quote-system #sub-yushin',
    forecast: '#forecast-system #forecastCreateProbe',
    product: '#product-system #productBrandProbe',
    order: '#order-system #orderWorkProbe',
    purchasing: '#purchasing-system #purchase-tab-work',
    warehouse: '#inventory-system #inventoryStockTabBtn',
    warehouseReceiving: '#inventory-system #inventoryReceiveProbe',
    warehouseShipping: '#inventory-system #inventoryShippingMainBtn',
    equipment: '#equipment-system #equipmentCreateProbe',
    administrator: '#admin-system #admin-sub-sales',
    analytics: '#admin-system #analyticsTabProbe',
    orderProgress: '#orderProgressProbe'
};
for (const id of ['qsub-create','sub-yushin','purchase-tab-work','inventoryStockTabBtn','inventoryShippingMainBtn','admin-sub-sales']) {
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
    <div id="quoteCreatePanel"><div class="sub-nav company-sub-nav"><div class="sub-tab active" role="button" id="sub-yushin">又鑫 (YS)</div><div class="sub-tab" role="button">辰星 (MS)</div><div class="sub-tab" role="button">鼎新 (DS)</div></div></div>
  </div>
  <div id="forecast-system" class="content-section active"><div class="toolbar forecast-section-header"><button id="forecastCreateProbe">新增 Forecast</button></div></div>
  <div id="product-system" class="content-section active"><div id="productSearchBrandButtons" class="product-brand-browser-list"><button class="product-brand-button active" id="productBrandProbe">廠牌</button><button class="product-brand-button">另一廠牌</button></div></div>
  <div id="order-system" class="content-section active"><div class="order-work-cards"><button class="order-work-card active" id="orderWorkProbe">待送貨</button><button class="order-work-card">其他狀態</button></div></div>
  <div id="purchasing-system" class="content-section active"><div class="purchase-view-tabs"><button class="active" id="purchase-tab-work">採購需求</button><button>採購單</button></div></div>
  <div id="inventory-system" class="content-section active">
    <div class="purchase-view-tabs inventory-work-tabs"><button class="active" id="inventoryStockTabBtn">庫存清單</button><button>收貨</button><button>出貨</button></div>
    <div class="order-work-cards inventory-work-subtabs"><button class="order-work-card active" id="inventoryReceiveProbe">採購收貨</button><button class="order-work-card">退貨收貨</button></div>
    <div class="inventory-shipping-tabs"><button class="order-work-card active" id="inventoryShippingMainBtn">主倉庫出貨</button><button class="order-work-card">其他倉庫出貨</button></div>
  </div>
  <div id="equipment-system" class="content-section active"><div class="toolbar"><button id="equipmentCreateProbe">新增儀器</button><button class="btn-secondary">匯出</button></div></div>
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
try {
    const fixturePath = path.join(directory, 'controls.html');
    fs.writeFileSync(fixturePath, fixture);
    for (const [label, size] of [['desktop', '1280,800'], ['mobile', '390,844']]) {
        const run = spawnSync(chrome, [
            '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
            '--disable-gpu', '--disable-extensions', '--no-first-run',
            '--disable-background-networking', '--window-size=' + size,
            '--force-device-scale-factor=1', '--virtual-time-budget=1000',
            '--dump-dom', pathToFileURL(fixturePath).href
        ], { encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
        assert.equal(run.status, 0, `${label}: browser failed: ${String(run.stderr).slice(-1200)}`);
        const match = run.stdout.match(/<title>YSPROBE:([^<]+)<\/title>/);
        assert.ok(match, `${label}: browser did not report computed styles`);
        const report = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
        assert.ok(label === 'mobile' ? report.width <= 640 : report.width >= 769,
            `${label}: unexpected browser width ${report.width}`);
        for (const [name, value] of Object.entries(report.checks)) {
            assert.ok(!value.missing, `${label}: ${name} element missing`);
            assert.ok(value.visible, `${label}: ${name} hidden`);
            assert.ok(value.height >= 43.5, `${label}: ${name} smaller than 44px (${value.height})`);
            if (!['forecast', 'equipment'].includes(name)) {
                assert.equal(value.background, 'rgb(237, 242, 246)', `${label}: ${name} selected state`);
                assert.equal(value.border, 'rgb(49, 92, 133)', `${label}: ${name} border`);
                assert.equal(value.radius, '8px', `${label}: ${name} radius`);
            } else {
                assert.equal(value.background, 'rgb(49, 92, 133)', `${label}: ${name} primary action`);
            }
            if (label === 'mobile') {
                assert.ok(value.right <= report.width + 1,
                    `${label}: ${name} overflows viewport ${value.right} > ${report.width}`);
            }
        }
        console.log(`UI browser smoke ${label} ${report.width}px: ${Object.keys(report.checks).length} control types passed`);
    }
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
