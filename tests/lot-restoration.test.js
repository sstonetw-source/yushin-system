const test=require('node:test'),assert=require('node:assert/strict');
const inventory=require('../modules/inventory-core');
const plan=inventory.planLotRestoration;
const lot=(id,remainingQty=2)=>({id,productKey:'P',warehouseId:'W',remainingQty});
const input=()=>({productKey:'P',warehouseId:'W',allocations:[{lotId:'L',qty:1},{lotId:'L',qty:2}],lots:[lot('L')]});
test('restoration groups repeated original lot allocations before computing one authoritative update',()=>{
 const source=input(),before=structuredClone(source);
 assert.deepEqual(plan(source),[{lotId:'L',remainingQty:5,qtyDelta:3}]);assert.deepEqual(source,before);
 assert.deepEqual(plan({...source,lots:[lot('L',5)],direction:-1}),[{lotId:'L',remainingQty:2,qtyDelta:-3}]);
});
test('return correction checks the total removal from a repeated lot, not each row separately',()=>{
 assert.throws(()=>plan({...input(),direction:-1}),/庫存不足/);
});
test('all original lots must exist and match the product and intended physical warehouse',()=>{
 for(const change of [[],[{...lot('L'),warehouseId:'OTHER'}],[{...lot('L'),productKey:'OTHER'}],
  [{id:'L',remainingQty:2}],[lot('L'),lot('L')]])assert.throws(()=>plan({...input(),lots:change}));
});
test('a bad later lot prevents any complete plan and never mutates earlier lots',()=>{
 const source={...input(),allocations:[{lotId:'L',qty:1},{lotId:'M',qty:1}],lots:[lot('L'),{...lot('M'),warehouseId:'OTHER'}]};
 const before=structuredClone(source);assert.throws(()=>plan(source),/倉庫不一致/);assert.deepEqual(source,before);
});
test('raw batch balances and allocation quantities fail closed instead of being clamped',()=>{
 for(const value of [null,NaN,Infinity,-1,'','bad',true]){
  assert.throws(()=>plan({...input(),lots:[lot('L',value)]}));
  assert.throws(()=>plan({...input(),allocations:[{lotId:'L',qty:value}]}));
 }
 for(const patch of [{direction:0},{direction:'1'},{productKey:''},{warehouseId:''},{allocations:[]},
  {allocations:[{qty:1}]},{allocations:[{lotId:'L',qty:0}]}])assert.throws(()=>plan({...input(),...patch}));
});
test('legacy fractional balances and numeric strings retain their exact arithmetic',()=>{
 assert.deepEqual(plan({...input(),allocations:[{lotId:'L',qty:'0.5'}],lots:[lot('L','1.5')]}),[{lotId:'L',remainingQty:2,qtyDelta:0.5}]);
});
test('reversal preserves original cost-lot lineage without reading or inventing costs',()=>{
 const reversed=inventory.reverseLotAllocations([{qty:1,lotAllocations:[{lotId:'L',costLotId:'SOURCE-COST',qty:1}]}],1);
 assert.equal(reversed.allocations[0].costLotId,'SOURCE-COST');
 assert.equal(plan({...input(),allocations:reversed.allocations})[0].remainingQty,3);
});
