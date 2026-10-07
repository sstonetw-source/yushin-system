const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const batchCode=source.slice(source.indexOf('async function openProductManagementProductsInPurchase('),source.indexOf('window.openDirectStockPurchase ='));
function context({allowed=true,inactive=false,failed=false}={}) {
 const reads=[],errors=[];let cleared=0;
 const c=vm.createContext({window:{},poItems:[],poAllItems:[],canEditPage:()=>allowed,
 actionButtonFromEventOrSelector:()=>({}),beginActionButton:()=>({}),endActionButton:()=>{},
 firestoreReadWithTimeout:p=>p,db:{collection:name=>({doc:id=>({get:async()=>{reads.push([name,id]);if(failed)throw Error('offline');return {exists:true,data:()=>name==='products'?{productName:id,active:!inactive}:{standardCost:id==='a'?25:0}};}})})},
 openDirectStockPurchase:async()=>{},emptyDirectPoItem:()=>({sourceType:'STOCK_REPLENISHMENT',fulfillmentType:'WAREHOUSE',qty:1}),
 productManagementSource:p=>({productId:p.productId,itemName:p.productName,qty:1}),renderPoItemsTable:()=>{},updatePoModeUI:()=>{},
 showActionFeedback:m=>errors.push(m),selectedProductManagementProducts:()=>[{productId:'a'},{productId:'b'}],clearProductManagementSelection:()=>cleared++});
 vm.runInContext(batchCode,c);return {c,reads,errors,cleared:()=>cleared};
}
test('selected products share one stock purchase draft with current costs, including zero',async()=>{const x=context();await x.c.window.addProductManagementSelectionToPurchase();assert.equal(x.c.poItems.length,2);assert.equal(x.c.poItems[0].unitPrice,25);assert.equal(x.c.poItems[1].unitPrice,0);assert.equal(x.c.poItems[0].sourceType,'STOCK_REPLENISHMENT');assert.equal(x.c.poAllItems,x.c.poItems);assert.equal(x.cleared(),1);assert.equal(x.reads.length,4);});
test('unauthorized purchase reads nothing and retains selection',async()=>{const x=context({allowed:false});await x.c.window.addProductManagementSelectionToPurchase();assert.equal(x.reads.length,0);assert.equal(x.cleared(),0);});
for(const setting of ['inactive','failed'])test(setting+' product read prevents draft creation and retains selection',async()=>{const x=context({[setting]:true});await x.c.window.addProductManagementSelectionToPurchase();assert.equal(x.c.poItems.length,0);assert.equal(x.cleared(),0);assert.equal(x.errors.length,1);});
