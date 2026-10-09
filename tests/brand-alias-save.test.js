const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');

function setup() {
    const body = { innerHTML: '' };
    const writes = [];
    const context = vm.createContext({
        window: {}, currentUserRole: 'admin', salesStatisticsOrders: [],
        brandMasterCache: [{ id: 'biorad', name: 'Bio-Rad', aliases: [], active: true }],
        unifiedBrandEntriesCache: null, primaryBrandNamesCache: null,
        keyStatisticBrands: [], keyStatisticBrandAliases: {}, companyAgencyBrands: {},
        DEFAULT_CANONICAL_BRAND_ALIASES: { 'Bio-Rad': ['Biorad', 'Bio Rad', 'BIO-RAD'] },
        OTHER_BRAND_OPTION_KEY: '__OTHER__',
        includesBrandCaseInsensitive: (values, name) => values.some(v => v.toLowerCase() === name.toLowerCase()),
        document: { getElementById: () => body },
        escapeHtml: v => v, escapeAttr: v => v, inlineJsValue: JSON.stringify,
        beginActionButton: () => ({}), endActionButton: () => {},
        renderProductBrandBrowser: () => {}, populateQuoteBrandDropdowns: () => {},
        populateOrderBrandDropdown: () => {}, populateEquipmentBrandDropdown: () => {},
        showActionFeedback: () => {}, alert: message => { throw new Error(message); }, console,
        db: { collection: name => ({ doc: id => ({ set: async payload => writes.push({ name, id, payload }) }) }) }
    });
    for (const name of ['dedupeBrandsCaseInsensitive', 'normalizeBrandLookupKey', 'defaultCanonicalBrandName',
        'defaultBrandAliasesForCanonical', 'normalizeBrandMasterRecord', 'invalidateBrandDerivedCaches',
        'getUnifiedBrandEntries', 'resolveBrandName', 'brandMasterDocumentId', 'upsertBrandMaster', 'renderBrandAliasManager']) {
        const start = source.indexOf(`function ${name}(`);
        const end = source.indexOf('\n}\n', start) + 2;
        vm.runInContext((name === 'upsertBrandMaster' ? 'async ' : '') + source.slice(start, end), context);
    }
    const start = source.indexOf('window.saveBrandAliases = async function');
    vm.runInContext(source.slice(start, source.indexOf('\n};', start) + 3), context);
    return { context, body, writes };
}

test('saving biorad preserves the entered spelling through persistence, rendering and reload', async () => {
    const { context, body, writes } = setup();
    const button = { closest: () => ({ querySelector: () => ({ value: 'biorad' }) }) };
    await context.window.saveBrandAliases('Bio-Rad', button);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].id, 'biorad');
    assert.ok(writes[0].payload.aliases.includes('biorad'));
    assert.match(body.innerHTML, /value="biorad, /);
    context.brandMasterCache = [context.normalizeBrandMasterRecord('biorad', writes[0].payload)];
    context.invalidateBrandDerivedCaches();
    context.renderBrandAliasManager();
    assert.match(body.innerHTML, /value="biorad, /);
    for (const input of ['biorad', 'Biorad', 'Bio Rad', 'BIO-RAD']) {
        assert.equal(context.resolveBrandName(input), 'Bio-Rad');
    }
    assert.equal(context.getUnifiedBrandEntries().length, 1);
});

test('alias belonging to a different brand is rejected without a write', async () => {
    const { context, writes } = setup();
    context.brandMasterCache.push({ id: 'other', name: 'Other', aliases: ['Taken'], active: true });
    const button = { closest: () => ({ querySelector: () => ({ value: 'Taken' }) }) };
    await assert.rejects(context.window.saveBrandAliases('Bio-Rad', button), /另一個標準廠牌/);
    assert.equal(writes.length, 0);
});
