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
        page: '#F6F5F2', surface: '#FDFCFB', text: '#292D32',
        muted: '#626A76', border: '#E7E5E1', success: '#41674C',
        warning: '#825B23', danger: '#98544F', neutral: '#64748B',
        nav: '#EEEDE9', 'table-head': '#F3F2F0',
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
        assert.ok(html.includes(`id="${id}" class="content-section">\n        <h2 class="workspace-page-title no-print">${title} <button type="button" class="page-help-trigger`), id);
    }
    assert.ok(html.includes('id="quote-system" class="content-section active">'));
    assert.match(html, /<h2 class="workspace-page-title no-print">估價單 <button[^>]*data-page-help="quote-system"/);
    assert.equal((html.match(/<div class="nav-tab(?: active)?" role="button" tabindex="0"/g) || []).length, 8);
    assert.equal((html.match(/<div class="sub-tab(?: active)?" role="button" tabindex="0"/g) || []).length, 16);
    assert.ok(html.includes("onkeydown=\"if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}\""));
    assert.ok(css.includes('#appContainer .forecast-status-active'));
    assert.ok(css.includes('.order-work-card, .product-brand-button):is(.active, [aria-pressed="true"], [aria-selected="true"])'));
    assert.match(html, /<div class="module-header no-print">\s*<h2 class="workspace-page-title">訂單 <button[^>]*data-page-help="order-system"/);
    assert.ok(html.includes('styles.css?v=20261013-4'));
    assert.ok(css.includes('#appContainer #myQuotesPanel > table :is(th, td):nth-child(6)'));
    assert.ok(css.includes('#appContainer #quote-system .quote-more-actions > summary'));
    assert.ok(css.includes('@media screen and (min-width: 769px)'));
    assert.ok(css.includes('html, body, #appContainer { background: var(--ys-page); }'));
    assert.ok(html.includes('<meta name="theme-color" content="#EEEDE9">'));
});

test('secondary, destructive and disabled actions keep separate semantics', () => {
    assert.match(css, /button\.btn-secondary\s*\{[\s\S]*?background: var\(--ys-surface\) !important;/);
    assert.match(css, /button\.btn-danger\s*\{[\s\S]*?background: var\(--ys-danger\) !important;/);
    assert.match(css, /#appContainer button:disabled \{ cursor: not-allowed; opacity: \.55; \}/);
    assert.match(css, /#appContainer \.status-badge\.status-soon \{ background: var\(--ys-warning-soft\); color: var\(--ys-warning\); \}/);
});

