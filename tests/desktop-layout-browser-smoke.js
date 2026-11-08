'use strict';
// Offline layout/interaction regression for the desktop consolidation.
// Uses actual HTML, CSS and row renderers without Firebase or production data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const html = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('styles.css', 'utf8');
const productSource = fs.readFileSync('src/features/products/product-management.js', 'utf8');
const adminSource = fs.readFileSync('src/features/administration/user-and-system-settings.js', 'utf8');

function extract(source, begin, end) {
    const start = source.indexOf(begin);
    const stop = source.indexOf(end, start);
    assert.ok(start !== -1 && stop > start, 'renderer exists: ' + begin);
    return source.slice(start, stop + end.length);
}

(async () => {
    const executablePath = process.env.CHROME_EXECUTABLE_PATH ||
        ['google-chrome', 'chromium'].map(name => spawnSync('which', [name], { encoding: 'utf8' }))
            .find(result => result.status === 0)?.stdout.trim();
    const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 1366, 1024, 768, 390]) {
            const page = await browser.newPage({ viewport: { width, height: 950 }, isMobile: width === 390, hasTouch: width === 390 });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, ''));
            await page.addStyleTag({ content: css });
            await page.evaluate(() => {
                document.getElementById('loginScreen').style.display = 'none';
                document.getElementById('authStarting').style.display = 'none';
                document.getElementById('appContainer').style.display = 'block';
                document.getElementById('authUserLabel').textContent = '測試帳號';
                document.getElementById('product-system').style.display = 'block';
                document.getElementById('purchasing-system').style.display = 'block';
                document.getElementById('admin-system').style.display = 'block';
                document.getElementById('poListPanel').style.display = 'block';
            });
            const navToggle = page.locator('.mobile-nav-toggle');
            if (width > 1080) {
                assert.equal(await navToggle.isVisible(), false, width + 'px desktop navigation');
                const alignment = await page.locator('.nav-tab:visible').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)));
                assert.equal(new Set(alignment).size, 1, width + 'px main navigation remains one row');
            } else {
                assert.equal(await navToggle.isVisible(), true, width + 'px compact navigation');
                await navToggle.click();
                assert.equal(await page.locator('.nav-tabs').evaluate(node => node.classList.contains('mobile-open')), true);
                assert.equal(await page.locator('[data-main-nav="admin"]').isVisible(), true);
            }
            if (width > 640) {
                await page.locator('.auth-menu-toggle').click();
                assert.equal(await page.locator('button[onclick="handleLogout()"]') .isVisible(), true);
                await page.locator('.auth-menu-toggle').press('Escape');
                assert.equal(await page.locator('.auth-menu-toggle').getAttribute('aria-expanded'), 'false');
            } else {
                assert.equal(await page.locator('.auth-menu-toggle').isVisible(), false);
                assert.equal(await page.locator('button[onclick="handleLogout()"]') .isVisible(), true);
            }
            await page.addScriptTag({ content: `
                const productManagementSelection = new Set();
                const resolveBrandName = value => value, isBrandPriceListActive = () => true;
                const canEditPage = () => true, canManagePendingProductMaster = () => true, canDeleteProductMaster = () => true;
                const escapeHtml = value => String(value ?? ''), escapeAttr = escapeHtml, inlineJsValue = value => JSON.stringify(value);
                ${extract(productSource, 'function productManagementRow(', '\n}\n')}
                document.getElementById('productManagementBody').innerHTML = productManagementRow({productId:'P-1',manufacturerPartNo:'R123',productName:'RNeasy Mini Kit',brandName:'QIAGEN',productLine:'萃取',specification:'50 preps',listPrice:1200});
                const allUsersCache = [{uid:'abcdef1234567890abcdef',name:'Luke',email:'tester@example.test',code:'L',role:'sales'}];
                const ROLE_LABELS = {admin:'管理員',sales:'業務',purchaser:'採購',warehouse:'倉管',engineer:'工程師'};
                ${extract(adminSource, 'window.renderAdminSalesTable = function()', '\n};')}
                renderAdminSalesTable();
            ` });
            await page.locator('.product-row-more-trigger').click();
            assert.equal(await page.locator('.product-row-actions-dialog[open]').isVisible(), true);
            assert.equal(await page.locator('.product-row-actions-dialog[open] .btn-danger').count(), 1);
            await page.locator('.product-row-actions-dialog[open]').getByRole('button', { name: '關閉' }).click();
            assert.equal(await page.locator('.product-row-actions-dialog[open]').count(), 0);
            if (width > 768) {
                await page.locator('.admin-account-trigger').click();
                assert.equal(await page.locator('.admin-account-dialog[open]').isVisible(), true);
                await page.locator('.admin-account-dialog[open]').getByRole('button', { name: '關閉' }).click();
                assert.equal(await page.locator('.admin-account-dialog[open]').count(), 0);
            }
            await page.evaluate(() => {
                document.getElementById('poListSearch').hidden = false;
                document.getElementById('purchaseWorkSearch').hidden = true;
            });
            const scrollState = await page.locator('.po-history-table-wrap').evaluate(node => ({ visible: node.clientWidth, content: node.scrollWidth }));
            if (width >= 769 && width <= 1024) assert.ok(scrollState.content > scrollState.visible, width + 'px PO table scrolls locally');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, width + 'px no page-level horizontal overflow');
            assert.deepEqual(errors, [], width + 'px browser console');
            console.log('Desktop layout ' + width + 'px: navigation, account/product dialogs, PO overflow and mobile regression passed.');
            await page.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
