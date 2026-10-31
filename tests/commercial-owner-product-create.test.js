'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const source=read('app.js'),rules=read('firestore.rules'),html=read('index.html');
function fn(name){
  const start=source.indexOf('function '+name+'(');
  assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('\n}',start)+2);
}

test('only enabled people with real business identity can be selectable owners',()=>{
  const ctx=vm.createContext({});vm.runInContext(fn('isSelectableCommercialOwner'),ctx);
  const base={uid:'U1',name:'主管',code:'A01',role:'admin',active:true};
  for(const role of ['admin','sales','engineer'])assert.equal(ctx.isSelectableCommercialOwner({...base,role}),true);
  for(const person of [{...base,role:'purchaser'},{...base,role:'warehouse'},
    {...base,name:''},{...base,code:''},{...base,uid:''},{...base,active:false},{...base,disabled:true}])
    assert.equal(ctx.isSelectableCommercialOwner(person),false);
});

test('admin keeps its own UID while purchaser may create for the same admin without becoming owner',()=>{
  const people=[{uid:'a',name:'主管',code:'A01',role:'admin'},{uid:'s',name:'業務',code:'S01',role:'sales'},
    {uid:'p',name:'採購',code:'P01',role:'purchaser'},{uid:'pure',name:'純管理',role:'admin'}];
  const selector={value:'',options:[],replaceChildren(...items){this.options=items;},add(item){this.options.push(item);}};
  const wrap={style:{}};
  const ctx=vm.createContext({currentUserRole:'admin',currentUser:{uid:'a'},currentUserName:'主管',currentUserCode:'A01',
    salesList:people,requestedOrderOwnerUid:'',ROLE_LABELS:{admin:'管理員',sales:'業務'},
    document:{getElementById:id=>id==='orderOwnerUid'?selector:wrap},
    Option:class{constructor(text,value){this.text=text;this.value=value;}}});
  vm.runInContext(fn('isSelectableCommercialOwner')+fn('populateOrderOwnerSelect'),ctx);
  ctx.populateOrderOwnerSelect();
  assert.equal(wrap.style.display,'');assert.equal(selector.value,'a');
  assert.deepEqual(selector.options.map(option=>option.value),['','a','s']);
  ctx.currentUserRole='purchaser';ctx.requestedOrderOwnerUid='a';ctx.populateOrderOwnerSelect();
  assert.equal(selector.value,'a');assert.equal(wrap.style.display,'');
  assert.match(fn('commercialCreatorFields'),/createdByUid: currentUser\?\.uid/);
});

test('new permanent product is available to sales, while existing master and cost actions remain separate',()=>{
  const ctx=vm.createContext({});
  vm.runInContext(fn('canManagePendingProductMaster')+fn('canCreateProductMaster'),ctx);
  for(const role of ['sales','purchaser','admin']){
    ctx.currentUserRole=role;
    assert.equal(ctx.canCreateProductMaster(),true);
    assert.equal(ctx.canManagePendingProductMaster(),role!=='sales');
  }
  for(const role of ['engineer','warehouse']){ctx.currentUserRole=role;assert.equal(ctx.canCreateProductMaster(),false);}
  assert.match(html,/id="createProductMasterBtn"[^>]*onclick="openNewProductMasterEditor\(\)"/);
  assert.match(source,/originalId \? !canManagePendingProductMaster\(\) : !canCreateProductMaster\(\)/);
  assert.match(source,/if \(!originalId && existingProduct\.exists\) throw new Error/);
  assert.match(rules,/allow create: if canPurchase\(\) \|\| businessTemporaryProduct\(id, request\.resource\.data\)[\s\S]*?salesPermanentProductCreate/);
  assert.match(rules,/allow update: if canPurchase\(\);\s*allow delete: if admin\(\);/);
});

test('engineer creator-only legacy quote access is removed in client and Rules, not from history',()=>{
  assert.doesNotMatch(source,/engineerAssistedSalesQuote|where\('createdByRole', '==', 'engineer'\)/);
  const quotes=rules.slice(rules.indexOf('match /quotes/{id}'),rules.indexOf('match /forecasts/{id}'));
  assert.doesNotMatch(quotes,/engineerAssistedSalesQuote|createdByUid == request\.auth\.uid/);
  assert.match(quotes,/allow list: if canPurchase\(\) \|\| owns\(resource\.data\)/);
  assert.match(quotes,/preservesCreator\(\)/);
});

test('admin analytics owner selector includes active commercial admins without loaded orders',()=>{
  const ids=['salesStatsSalesFilter','salesStatsBrandFilter','salesStatsTypeFilter','salesStatsLineFilter'];
  const selects=Object.fromEntries(ids.map(id=>[id,{value:'',innerHTML:''}]));
  const ctx=vm.createContext({
    salesList:[{uid:'admin1',name:'主管',code:'A01',role:'admin',active:true},
      {uid:'pure',name:'純管理',code:'',role:'admin',active:true},
      {uid:'sales1',name:'業務',code:'S01',role:'sales',active:true}],
    document:{getElementById:id=>selects[id]||null},getPrimaryBrandNames:()=>[],
    OTHER_BRAND_OPTION_KEY:'其他',escapeAttr:s=>s,escapeHtml:s=>s,
    buildTradeAnalysisRows:()=>[]
  });
  vm.runInContext(fn('isSelectableCommercialOwner')+fn('populateSalesStatisticsFilters'),ctx);
  ctx.populateSalesStatisticsFilters([]);
  assert.match(selects.salesStatsSalesFilter.innerHTML,/主管/);
  assert.match(selects.salesStatsSalesFilter.innerHTML,/業務/);
  assert.doesNotMatch(selects.salesStatsSalesFilter.innerHTML,/純管理/);
  ctx.populateSalesStatisticsFilters([{kind:'sales',sales:'歷史業務'}]);
  assert.match(selects.salesStatsSalesFilter.innerHTML,/歷史業務/);
  assert.match(source,/void ensureSalesListLoaded\(\)\.then/);
});
