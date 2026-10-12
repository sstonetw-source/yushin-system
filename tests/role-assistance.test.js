const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function fn(name){const start=src.indexOf('function '+name+'(');assert.ok(start>=0);return src.slice(start,src.indexOf('\n}',start)+2);}

test('purchaser owner picker accepts active sales and engineers and preserves engineer selection',()=>{
 const people=[
  {uid:'s',name:'業務',code:'S',role:'sales'},
  {uid:'e',name:'工程師',code:'E',role:'engineer'},
  {uid:'p',name:'採購',code:'P',role:'purchaser'},
  {uid:'w',name:'倉管',code:'W',role:'warehouse'},
  {uid:'off',name:'停用',code:'O',role:'engineer',active:false},
  {uid:'disabled',name:'停用',code:'D',role:'sales',disabled:true},
  {uid:'no-code',name:'缺代號',role:'engineer'}
 ];
 const select={value:'',options:[],replaceChildren(...options){this.options=options;},add(option){this.options.push(option);}};
 const wrap={style:{}};
 const context=vm.createContext({currentUserRole:'purchaser',requestedOrderOwnerUid:'e',salesList:people,ROLE_LABELS:{sales:'業務',engineer:'工程師'},Option:class{constructor(text,value){Object.assign(this,{text,value});}},document:{getElementById:id=>id==='orderOwnerUid'?select:wrap}});
 vm.runInContext(fn('isSelectableCommercialOwner')+fn('populateOrderOwnerSelect'),context);
 context.populateOrderOwnerSelect();
 assert.deepEqual(select.options.map(x=>x.value),['','s','e']);
 assert.equal(select.value,'e');assert.match(select.options[2].text,/工程師/);
 context.requestedOrderOwnerUid='disabled';context.populateOrderOwnerSelect();assert.equal(select.value,'');
 for(const role of ['sales','engineer','warehouse']){context.currentUserRole=role;context.populateOrderOwnerSelect();assert.equal(wrap.style.display,'none');}
});

test('role capabilities preserve purchaser warehouse work and engineer business work without Forecast',()=>{
 const context=vm.createContext({});
 vm.runInContext(['hasBusinessCapability','canCreateForecastCapability','canSelfOrderCapability','canManageOrderLifecycleCapability','canCreatePurchaseOrderCapability','canReceiveInventoryCapability','canManageEquipmentCapability'].map(fn).join('\n'),context);
 assert.equal(context.canReceiveInventoryCapability('purchaser'),true);
 assert.equal(context.canCreatePurchaseOrderCapability('warehouse'),false);
 assert.equal(context.canReceiveInventoryCapability('warehouse'),true);
 assert.equal(context.canSelfOrderCapability('engineer'),true);
 assert.equal(context.canManageOrderLifecycleCapability('engineer'),true);
 assert.equal(context.canManageEquipmentCapability('engineer'),true);
 assert.equal(context.canCreateForecastCapability('engineer'),false);
 assert.equal(context.canCreateForecastCapability('purchaser'),false);
 assert.equal(context.canManageOrderLifecycleCapability('purchaser'),false);
});

test('purchaser can edit saved quotes while warehouse stays outside quote workflows',()=>{
 const start=src.indexOf('const rolePermissions ='),end=src.indexOf('let currentUserName',start);
 const context=vm.createContext({});vm.runInContext(src.slice(start,end)+'\nglobalThis.permissions=rolePermissions;',context);
 assert.equal(context.permissions.purchaser['quote.my'],'edit');
 assert.equal(context.permissions.purchaser['quote.create'],'edit');
 assert.equal(context.permissions.warehouse.quote,'none');
 assert.equal(context.permissions.engineer.forecast,'none');
});

test('purchaser cannot cancel linked customer orders through quote cancellation',async()=>{
 const start=src.indexOf('window.unmarkQuoteAsDeal ='),end=src.indexOf('\n};',start)+3;
 const context=vm.createContext({window:{},canManageOrderLifecycleCapability:()=>false,canEditPage:()=>true,actionButtonFromEventOrSelector:()=>{throw Error('must reject before cancellation controls or reads');}});
 vm.runInContext(src.slice(start,end),context);await context.window.unmarkQuoteAsDeal('Q1');
});
