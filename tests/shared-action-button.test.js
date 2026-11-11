'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function helpers(path) {
    const source = fs.readFileSync(path, 'utf8');
    const start = source.indexOf('function beginActionButton(');
    const end = source.indexOf('function actionButtonFromEventOrSelector(', start);
    assert.ok(start >= 0 && end > start);
    const context = vm.createContext({});
    vm.runInContext(source.slice(start, end), context);
    return vm.runInContext('({ beginActionButton, endActionButton })', context);
}

function buttonWithIcon() {
    let markup = '<svg aria-hidden="true"></svg><span>儲存</span>';
    let text = '儲存';
    const classes = new Set();
    const attributes = new Map();
    return {
        dataset: {}, disabled: false, classes, attributes,
        classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
        setAttribute(name, value) { attributes.set(name, value); },
        removeAttribute(name) { attributes.delete(name); },
        get innerHTML() { return markup; },
        set innerHTML(value) { markup = value; text = value.replace(/<[^>]+>/g, ''); },
        get textContent() { return text; },
        set textContent(value) { text = value; markup = value; }
    };
}

for (const path of ['src/shared/action-feedback.js', 'app.js']) {
    test(`${path}: async buttons acknowledge immediately and restore icons on settlement`, () => {
        const { beginActionButton, endActionButton } = helpers(path);
        const button = buttonWithIcon();
        const initialMarkup = button.innerHTML;
        const state = beginActionButton(button, '處理中…');
        assert.ok(state);
        assert.equal(button.textContent, '處理中…');
        assert.equal(button.disabled, true);
        assert.equal(button.attributes.get('aria-busy'), 'true');
        assert.equal(button.classes.has('is-action-pending'), true);
        assert.equal(beginActionButton(button, '重複點擊'), null);
        endActionButton(button, state);
        assert.equal(button.innerHTML, initialMarkup);
        assert.equal(button.disabled, false);
        assert.equal(button.classes.has('is-action-pending'), false);
        assert.equal(button.attributes.has('aria-busy'), false);
        const second = beginActionButton(button, '再試一次…');
        endActionButton(button, second, '已完成');
        assert.equal(button.textContent, '已完成');
    });
}

test('pressed state and busy spinner are presentation-only and respect reduced motion', () => {
    const css = fs.readFileSync('styles.css', 'utf8');
    assert.match(css, /#appContainer button:not\(:disabled\):active/);
    assert.match(css, /button\.is-action-pending::after/);
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
});
