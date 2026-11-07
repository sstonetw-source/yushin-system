const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const indexes=require('../firestore.indexes.json').indexes;
const app=fs.readFileSync('src/features/quotations/quotation-workspace.js','utf8');
const source=app.slice(app.indexOf('function createMyQuotesPaginationState()'),app.indexOf('function updateMyQuotesLoadMoreButton()'));
for(const role of ['sales','engineer','admin','purchaser'])test(`${role} quote history queries have matching deployable indexes`,()=>{
 const queries=[];const db={collection(name){assert.equal(name,'quotes');const fields=[];const query={where(field,op){assert.equal(op,'==');fields.push({fieldPath:field,order:'ASCENDING'});return query;},orderBy(field,direction){assert.equal(direction,'desc');fields.push({fieldPath:field,order:'DESCENDING'});queries.push(fields);return query;}};return query;}};
 const state=vm.runInNewContext(source+';createMyQuotesPaginationState()', {db,currentUser:{uid:'actor'},currentUserCode:'CODE',canViewAllData:()=>['admin','purchaser'].includes(role)});
 [...state.sources, ...state.legacySources].forEach(s=>s.query());
 assert.equal(queries.length,['admin','purchaser'].includes(role)?2:4);
 assert.equal(queries[0].at(-1).fieldPath,'createdAt');
 for(const fields of queries)if(fields.length>1)assert.ok(indexes.some(i=>i.collectionGroup==='quotes'&&i.queryScope==='COLLECTION'&&JSON.stringify(i.fields)===JSON.stringify(fields)),JSON.stringify(fields));
});

test('creation-time history merges both ownership streams before paging and retains undated quotes', async () => {
 const stock=fs.readFileSync('src/features/inventory/inventory-workspace.js','utf8');
 const comparator=stock.slice(stock.indexOf('function compareBusinessRecordsNewestFirst('),stock.indexOf('// 核銷日期'));
 const loader=app.slice(app.indexOf('async function loadMyQuotesPage('),app.indexOf('window.loadMyQuotesFromCloud'));
 const rows=[
  {id:'MS-new',ownerUid:'actor',createdAt:'2026-11-07T03:00:00Z',quoteDate:'2026-09-29'},
  {id:'YS-middle',salesCode:'CODE',ownerUid:'actor',createdAt:'2026-11-07T02:00:00Z',quoteDate:'2026-11-07'},
  {id:'TS-old',salesCode:'CODE',createdAt:'2026-11-07T01:00:00Z',quoteDate:'2026-11-06'},
  {id:'legacy',ownerUid:'actor',quoteDate:'2026-11-05'}
 ];
 const db={collection(){
  let selected=rows, cursor, limit;
  const query={
   where(field,_op,value){selected=selected.filter(row=>row[field]===value);return query;},
   orderBy(field){selected=selected.filter(row=>field in row).sort((a,b)=>b[field].localeCompare(a[field]));return query;},
   limit(size){limit=size;return query;},
   startAfter(doc){cursor=doc.id;return query;},
   async get(){
    const offset=cursor ? selected.findIndex(row=>row.id===cursor)+1 : 0;
    const docs=selected.slice(offset,offset+limit).map(row=>({id:row.id,data:()=>row}));
    return {docs,size:docs.length,empty:!docs.length};
   }
  };return query;
 }};
 const context=vm.createContext({db, DEFAULT_LIST_LIMIT:2, currentUserCode:'CODE',currentUser:{uid:'actor'},
  currentUserRole:'sales',currentUserName:'業務',canViewAllData:()=>false,getDataScope:()=> 'own',
  document:{getElementById:()=>({style:{}})},updateMyQuotesLoadMoreButton(){},renderMyQuotesList(){},
  firestoreReadWithTimeout:promise=>promise,writeAppDataCache(){},mainPageLoadFailed(){},console,alert:assert.fail});
 vm.runInContext('let myQuotesPageLoading=false,myQuotesReloadRequested=false,myQuotesPaginationState=null,myQuotesCache=[];'+comparator+source+loader,context);
 await context.loadMyQuotesPage(true);
 assert.deepEqual(Array.from(vm.runInContext('myQuotesCache.map(row=>row.id)',context)),['MS-new','YS-middle']);
 for(let i=0;i<4;i++)await context.loadMyQuotesPage(false);
 assert.deepEqual(Array.from(vm.runInContext('myQuotesCache.map(row=>row.id)',context)),['MS-new','YS-middle','TS-old','legacy']);
 assert.ok(context.compareCreatedDocumentsNewestFirst(
  {poNo:'PO-MS-01',poDate:'2026-09-29',createdAt:'2026-11-07T03:00:00Z'},
  {poNo:'PO-YS-05',poDate:'2026-11-06',createdAt:'2026-11-07T02:00:00Z'},
  'poDate','poNo')<0);
});
