'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/services/dispatch-preparation.js'),'utf8');

test('dispatch service commits the order and record together, rejects duplicate preparation',async()=>{
  let order={id:'O1',status:'normal',ownerUid:'U1',salesCode:'S1',customerName:'客戶',
    items:[{itemId:'I1',itemCode:'P1',itemName:'試劑',qty:3,dispatchPreparedQty:0}]};
  const records=[],appliedUpdates=[];
  const refs={
    orders:{doc:id=>({kind:'orders',id})},
    dispatchRecords:{doc:()=>({kind:'dispatchRecords',id:'D'+(records.length+1)})}
  };
  const sandbox={
    db:{collection:name=>refs[name]},
    currentUser:{uid:'PURCHASER'},
    normalizedOrderStatus:()=> 'normal',
    normalizedOrderItems:o=>o.items.map(item=>({...item})),
    itemDispatchState:(o,item)=>({pending:Math.max(0,3-(item.dispatchPreparedQty||0)),prepared:item.dispatchPreparedQty||0}),
    orderWorkIndexFields:()=>({}),
    deliveryActor:()=> '採購員',
    YushinOrderEntry:{validateTrade:()=>({valid:true})},
    runRoleTransaction:async callback=>{
      const staging=[];
      await callback({
        get:async ref=>({exists:true,data:()=>order}),
        set:(ref,data)=>staging.push({ref,data}),
        update:(ref,data)=>staging.push({ref,data})
      });
      for(const update of staging){
        if(update.ref.kind==='orders'){order={...order,...update.data};appliedUpdates.push(update);}
        else records.push(update.data);
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source,sandbox,{filename:'dispatch-preparation.js'});
  const saved=await sandbox.prepareOrderDispatch('O1','I1');
  assert.equal(saved.items[0].dispatchPreparedQty,3);
  assert.equal(order.items[0].dispatchPreparedQty,3);
  assert.equal(records.length,1);
  assert.equal(records[0].qty,3);
  assert.equal(appliedUpdates.length,1);
  await assert.rejects(sandbox.prepareOrderDispatch('O1','I1'),/沒有待打單數量/);
  assert.equal(records.length,1);
});
