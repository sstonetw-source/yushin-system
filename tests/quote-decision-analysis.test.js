const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'modules/quote-decision-analysis.js'), 'utf8');

test('quote page offers decision price analysis PDF using the existing quote renderer', () => {
    assert.match(indexSource, /id="decisionPriceAnalysisBtn"[^>]*onclick="exportDecisionPriceAnalysisPdf\(\)"/);
    assert.match(indexSource, /modules\/quote-decision-analysis\.js\?v=20261005-2/);
    assert.match(source, /collectCurrentQuoteRecord\(\)/);
    assert.match(source, /createQuotePdfStage\(quoteData\)/);
    assert.match(source, /querySelector\('\.quote-pdf-title'\)/);
    assert.match(source, /title\.textContent = DOCUMENT_TITLE/);
    assert.match(source, /querySelectorAll\('\.stamp-section'\)\.forEach\(section => section\.remove\(\)\)/);
    assert.match(source, /paginateQuotePdfDocument/);
    assert.match(source, /addDocumentPagesToPdf/);
    assert.match(source, /DocumentDownloads\.savePdf\('quote', pdf, fileName\)/);
    assert.match(source, /決標單價分析/);
    assert.doesNotMatch(source, /persistQuoteOutputRecord/);
    assert.doesNotMatch(source, /db\.collection\(/);
});
