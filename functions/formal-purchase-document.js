'use strict';
// Document intent only. Auth, demand, warehouse and quantity authority remain
// in the existing transaction validator and Procurement Demand Core.
const supplierCore=require('./shared/supplier-core');
function fail(message){const error=new Error(message);error.code='invalid-argument';throw error;}
function exact(value,keys){
 return value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).sort().join(',')===keys.split(',').sort().join(',');
}
function text(value,label,max=200){
 if(typeof value!=='string'||value!==value.trim()||value.length>max||/[\x00-\x1f]/.test(value))fail(label+'不正確');
 return value;
}
function optionalDate(value){
 if(value==='')return '';
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)
   ||!Number.isFinite(Date.parse(value+'T00:00:00Z'))
   ||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('採購交期不正確');
 return value;
}
function normalizePurchaseDocument(input,lineCount,supplier){
 if(!exact(input,'company,supplierSnapshot,expectedDate,expectedDateSource,lineScheduleDates')
   ||!['yushin','morningstar','MULTI-LIFE'].includes(input.company))fail('採購文件欄位或公司不正確');
 const snapshot=input.supplierSnapshot;
 if(!exact(snapshot,'supplierId,supplierName,purchaseHeaderName,email,leadTimeDays'))fail('供應商快照欄位不正確');
 const supplierId=text(snapshot.supplierId,'供應商識別',160);
 const supplierName=text(snapshot.supplierName,'供應商名稱');
 const purchaseHeaderName=text(snapshot.purchaseHeaderName,'供應商抬頭');
 const email=text(snapshot.email,'供應商信箱',254);
 if(!supplierName||!purchaseHeaderName||supplierName!==supplier
   ||!supplierCore.isValidEmail(email)||!Number.isSafeInteger(snapshot.leadTimeDays)
   ||snapshot.leadTimeDays<0||snapshot.leadTimeDays>36500)fail('供應商快照內容不正確');
 const expectedDate=optionalDate(input.expectedDate);
 if(!['','manual','lead-time'].includes(input.expectedDateSource))fail('採購交期來源不正確');
 if(!Array.isArray(input.lineScheduleDates)||input.lineScheduleDates.length!==lineCount)fail('採購品項交期數量不正確');
 return {company:input.company,supplierSnapshot:{supplierId,supplierName,purchaseHeaderName,email,leadTimeDays:snapshot.leadTimeDays},
  expectedDate,expectedDateSource:input.expectedDateSource,lineScheduleDates:input.lineScheduleDates.map(optionalDate)};
}
function purchaseDocumentFields(intent,items,buyerName){
 if(!intent.document)return {};
 const header=intent.document,snapshot=header.supplierSnapshot;
 const orderIds=[...new Set(items.map(item=>item.orderId))];
 const fields={company:header.company,vendorName:snapshot.purchaseHeaderName,
  supplierName:snapshot.supplierName,supplierId:snapshot.supplierId,supplierEmail:snapshot.email,
  supplierSnapshot:snapshot,expectedDate:header.expectedDate,
  expectedDateSource:header.expectedDateSource,scheduleDate:header.expectedDate,
  ...supplierCore.purchaseAmountMetadata(items),
  sourceType:orderIds.length===1?'order':'',sourceId:orderIds.length===1?orderIds[0]:'',
  linkedDocuments:orderIds.map(id=>({type:'order',id,relation:'source'}))};
 fields.searchTokens=supplierCore.purchaseOrderSearchTokens({...fields,poNo:intent.poNo,poDate:intent.poDate,buyerName,items});
 return fields;
}
module.exports={normalizePurchaseDocument,purchaseDocumentFields};
