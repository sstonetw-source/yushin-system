const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const css = read('styles.css');
const html = read('index.html');

test('secondary text meets AA on shared navigation page card and selected backgrounds',()=>{
    const token=name=>css.match(new RegExp(`--ys-${name}: (#[0-9A-Fa-f]{6});`))[1];
    const luminance=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255)
        .map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4)
        .reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    for(const background of ['nav','page','surface','selected']){
        const [low,high]=[luminance(token('muted')),luminance(token(background))].sort((a,b)=>a-b);
        assert.ok((high+.05)/(low+.05)>=4.5,background);
    }
});

test('shared UI tokens follow project palette without touching printable documents', () => {
    const palette = {
        primary: '#315C85', 'primary-hover': '#264A6B', selected: '#EDF2F6',
        page: '#D8D0C3', surface: '#E9E3D8', text: '#2D3336',
        muted: '#3F494F', border: '#B5ADA0', success: '#41674C',
        warning: '#825B23', danger: '#98544F', neutral: '#64748B',
        nav: '#C9C0B2', 'table-head': '#DFD7C9',
        'success-soft': '#EAF3EB', 'warning-soft': '#FFF3E4',
        'danger-soft': '#FCEDEB', 'neutral-soft': '#F2F2EF'
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
        assert.ok(html.replace('<div class="workflow-page-heading">','').includes(`id="${id}" class="content-section">\n        <h2 class="workspace-page-title no-print">${title} <button type="button" class="page-help-trigger`), id);
    }
    assert.ok(html.includes('id="quote-system" class="content-section active">'));
    assert.match(html, /<h2 class="workspace-page-title no-print">估價單 <button[^>]*data-page-help="quote-system"/);
    assert.equal((html.match(/<div class="nav-tab(?: active)?" role="button" tabindex="0"/g) || []).length, 8);
    assert.equal((html.match(/<div class="sub-tab(?: active)?" role="button" tabindex="0"/g) || []).length, 16);
    assert.ok(html.includes("onkeydown=\"if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}\""));
    assert.ok(css.includes('#appContainer .forecast-status-active'));
    assert.ok(css.includes('.order-work-card, .product-brand-button):is(.active, [aria-pressed="true"], [aria-selected="true"])'));
    assert.match(html, /<div class="module-header no-print">\s*<h2 class="workspace-page-title">訂單 <button[^>]*data-page-help="order-system"/);
    assert.match(html, /styles\.css\?v=20[0-9]{6}-[0-9]+/);
    assert.ok(css.includes('#appContainer #myQuotesPanel > table :is(th, td):nth-child(6)'));
    assert.ok(css.includes('#appContainer #quote-system .quote-more-actions > summary'));
    assert.ok(css.includes('@media screen and (min-width: 769px)'));
    assert.ok(css.includes('html, body, #appContainer { background: var(--ys-page); }'));
    assert.ok(html.includes('<meta name="theme-color" content="#C9C0B2">'));
});

test('secondary, destructive and disabled actions keep separate semantics', () => {
    assert.match(css, /button\.btn-secondary\s*\{[\s\S]*?background: var\(--ys-surface\) !important;/);
    assert.match(css, /button\.btn-danger\s*\{[\s\S]*?background: var\(--ys-danger\) !important;/);
    assert.match(css, /#appContainer button:disabled \{ cursor: not-allowed; opacity: \.55; \}/);
    assert.match(css, /#appContainer \.status-badge\.status-soon \{ background: var\(--ys-warning-soft\); color: var\(--ys-warning\); \}/);
});

test('mobile record lists use one white card layer without a blue outer well or beige cells', () => {
    assert.match(css, /--ys-record: #FDFCFB;/);
    assert.match(css, /#appContainer \{ --workspace-background: transparent;/);
    assert.match(css, /#businessProductSearchBody\) \{\s*display: block;[\s\S]*?background: var\(--workspace-background\);\s*padding: 0;\s*border-radius: 0;/);
    assert.match(css, /#businessProductSearchBody\) > tr \{[\s\S]*?background: var\(--ys-record\);\s*box-shadow: none;/);
    assert.match(css, /table:not\(:where\(#printablePO \*,#itemTable\)\) td \{ background-color:var\(--ys-record\); \}/);
    assert.match(css, /#inventoryListTable \.inventory-compact-row \{[^\n]*background:var\(--ys-record\)/);
    assert.match(css, /#ordersTable tbody > tr \{ background:var\(--ys-record\)!important;/);
    assert.match(css, /#appContainer \.inventory-mobile-summary > div \{ background: var\(--ys-neutral-soft\);/);
    assert.match(css, /#appContainer #printableQuote \{\s*background:var\(--ys-surface\);/);
    assert.match(html, /styles\.css\?v=20261027-305/);
});

