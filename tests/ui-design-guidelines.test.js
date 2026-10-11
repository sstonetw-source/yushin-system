const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const css = read('styles.css');
const html = read('index.html');

test('shared UI tokens follow project palette without touching printable documents', () => {
    const palette = {
        primary: '#2563EB', 'primary-hover': '#1D4ED8', selected: '#EFF6FF',
        page: '#F5F7FB', surface: '#FFFFFF', text: '#0F172A',
        muted: '#475569', border: '#CBD5E1', success: '#15803D',
        warning: '#B45309', danger: '#B91C1C', neutral: '#64748B'
    };
    for (const [name, value] of Object.entries(palette)) {
        assert.ok(css.includes(`--ys-${name}: ${value};`), `missing palette token: ${name}`);
    }
    assert.match(css, /@media screen\s*\{[\s\S]*?#appContainer \.content-section\s*\{/);
    assert.match(css, /@media screen and \(max-width: 768px\)/);
    assert.match(css, /@media \(pointer: coarse\) and \(hover: none\)/);
    assert.match(css, /#appContainer \.inline-help > summary \{ min-width: 44px; \}/);
});

test('all working modules show one consistent page title', () => {
    for (const [id, title] of [
        ['product-system', '產品'], ['forecast-system', 'Forecast'],
        ['inventory-system', '倉庫'], ['equipment-system', '儀器'],
        ['purchasing-system', '採購'], ['admin-system', '管理員後台']
    ]) {
        assert.ok(html.includes(`id="${id}" class="content-section">\n        <h2 class="workspace-page-title no-print">${title}</h2>`), id);
    }
    assert.ok(html.includes('id="quote-system" class="content-section active">'));
    assert.ok(html.includes('<h2 class="workspace-page-title no-print">估價單</h2>'));
    assert.equal((html.match(/<div class="nav-tab(?: active)?" role="button" tabindex="0"/g) || []).length, 8);
    assert.equal((html.match(/<div class="sub-tab(?: active)?" role="button" tabindex="0"/g) || []).length, 16);
    assert.ok(html.includes("onkeydown=\"if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}\""));
    assert.ok(css.includes('#appContainer .forecast-status-active'));
    assert.ok(css.includes('#appContainer :is(.order-work-card, .purchase-stage-button, .product-brand-button).active'));
    assert.match(html, /<div class="module-header no-print">\s*<h2 class="workspace-page-title">訂單<\/h2>/);
    assert.ok(html.includes('styles.css?v=20261011-7'));
    assert.ok(css.includes('#appContainer #myQuotesPanel > table :is(th, td):nth-child(6)'));
    assert.ok(css.includes('#appContainer #quote-system .quote-more-actions > summary'));
    assert.ok(css.includes('@media screen and (min-width: 769px)'));
    assert.ok(css.includes('html, body, #appContainer { background: var(--ys-page); }'));
    assert.ok(html.includes('<meta name="theme-color" content="#2563EB">'));
});

test('secondary, destructive and disabled actions keep separate semantics', () => {
    assert.match(css, /button\.btn-secondary\s*\{[\s\S]*?background: var\(--ys-surface\) !important;/);
    assert.match(css, /button\.btn-danger\s*\{[\s\S]*?background: var\(--ys-danger\) !important;/);
    assert.match(css, /#appContainer button:disabled \{ cursor: not-allowed; opacity: \.55; \}/);
    assert.match(css, /#appContainer \.status-badge\.status-soon \{ background: var\(--ys-warning\); color: #FFFFFF; \}/);
});
