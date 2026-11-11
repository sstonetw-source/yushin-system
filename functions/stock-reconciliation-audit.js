'use strict';

// Read-only stock ledger preflight. Does not assert lot-cost correctness.
const LIMIT=1000;
const FIELDS=['onHand','reserved','incoming','transferReserved','transferInTransit','transferFreeInTransit'];
const close=(left,right)=>Math.abs(left-right)<1e-7;
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=160
 &&value===value.trim()&&!/[\x00-\x1f/]/.test(value);

function numbers(value){
 const result={};
 for(const field of FIELDS){
  const n=value[field]===undefined?0:value[field];
  if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>1e9)return null;
  result[field]=n;
 }
 if(result.transferReserved>result.reserved+1e-7
  ||result.reserved+result.transferFreeInTransit>result.onHand+1e-7
  ||result.transferFreeInTransit>result.transferInTransit+1e-7)return null;
 return result;
}

function reconcileStockRows(inventory,warehouses){
 const problems=[],company=new Map(),totals=new Map();
 const problem=(kind,id)=>problems.push({kind,id});
 for(const row of inventory){
  const data=row.data,key=data.productKey||data.productId;
  if(!validId(key)||row.id!==encodeURIComponent(key)||company.has(key)
   ||(data.productKey&&data.productKey!==key)||(data.productId&&data.productId!==key)){
   problem('INVALID_COMPANY_ID',row.id);continue;
  }
  const stock=numbers(data);
  if(!stock){problem('INVALID_COMPANY_STOCK',row.id);continue;}
  company.set(key,stock);
 }
 for(const row of warehouses){
  const data=row.data,key=data.productKey,warehouse=data.warehouseId;
  if(!validId(key)||!validId(warehouse)
   ||row.id!==encodeURIComponent(warehouse)+'__'+encodeURIComponent(key)
   ||(data.productId&&data.productId!==key)){
   problem('INVALID_WAREHOUSE_ID',row.id);continue;
  }
  const stock=numbers(data);
  if(!stock){problem('INVALID_WAREHOUSE_STOCK',row.id);continue;}
  if(!totals.has(key))totals.set(key,{onHand:0,reserved:0,incoming:0,transferReserved:0});
  const sum=totals.get(key);
  for(const field of Object.keys(sum))sum[field]+=stock[field];
 }
 for(const [key,stock] of company){
  const sum=totals.get(key)||{onHand:0,reserved:0,incoming:0,transferReserved:0};
  if(!close(stock.onHand,sum.onHand+stock.transferInTransit))problem('ON_HAND_MISMATCH',encodeURIComponent(key));
  if(!close(stock.reserved,sum.reserved+stock.transferInTransit-stock.transferFreeInTransit))
   problem('RESERVED_MISMATCH',encodeURIComponent(key));
  if(!close(stock.incoming,sum.incoming))problem('INCOMING_MISMATCH',encodeURIComponent(key));
  if(!close(stock.transferReserved,sum.transferReserved))problem('TRANSFER_RESERVED_MISMATCH',encodeURIComponent(key));
 }
 for(const key of totals.keys())if(!company.has(key))problem('MISSING_COMPANY_STOCK',encodeURIComponent(key));
 return {status:problems.length?'MISMATCH':'CONSISTENT',companyCount:inventory.length,
  warehouseCount:warehouses.length,lotCostStatus:'NOT_AUDITED',problems};
}

async function auditStockReconciliation(db){
 return db.runTransaction(async tx=>{
  const inventory=await tx.get(db.collection('inventory').limit(LIMIT+1));
  const warehouses=await tx.get(db.collection('warehouseStocks').limit(LIMIT+1));
  if(inventory.size>LIMIT||warehouses.size>LIMIT)return {status:'INCONCLUSIVE',reason:'AUDIT_LIMIT_EXCEEDED',
   companyCount:inventory.size,warehouseCount:warehouses.size,lotCostStatus:'NOT_AUDITED',problems:[]};
  return reconcileStockRows(inventory.docs.map(doc=>({id:doc.id,data:doc.data()})),
   warehouses.docs.map(doc=>({id:doc.id,data:doc.data()})));
 },{readOnly:true});
}

module.exports={reconcileStockRows,auditStockReconciliation};
