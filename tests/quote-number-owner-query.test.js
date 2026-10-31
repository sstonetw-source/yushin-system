const test = require('node:test');
const assert = require('node:assert/strict');
const {quoteNumberGenerator} = require('./helpers/quote-number-generator.cjs');
const indexes = require('../firestore.indexes.json').indexes;

function database(records, rejectField) {
    const calls=[];
    function builder(filters=[]) {
        return {
            where:(...filter)=>builder([...filters,filter]),
            orderBy(field,direction) {assert.equal(field,'quoteNo');assert.equal(direction,'desc');return this;},
            limit(count) {assert.equal(count,1);return this;},
            async get() {
                calls.push(filters);
                if(filters.some(([field])=>field===rejectField))throw new Error('permission-denied');
                const matching=records.filter(record=>filters.every(([field,op,value])=>
                    op==='==' ? record[field]===value : op==='>=' ? record[field]>=value : record[field]<=value));
                matching.sort((a,b)=>b.quoteNo.localeCompare(a.quoteNo));
                return {forEach:fn=>matching.slice(0,1).forEach(record=>fn({data:()=>record}))};
            }
        };
    }
    return {calls, collection:name=>{assert.equal(name,'quotes');return builder();}};
}

test('sales number uses the maximum of UID ownership and legacy code ownership, never another owner',async()=>{
    const db=database([
        {quoteNo:'YS-20261031-S01-03',ownerUid:'sales1'},
        {quoteNo:'YS-20261031-S01-06',salesCode:'S01'},
        {quoteNo:'YS-20261031-S01-99',ownerUid:'sales2',salesCode:'S02'}
    ]);
    assert.equal(await quoteNumberGenerator(db).generate(),'YS-20261031-S01-07');
    assert.equal(db.calls.length,2);
    for(const filters of db.calls)assert.ok(filters.some(([f,op])=>['salesCode','ownerUid'].includes(f)&&op==='=='));
});

test('engineer numbering stays owner-scoped despite historically assisting another salesperson',async()=>{
    const db=database([
        {quoteNo:'YS-20261031-E01-05',ownerUid:'eng1',salesCode:'E01',createdByUid:'eng1',createdByRole:'engineer'},
        {quoteNo:'YS-20261031-E01-98',ownerUid:'sales2',salesCode:'S02',createdByUid:'eng1',createdByRole:'engineer'}
    ]);
    assert.equal(await quoteNumberGenerator(db,{role:'engineer',uid:'eng1',code:'E01',selectedCode:'E01'}).generate(),'YS-20261031-E01-06');
    assert.equal(db.calls.length,2);
});

test('purchaser and administrator keep a single bounded company lookup',async()=>{
    for(const role of ['admin','purchaser']) {
        const db=database([{quoteNo:'YS-20261031-S01-12',ownerUid:'other'}]);
        assert.equal(await quoteNumberGenerator(db,{role}).generate(),'YS-20261031-S01-13');
        assert.equal(db.calls.length,1);
    }
});

test('a failed ownership lookup cannot issue a partial or guessed number',async()=>{
    const db=database([{quoteNo:'YS-20261031-S01-05',salesCode:'S01'}],'ownerUid');
    const generator=quoteNumberGenerator(db);
    generator.input.value='stale';
    assert.equal(await generator.generate(),'');
    assert.match(generator.errors[0],/無法取得安全的估價單號/);
});

test('missing ownership stops before reading and editing an existing quote keeps its number',async()=>{
    const db=database([]), missing=quoteNumberGenerator(db,{uid:'',code:''});
    assert.equal(await missing.generate(),'');
    assert.equal(db.calls.length,0);
    const editing=quoteNumberGenerator(db);
    editing.context.editingQuoteNo='YS-existing';
    assert.equal(await editing.generate(),'YS-existing');
    assert.equal(db.calls.length,0);
});

test('every bounded ownership query has a deployable composite index',()=>{
    for(const fields of [['salesCode'],['ownerUid'],['createdByUid','createdByRole']]) {
        assert.ok(indexes.some(index=>index.collectionGroup==='quotes'&&index.queryScope==='COLLECTION'
            &&JSON.stringify(index.fields)===JSON.stringify([
                ...fields.map(fieldPath=>({fieldPath,order:'ASCENDING'})),{fieldPath:'quoteNo',order:'DESCENDING'}
            ])));
    }
});
