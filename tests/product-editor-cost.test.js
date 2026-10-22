const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const code=source.slice(source.indexOf('window.saveProductMasterEditor ='),source.indexOf('function productManagementSource('));
function setup(role='admin',cost='50',original='20',fail=false){
 const nodes={};for(const id of ['pmEditBrand','pmEditCode','pmEditNameCn','pmEditProductLine','pmEditProductId','pmEditStatus','pmEditCost','pmEditProductType','pmEditServiceKind','pmEditInventoryTracked','pmEditLotTracked','pmEditExpiryTracked'])nodes[id]={value:({pmEditBrand:'Brand',pmEditCode:'001',pmEditNameCn:'Product',pmEditProductId:'p',pmEditStatus:'ACTIVE',pmEditCost:cost,pmEditProductType:'Reagent'})[id]||'',checked:false,dataset:{originalValue:original},focus:()=>{}};
 const writes=[],alerts=[];let invalidated=0;
 const c=vm.createContext({window:{},YushinServiceWork:require('../modules/service-work-core.js'),document:{getElementById:id=>nodes[id]||(nodes[id]={value:'',checked:false})},currentUserRole:role,trueUserRole:role,currentUser:{uid:'admin-id'},
 canManagePendingProductMaster:()=>true,resolveBrandName:x=>x,brandMasterEntryForName:()=>({id:'brand'}),normalizeItemCodeLoose:x=>x,normalizeBrandLookupKey:x=>x,normalizeProductTypeValue:x=>x,
 beginActionButton:()=>({}),endActionButton:()=>{},alert:m=>alerts.push(m),firestoreReadWithTimeout:p=>p,findDuplicateProductMaster:async()=>null,syncSavedProductMaster:()=>{},
 db:{collection:name=>({where:()=>({limit:()=>({get:async()=>({docs:[]})})}),doc:id=>({name,id})}),runTransaction:async fn=>{const pending=[];await fn({get:async()=>({exists:true,data:()=>({standardCost:20})}),set:(ref,data)=>pending.push({ref,data})});if(fail)throw Error('write denied');writes.push(...pending);}},
 invalidateVisibleProductCosts:()=>invalidated++,purchaseCostCache:new Map(),productMasterDocToPriceItem:()=>({}),cacheProductLookupItem:()=>{},productManagementResults:[],productManagementOverviewRows:[],renderProductManagementResults:()=>{},renderProductManagementOverview:()=>{},closeProductMasterEditor:()=>{},console:{error:()=>{}}});
 vm.runInContext(code,c);return {c,nodes,writes,alerts,invalidated:()=>invalidated};
}
test('admin saves protected cost and audit with product in one transaction',async()=>{const x=setup();await x.c.window.saveProductMasterEditor();assert.deepEqual(x.writes.map(w=>w.ref.name),['products','productCosts','priceHistory']);assert.equal(x.writes[1].data.standardCost,50);assert.equal(x.writes[2].data.previousCost,20);assert.equal(x.writes[2].data.updatedBy,'admin-id');assert.equal(x.invalidated(),1);assert.equal(x.c.purchaseCostCache.get('p'),50);assert.equal('standardCost' in x.writes[0].data,false);});
test('unchanged cost and purchaser edits do not write cost',async()=>{for(const x of [setup('admin','20','20'),setup('purchaser')]){await x.c.window.saveProductMasterEditor();assert.deepEqual(x.writes.map(w=>w.ref.name),['products']);}});
test('invalid costs do not write, zero is accepted',async()=>{for(const value of ['-1','NaN','']){const x=setup('admin',value);await x.c.window.saveProductMasterEditor();assert.equal(x.writes.length,0);assert.equal(x.alerts.length,1);}const x=setup('admin','0');await x.c.window.saveProductMasterEditor();assert.equal(x.writes[1].data.standardCost,0);});
test('failed transaction cannot change cache or publish partial writes',async()=>{const x=setup('admin','50','20',true);await x.c.window.saveProductMasterEditor();assert.equal(x.writes.length,0);assert.equal(x.invalidated(),0);assert.equal(x.c.purchaseCostCache.size,0);assert.equal(x.alerts.length,1);});

test('Service product master requires one authoritative subtype before any transaction',async()=>{
 const invalid=setup('purchaser');invalid.nodes.pmEditProductType.value='Service';
 await invalid.c.window.saveProductMasterEditor();
 assert.equal(invalid.writes.length,0);
 assert.match(invalid.alerts[0],/服務類型/);
 const wrong=setup('purchaser');wrong.nodes.pmEditProductType.value='Service';
 wrong.nodes.pmEditServiceKind.value='INVALID';
 await wrong.c.window.saveProductMasterEditor();
 assert.equal(wrong.writes.length,0);
});
test('Service product subtype saves without physical inventory tracking',async()=>{
 const x=setup('purchaser');x.nodes.pmEditProductType.value='Service';
 x.nodes.pmEditServiceKind.value='TISSUE_SLICING';
 for(const key of ['pmEditInventoryTracked','pmEditLotTracked','pmEditExpiryTracked'])
   x.nodes[key].checked=true;
 await x.c.window.saveProductMasterEditor();
 assert.deepEqual(x.writes.map(w=>w.ref.name),['products']);
 const p=x.writes[0].data;
 assert.equal(p.productType,'Service');assert.equal(p.category,'Service');
 assert.equal(p.serviceKind,'TISSUE_SLICING');
 assert.equal(p.inventoryTracked,false);assert.equal(p.lotTracked,false);assert.equal(p.expiryTracked,false);
});
test('Switching an edited Service master back to Goods clears the stale workflow classification',async()=>{
 const x=setup('purchaser');x.nodes.pmEditProductType.value='Reagent';
 x.nodes.pmEditServiceKind.value='ONSITE_REPAIR';
 x.nodes.pmEditInventoryTracked.checked=true;
 await x.c.window.saveProductMasterEditor();
 assert.equal(x.writes[0].data.serviceKind,'');
 assert.equal(x.writes[0].data.inventoryTracked,true);
});
