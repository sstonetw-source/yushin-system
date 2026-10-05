const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const code=source.slice(source.indexOf('let inventoryReceivingWorkCount ='),source.indexOf('let inventoryCache=[]'));
function setup(){
 const button={textContent:''},calls=[];
 const c=vm.createContext({document:{getElementById:id=>id==='inventoryReceivingTabBtn'?button:null},
 inventoryPendingSupplyError:'',activeReceivingSupplyError:'',orderWorkQueueError:'',inventoryPendingSupplyLoading:false,
 purchasingReceivingReady:true,activeReceivingSupplyReady:true,orderWorkQueueReady:true,
 supplyReceivingCache:Array.from({length:75},(_,i)=>({id:'S'+i})),
 loadPurchasingReceivingQueue:async(...args)=>calls.push(['receiving',...args]),
 loadOrderWorkQueue:async(...args)=>calls.push(['work',...args]),mergeReceivingSourceOrdersIntoOrderCache:()=>calls.push(['merge'])});
 vm.runInContext(code,c);return {c,button,calls};
}
test('badge displays complete count, including zero; loading and error never masquerade as zero',()=>{
 const {c,button}=setup();c.updateInventoryReceivingCount(75);assert.equal(button.textContent,'待收貨（75 筆）');
 c.updateInventoryReceivingCount(0);assert.equal(button.textContent,'待收貨（0 筆）');
 c.inventoryPendingSupplyLoading=true;c.updateInventoryReceivingCount();assert.equal(button.textContent,'待收貨（讀取中…）');
 c.inventoryPendingSupplyError='offline';c.updateInventoryReceivingCount();assert.equal(button.textContent,'待收貨（讀取失敗）');
 c.inventoryPendingSupplyError='';c.inventoryPendingSupplyLoading=false;c.activeReceivingSupplyReady=false;
 c.updateInventoryReceivingCount();assert.equal(button.textContent,'待收貨（讀取中…）');
});
test('summary reuses receiving and active work queries, without limiting to the 50-row history page',async()=>{
 const {c,calls}=setup();const rows=await c.loadInventoryReceivingSummary();assert.equal(rows.length,75);
 assert.equal(calls.filter(call=>call[0]==='receiving').length,1);assert.equal(calls.filter(call=>call[0]==='work').length,1);
 assert.equal(calls[0][2].reuseOrders,true);assert.equal(calls.at(-1)[0],'merge');
});
test('incomplete active work query leaves count unconfirmed',async()=>{
 const {c}=setup();c.orderWorkQueueReady=false;c.orderWorkQueueError='offline';
 await assert.rejects(c.loadInventoryReceivingSummary(),/offline/);
 c.updateInventoryReceivingCount();assert.equal(c.document.getElementById('inventoryReceivingTabBtn').textContent,'待收貨（讀取失敗）');
});
