const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const indexes=require('../firestore.indexes.json').indexes;
const app=fs.readFileSync('src/features/quotations/quotation-workspace.js','utf8');
const source=app.slice(app.indexOf('function createMyQuotesPaginationState()'),app.indexOf('function updateMyQuotesLoadMoreButton()'));
for(const role of ['sales','engineer','admin','purchaser'])test(`${role} quote history queries have matching deployable indexes`,()=>{
 const queries=[];const db={collection(name){assert.equal(name,'quotes');const fields=[];const query={where(field,op){assert.equal(op,'==');fields.push({fieldPath:field,order:'ASCENDING'});return query;},orderBy(field,direction){assert.equal(direction,'desc');fields.push({fieldPath:field,order:'DESCENDING'});queries.push(fields);return query;}};return query;}};
 const state=vm.runInNewContext(source+';createMyQuotesPaginationState()', {db,currentUser:{uid:'actor'},currentUserCode:'CODE',canViewAllData:()=>['admin','purchaser'].includes(role)});
 state.sources.forEach(s=>s.query());assert.equal(queries.length,['admin','purchaser'].includes(role)?1:2);
 for(const fields of queries)if(fields.length>1)assert.ok(indexes.some(i=>i.collectionGroup==='quotes'&&i.queryScope==='COLLECTION'&&JSON.stringify(i.fields)===JSON.stringify(fields)),JSON.stringify(fields));
});
