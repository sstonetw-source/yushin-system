const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const html = read('index.html');
const css = read('styles.css');

/*
 * 新的工作分頁不要另開色系；使用現有的設計變數，以及同一段選取狀態規則。
 * 此測試刻意不依賴 CSS 宣告順序（避免同一頁反覆補覆蓋規則）。
 */
test('working tabs across modules use a single shared selector and design tokens', () => {
    for (const selector of [
        '.sub-tab', '.purchase-view-tabs > button', '.order-progress-tabs > button',
        '#admin-statistics .sub-tabs > button', '.order-work-card', '.product-brand-button'
    ]) {
        assert.ok(css.includes(selector), `missing shared control: ${selector}`);
    }
    assert.match(css, /--ys-control-height:\s*44px;/);
    assert.match(css, /--ys-control-radius:\s*8px;/);
    assert.match(css, /:is\(\.active, \[aria-pressed="true"\], \[aria-selected="true"\]\)/);
    assert.match(css, /background:\s*var\(--ys-selected\);/);
    assert.match(css, /border-color:\s*var\(--ys-primary\);/);
    assert.match(css, /@media screen and \(max-width: 640px\)/);
    assert.match(css, /#quoteCreatePanel > \.company-sub-nav\s*\{\s*display:\s*grid;/);
    assert.match(css, /#admin-system > \.sub-nav\s*\{\s*display:\s*grid;/);
    assert.match(css, /@media print\s*\{/);
});

test('all eight workspaces retain their control entry points and action handlers', () => {
    const groups = {
        '估價單': ['id="qsub-create"', 'id="qsub-my"', 'id="sub-yushin"', "switchCompany('yushin', this)"],
        'Forecast': ['id="forecastSearch"', 'openForecastModal()'],
        '產品': ['id="productSearchBrandButtons"', 'id="productManagementSearchBtn"'],
        '訂單': ['id="orderWorkCards"', 'openOrderModal()'],
        '採購': ['id="purchase-tab-work"', 'id="purchase-tab-history"', "switchPurchasingView('ordering')"],
        '倉庫': ['id="inventoryStockTabBtn"', 'id="inventoryReceivingTabBtn"', 'id="inventoryShippingMainBtn"'],
        '儀器': ['id="eqSearchInput"', 'openEquipmentModal()'],
        '管理員': ['id="admin-sub-sales"', 'id="admin-sub-statistics"', "switchAdminTab('sales', this)"]
    };
    for (const [module, entries] of Object.entries(groups)) {
        for (const entry of entries) assert.ok(html.includes(entry), `${module} missing ${entry}`);
    }
});

test('superseded hard-coded blue/gray/red control themes are not reintroduced', () => {
    const discarded = [
        '.sub-tab.active { background: #003366;',
        '.purchase-view-tabs button.active { background:#003366;',
        '.order-work-card.active { background:#003366;',
        '#admin-statistics .sub-tabs button.active { background:#003366;',
        'button.btn-secondary { background-color: #666 !important;',
        'button.btn-danger { background-color: #cc0000 !important;',
        'button { padding: 8px 16px; font-size: 14px; background-color: #2563EB;'
    ];
    for (const oldRule of discarded) {
        assert.ok(!css.includes(oldRule), `obsolete UI theme restored: ${oldRule}`);
    }
    assert.match(css, /#appContainer button:is\(\.btn-secondary, \.status-ok, \.status-soon\),\s*button\.btn-secondary\s*\{\s*background:\s*var\(--ys-surface\) !important;/);
    assert.match(css, /button\.btn-danger,\s*#appContainer button\.danger-menu-item,\s*button\.btn-danger\s*\{\s*background:\s*var\(--ys-danger\) !important;/);
    assert.ok(html.includes('styles.css?v=20261013-3'), 'new shared styles must bypass stale mobile CSS cache');
});

test('the screen-only tab refactor does not alter formal document blocks', () => {
    assert.ok(css.includes('#printableQuote.theme-yushin'));
    assert.ok(css.includes('.quote-pdf-stage .quote-pdf-document'));
    assert.ok(css.includes('.po-pdf-stage'));
    assert.match(css, /@media print\s*\{[\s\S]*?\.no-print, button, \.sub-nav, \.nav-tabs \{ display: none !important; \}/);
});

test('all work tabs stay plain text without decorative emojis or icon markup', () => {
    const tabHtml = [...html.matchAll(/<(div|button)\\b[^>]*class="[^"]*\\bsub-tab\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>/g)];
    assert.equal(tabHtml.length, 19, 'all quote, company, admin and analytics work tabs should be audited');
    for (const [, , content] of tabHtml) {
        const label = content.trim();
        assert.ok(label && !/<(?:svg|img|i|span)\\b/i.test(label), 'tab contains nested icon markup: ' + label);
        assert.doesNotMatch(label, /\\p{Extended_Pictographic}/u, 'tab contains a decorative emoji: ' + label);
    }
    for (const [id, label] of [
        ['qsub-create', '建立估價單'],
        ['qsub-my', '全部估價單'],
        ['admin-sub-sales', '人員名單'],
        ['admin-sub-statistics', '進銷存分析']
    ]) {
        const element = html.match(new RegExp('id="' + id + '"[^>]*>([^<]+)<\\/div>'));
        assert.ok(element, 'missing work tab: ' + id);
        assert.equal(element[1].trim(), label, 'work tab label should be plain text: ' + id);
    }
});
