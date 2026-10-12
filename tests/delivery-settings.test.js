const test=require('node:test'),assert=require('node:assert/strict');
const settings=require('../modules/delivery-settings'),logistics=require('../modules/warehouse-logistics');
test('sales collection follows saved pickup preferences instead of region and snapshots addresses',()=>{
 const south={name:'南區業務',phone:'123',region:'SOUTH',deliveryDefaults:{mode:'PICKUP'}};
 assert.equal(settings.salespersonPlan(south,'MAIN').mode,'PICKUP');
 const north={name:'北區業務',region:'NORTH',deliveryDefaults:{mode:'SALES_SHIP',contact:'代送人',phone:'456',address:'高雄代送地址'}};
 const p=settings.salespersonPlan(north,'MAIN');assert.equal(p.mode,'SALES_SHIP');assert.equal(p.warehouseId,'');assert.equal(p.address,'高雄代送地址');
 north.deliveryDefaults.address='新地址';assert.equal(p.address,'高雄代送地址');
});
test('saved customer addresses preserve separate recipients and discard duplicate IDs',()=>{
 const input=[{id:'a',contact:'A',phone:'123',address:' 北區 '},{id:'b',contact:'B',address:'南區'},{id:'a',address:'bad'},{}];
 const list=settings.addresses(input);assert.equal(list.length,2);assert.equal(list[0].address,'北區');list[0].address='本次';assert.equal(input[0].address,' 北區 ');
});
test('physical handoff and in-transit items lock commercial recipient edits, arrived items remain editable',()=>{
 const i={qty:5,deliveredQty:0,warehouseId:'MAIN',receivedQty:5};assert.equal(settings.editableItem(i),true);
 for(const patch of [{transferPendingId:'T'},{warehouseId:'custody-S'},{deliveredQty:5},{fulfillmentType:'DIRECT_SHIP'}])assert.equal(settings.editableItem({...i,...patch}),false);
 assert.equal(settings.editableItem({...i,deliveredQty:2}),true);
});
test('branch collection routes to main without destroying the final recipient snapshot',()=>{
 const warehouses=[{id:'MAIN',warehouseName:'主倉',contact:'倉管',phone:'123',address:'主倉地址'},{id:'EXT',warehouseName:'分倉'}];
 const raw={mode:'PICKUP',warehouseId:'MAIN',contact:'業務',phone:'456',address:''},row={warehouseId:'EXT',item:{deliveryPlan:raw},order:{}};
 const execution=logistics.executionPlan(row,warehouses,'MAIN');assert.equal(execution.mode,'TRANSFER');assert.equal(execution.address,'主倉地址');assert.equal(raw.mode,'PICKUP');
 assert.equal(logistics.executionPlan({...row,warehouseId:'MAIN'},warehouses,'MAIN').mode,'PICKUP');
 assert.equal(logistics.executionPlan({...row,item:{deliveryPlan:{mode:'SALES_SHIP',contact:'業務',phone:'456',address:'南區'}}},warehouses,'MAIN').mode,'SALES_SHIP');
});
test('transfer requirements include unarrived demand but exclude cancelled, shipped, transit and direct-shipped items',()=>{
 const wh=[{id:'MAIN'},{id:'EXT'}],helpers={status:o=>o.status||'normal',incomplete:o=>!!o.syncing,items:o=>o.items,dispatch:(_o,i)=>({shippable:i.ready||0})};
 const item={itemId:'A',productId:'P',qty:8,deliveredQty:2,warehouseId:'EXT',ready:3,deliveryPlan:{mode:'PICKUP',warehouseId:'MAIN'}};
 const orders=[{id:'O',items:[item]},{id:'C',status:'cancelled',items:[item]},{id:'T',items:[{...item,transferPendingId:'T'}]},{id:'D',items:[{...item,fulfillmentType:'DIRECT_SHIP'}]},{id:'F',items:[{...item,deliveredQty:8}]}];
 const rows=logistics.transferRequirements(orders,wh,'MAIN',helpers);assert.equal(rows.length,1);assert.equal(rows[0].qty,6);assert.equal(rows[0].readyQty,3);
});
test('shipping aggregation sums cross-order product demand once and separates distinct products with identical codes',()=>{
 const p={mode:'CUSTOMER_SHIP',contact:'收件人',phone:'123',address:'同地址'},item={productId:'P',itemCode:'001',itemName:'試劑'};
 const rows=[{key:'O1__A',warehouseId:'EXT',order:{id:'O1'},item,qty:3},{key:'O2__A',warehouseId:'EXT',order:{id:'O2'},item,qty:4},{key:'O3__A',warehouseId:'EXT',order:{id:'O3'},item:{...item,productId:'OTHER'},qty:2}];
 const a=logistics.aggregateRows([...rows,rows[0]]);assert.equal(a.length,2);assert.equal(a[0].qty,7);assert.equal(a[1].qty,2);assert.deepEqual(a[0].rows.map(r=>r.order.id),['O1','O2']);
 const csv=logistics.csvDocument(logistics.partition(rows,()=>p));assert.match(csv,/O1 × 3；O2 × 4/);assert.match(csv,/"7","7"/);
 assert.equal(logistics.partition([...rows,{...rows[0],warehouseId:'OTHER'}],()=>p).length,2);
});
const fs=require('node:fs'),vm=require('node:vm');
test('admin personnel reload and shared cache retain every salesperson delivery default',async()=>{
 const src=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
 const defaults={mode:'SALES_SHIP',contact:'南區業務',phone:'123',address:'高雄地址'};
 const rows=[{id:'S',name:'南區業務',code:'01',deliveryDefaults:defaults},{id:'N',name:'北區業務',code:'02'}];
 const c=vm.createContext({window:{},readCollectionInBatches:async()=>rows,trueUserRole:'admin',allUsersCache:[],salesList:[],
  populateSalesDropdown(){},populateEquipmentSalesDropdown(){},syncSalesCodeMasterFromUsers:async()=>{},loadSalesCodeMaster:async()=>{},
  renderAdminSalesTable(){},populateTransferDropdowns(){},console,mainPageLoadFailed(){throw Error('reload failed');}});
 vm.runInContext(src.slice(src.indexOf('function applySalesRows('),src.indexOf('function applyCompanyTheme(')),c);
 const start=src.indexOf('window.reloadSalesFromUsers = function()');
 vm.runInContext(src.slice(start,src.indexOf('\n/* ----------',start)),c);
 await c.window.reloadSalesFromUsers();
 assert.equal(c.allUsersCache.find(u=>u.uid==='S').deliveryDefaults.address,'高雄地址');
 assert.equal(Object.keys(c.allUsersCache.find(u=>u.uid==='N').deliveryDefaults).length,0);
 // initSalesList uses the administrator cache instead of rereading users.
 c.readCollectionInBatches=()=>{throw Error('unexpected extra read');};
 await c.initSalesList();
 const p=settings.salespersonPlan(c.salesList.find(u=>u.uid==='S'),'MAIN');
 assert.equal(p.mode,'SALES_SHIP');assert.equal(p.address,'高雄地址');assert.equal(p.phone,'123');
});
function uiFixture(){
 const nodes=new Map(),reads=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:'',textContent:'',style:{display:'',setProperty(k,v){this[k]=v;}},closest(){return {style:this.style,querySelector:()=>null};},classList:{add(){},remove(){}},remove(){nodes.delete(id);},prepend(){},set innerHTML(html){this.html=html;for(const m of html.matchAll(/id="([^"]+)"/g))node(m[1]);},get innerHTML(){return this.html||'';}});return nodes.get(id);};
 const context={document:{getElementById:id=>nodes.get(id)||null,createElement:()=>node('generated')},currentUser:{uid:'S'},currentUserRole:'sales',salesList:[{uid:'S',name:'Sales',phone:'123',deliveryDefaults:{mode:'SALES_SHIP',address:'業務地址'}}],
  defaultWarehouse:()=>({id:'MAIN'}),customerIdForName:n=>n.trim().toLowerCase(),escapeHtml:String,escapeAttr:String,YushinWarehouseLogistics:logistics,
  firestoreReadWithTimeout:p=>p,db:{collection:()=>({doc:key=>({get:()=>new Promise(resolve=>reads.push({key,resolve}))})})},
  setOrderShippingInstructions(p){for(const key of ['mode','warehouseId','contact','phone','address','packages','condition','tracking','notes'])node('orderShipping'+({warehouseId:'Warehouse'}[key]||key[0].toUpperCase()+key.slice(1))).value=String(p[key]??(key==='packages'?1:''));},
 };
 for(const id of ['orderShippingFields','orderCustomer','orderOwnerUid'])node(id);
 const c=vm.createContext(context);vm.runInContext(fs.readFileSync('modules/delivery-settings.js','utf8'),c);c.setOrderShippingInstructions({});return {c,node,reads};
}
const customerSnapshot=(name='A')=>({exists:true,data:()=>({shippingAddresses:[{id:'default',contact:name,phone:'123',address:name+'地址'}],defaultShippingAddressId:'default'})});
test('new order autofills salesperson preferences and preserves manual edits through background warehouse initialization',()=>{
 const f=uiFixture();f.c.initializeOrderDeliveryDefaults();assert.equal(f.c.orderShippingInstructions().mode,'SALES_SHIP');assert.equal(f.node('orderShippingAddress').value,'業務地址');
 f.node('orderShippingAddress').value='本次地址';f.node('orderShippingFields').oninput({target:{id:'orderShippingAddress'}});f.c.initializeOrderDeliveryDefaults();assert.equal(f.node('orderShippingAddress').value,'本次地址');
});
test('late customer lookup cannot overwrite a newer customer, typed address, or a new modal session',async()=>{
 const f=uiFixture();f.node('orderShippingMode').value='CUSTOMER_SHIP';f.node('orderCustomer').value='A';const first=f.c.loadOrderCustomerAddresses();
 f.c.orderDeliveryCustomerTyping();f.node('orderCustomer').value='B';const second=f.c.loadOrderCustomerAddresses();f.reads[1].resolve(customerSnapshot('B'));await second;assert.equal(f.node('orderShippingAddress').value,'B地址');
 f.reads[0].resolve(customerSnapshot('A'));await first;assert.equal(f.node('orderShippingAddress').value,'B地址');
 const third=f.c.loadOrderCustomerAddresses();f.node('orderShippingAddress').value='臨時地址';f.reads[2].resolve(customerSnapshot('B'));await third;assert.equal(f.node('orderShippingAddress').value,'臨時地址');
 const fourth=f.c.loadOrderCustomerAddresses();f.c.setOrderShippingInstructions({mode:'CUSTOMER_SHIP',address:'另一筆草稿'});f.reads[3].resolve(customerSnapshot('B'));await fourth;assert.equal(f.node('orderShippingAddress').value,'另一筆草稿');
});
test('switching delivery back to salesperson and account reset discard pending customer lookup results',async()=>{
 const f=uiFixture();f.node('orderShippingMode').value='CUSTOMER_SHIP';f.node('orderCustomer').value='A';const first=f.c.loadOrderCustomerAddresses();
 f.node('orderShippingMode').value='SALES_SHIP';f.c.orderDeliveryChoiceChanged();f.reads[0].resolve(customerSnapshot());await first;assert.equal(f.node('orderShippingAddress').value,'業務地址');
 f.node('orderShippingMode').value='CUSTOMER_SHIP';const second=f.c.loadOrderCustomerAddresses();f.c.resetDeliverySettings();f.reads[1].resolve(customerSnapshot());await second;assert.equal(f.node('orderShippingAddress').value,'業務地址');
});
