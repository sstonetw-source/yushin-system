const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const demand=require('../modules/procurement-demand-core.js');
const src=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');const start=src.indexOf('window.openInventoryReplenishment = async function');const code=src.slice(start,src.indexOf('\n};',start)+3);
function setup({exists=true,incoming=0}={}){
 const calls=[],elements=new Map(),item={id:'stored-wrong-id',stockPolicy:'SAFETY_STOCK',safetyStock:79,productId:'P1',itemCode:'06612601001',itemName:'Tubes',brand:'Roche'};
 const element=id=>{if(!elements.has(id))elements.set(id,{value:'',classList:{add:()=>calls.push(['open',id])}});return elements.get(id);};
 const x=vm.createContext({window:{},canEditPage:()=>true,actionButtonFromEventOrSelector:()=>({}),beginActionButton:()=>({}),endActionButton:()=>calls.push(['released']),
 firestoreReadWithTimeout:p=>p,db:{collection:name=>({doc:id=>({get:async()=>{calls.push(['read',name,id]);return {exists,id,data:()=>item};}})})},
 inventoryCache:[],inventorySearchResults:[],inventoryReplenishmentCache:[],warehouseStockCache:new Map([['W1||P1',{incoming:0}]]),
 inventoryStockPolicy:i=>i.stockPolicy,INVENTORY_STOCK_POLICIES:{SAFETY_STOCK:'SAFETY_STOCK'},loadInventoryReplenishmentCenter:async force=>calls.push(['reload',force]),
 loadSupplierWarehouseMasters:async()=>{},loadWarehouseStocksForInventoryPage:async rows=>{assert.equal(x.warehouseStockCache.has('W1||P1'),false);calls.push(['stocks',rows[0].id]);},
 inventoryAggregateStock:()=>({available:0,incoming}),YushinProcurementDemand:demand,procurementDemandRef:id=>({set:async record=>calls.push(['demand',id,record])}),procurementDemandDocument:(d,fields)=>({...d,...fields}),invalidateProcurementDemandQueue(){},defaultWarehouse:()=>({id:'W1'}),
 findProductByCode:async(...args)=>{calls.push(['match',...args]);return {productId:'P1',model:'06612601001',brand:'Roche',nameCn:'Tubes'};},loadVisibleProductCost:async()=>10,
 resolveBrandName:s=>s,poDirectStockMode:false,poEditingId:null,poAllItems:[],poItems:[],populatePoVendorSuggestions(){},currentUserName:'Admin',currentUser:{email:'admin@example.com'},
 document:{getElementById:element},localDateString:()=> '2026-10-04',clearPoExpectedDate(){},autoFillPoSupplier:async()=>{},switchPoCompany(){},currentCompany:'yushin',generatePoNo(){},updatePoModeUI(){},alert:s=>calls.push(['alert',s]),showActionFeedback:(...args)=>calls.push(['feedback',...args])});
 vm.runInContext(code,x);return {x,calls};
}
test('visible replenishment item still opens after all inventory caches were invalidated',async()=>{
 const {x,calls}=setup();await x.window.openInventoryReplenishment('I1');
 assert.deepEqual(calls[0],['read','inventory','I1']);assert.equal(x.poItems[0].sourceId,'I1');assert.equal(x.poItems[0].qty,79);assert.ok(calls.some(c=>c[0]==='open'));assert.deepEqual(calls.find(c=>c[0]==='match'),['match','06612601001','Roche']);assert.equal(calls.some(c=>c[0]==='alert'),false);
});
test('current incoming stock prevents redundant replenishment using stale screen totals',async()=>{
 const {x,calls}=setup({incoming:79});await x.window.openInventoryReplenishment('I1');assert.equal(calls.some(c=>c[0]==='demand'||c[0]==='open'),false);assert.match(calls.find(c=>c[0]==='alert')[1],/不需重複建立/);assert.ok(calls.some(c=>c[0]==='released'));
});
test('deleted inventory refreshes the screen without creating a procurement demand',async()=>{
 const {x,calls}=setup({exists:false});await x.window.openInventoryReplenishment('I1');assert.deepEqual(calls.find(c=>c[0]==='reload'),['reload',true]);assert.equal(calls.some(c=>c[0]==='demand'||c[0]==='open'),false);assert.ok(calls.some(c=>c[0]==='released'));
});
