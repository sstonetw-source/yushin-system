const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('shared order and purchasing dialogs remain visible when a main page is hidden', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const dialogs = new Set(['orderModalOverlay', 'deliveryModalOverlay', 'poModalOverlay', 'poReceiptBatchOverlay', 'purchaseTimelineOverlay']);
    const found = new Set();
    const stack = [];
    for (const [tag] of html.matchAll(/<\/?div\b[^>]*>/gi)) {
        if (/^<\/div/i.test(tag)) { stack.pop(); continue; }
        const id = tag.match(/\bid="([^"]*)"/)?.[1] || '';
        const classes = tag.match(/\bclass="([^"]*)"/)?.[1] || '';
        if (dialogs.has(id)) {
            assert.equal(stack.some(parent => parent.classes.split(/\s+/).includes('content-section')), false, `${id} must not inherit a hidden main page`);
            assert.equal(stack.some(parent => parent.id === 'appContainer'), true, `${id} remains inside the authenticated application`);
            found.add(id);
        }
        stack.push({ id, classes });
    }
    assert.deepEqual(found, dialogs);
});
