'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('src/features/orders/order-workspace.js','utf8');
const action=source.slice(source.indexOf('window.saveSelfOrder ='),source.indexOf('function isDeletableOrderDraft'));
test('manual self-order form retains the same operation ID after failed response, then resets after success',async()=>{
 const fields={selfOrderOrderId:{value:'O'},selfOrderItemId:{value:'I'},selfOrderSupplier:{value:'Vendor'},selfOrderQty:{value:'2'},
   selfOrderUnitCost:{value:'0'},selfOrderDate:{value:'2026-10-16'},selfOrderNotes:{value:''},saveSelfOrderBtn:{disabled:false}};
 let ids=0;const requests=[];
 const c=vm.createContext({window:{},currentUser:{uid:'U'},canBusinessSelfOrder:()=>true,
   document:{getElementById:id=>fields[id]||null},lifecycleRecordId:()=> 'ID-'+(++ids),ordersCache:[{id:'O'}],
   commitSelfOrderSupply:async(_order,_item,request)=>{requests.push(request);if(requests.length===1)throw Error('response lost');return {order:{items:[]},internalNo:'SO'};},
   syncOrderIntoPurchasingCaches:()=>{},writeAppDataCache:()=>{},invalidateProcurementDemandQueue:()=>{},closeSelfOrderModal:()=>{},alert:()=>{}});
 vm.runInContext('let selfOrderSupplyAttempt=null;\n'+action,c);
 await c.window.saveSelfOrder();await c.window.saveSelfOrder();
 assert.equal(requests[0].operationId,'ID-1');assert.equal(requests[1].operationId,'ID-1');assert.equal(fields.saveSelfOrderBtn.disabled,false);
 await c.window.saveSelfOrder();assert.equal(requests[2].operationId,'ID-2');
});
