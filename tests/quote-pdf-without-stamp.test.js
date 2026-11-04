'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const markup = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'src/features/quotations/quotation-workspace.js'), 'utf8');

function quoteRenderer() {
    const start = source.indexOf('function quotePdfExtraRows(');
    const end = source.indexOf('function createQuotePdfStage(', start);
    assert.ok(start >= 0 && end > start, 'found shared quote PDF renderer');
    const context = vm.createContext({
        document: { createElement: () => ({ className: '', innerHTML: '' }) },
        comparisonCompanyData: { yushin: { title: '又鑫', sub: 'YU SHING', logo: 'logo.png', stamp: 'stamp.png' } },
        companyData: { yushin: { title: '又鑫', stamp: 'stamp.png' } },
        currentCompany: 'yushin',
        quotePersonFromIdentity: () => ({ phone: '' }),
        escapeHtml: value => String(value),
        escapeAttr: value => String(value),
        numberToChineseWords: () => '壹仟零伍拾'
    });
    vm.runInContext(source.slice(start, end), context);
    return context.renderQuotePdfDocument;
}

test('quote more actions offers an unstamped PDF through the shared export path', () => {
    assert.match(markup, /id="quoteNoStampPdfBtn"[^>]*onclick="exportCurrentQuotePdfWithoutStamp\(\)"/);
    assert.match(source, /window\.exportCurrentQuotePdfWithoutStamp = function\(\)/);
    assert.match(source, /window\.exportCurrentQuotePdf\(\{ includeStamp: false \}\)/);
    assert.match(source, /createQuotePdfStage\(quoteData, \{ includeStamp \}\)/);
    assert.match(source, /'-無印章\.pdf'/);
});

test('the unstamped PDF removes only the stamp, retaining company logo, quote and totals', () => {
    const render = quoteRenderer();
    const quote = {
        company: 'yushin',
        quoteNo: 'YS-TEST',
        clientName: '測試醫院',
        quoteDate: '2026/11/04',
        grandTotal: '1,050',
        validDays: 90,
        items: [{ nameCn: '測試品項', qty: 1, price: 1050, exPrice: 1000, subtotal: 1050 }]
    };
    const stamped = render(quote).innerHTML;
    const unstamped = render(quote, { includeStamp: false }).innerHTML;
    assert.match(stamped, /<div class="stamp-section"><img src="stamp\.png"/);
    assert.doesNotMatch(unstamped, /stamp\.png|stamp-section/);
    assert.match(unstamped, /logo\.png/);
    assert.match(unstamped, /YS-TEST/);
    assert.match(unstamped, /測試品項/);
    assert.match(unstamped, /1,050/);
    assert.equal(
        stamped.replace(/<div class="stamp-section"><img src="stamp\.png"[^>]*><\/div>/, ''),
        unstamped
    );
});
