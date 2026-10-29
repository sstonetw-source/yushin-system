'use strict';
const {compareReservationPriority}=require('./shared/reservation-core');
function planAllocationBatch(candidates,availableQty,receiptRemainingQty,maxItems=15){
 if(!Array.isArray(candidates)||candidates.length>100||!Number.isSafeInteger(maxItems)||maxItems<1||maxItems>15
  ||!Number.isSafeInteger(availableQty)||availableQty<0
  ||!Number.isSafeInteger(receiptRemainingQty)||receiptRemainingQty<0)throw Error('分配數量或讀寫預算不正確');
 const rows=[...candidates].sort(compareReservationPriority),seen=new Set(),allocations=[];
 // Validate the entire bounded input before proposing any allocation.
 for(const row of rows){
  if(!row||typeof row.id!=='string'||!row.id||seen.has(row.id)
   ||typeof row.orderId!=='string'||!row.orderId||typeof row.itemId!=='string'||!row.itemId
   ||!Number.isSafeInteger(row.shortageQty)||row.shortageQty<=0)throw Error('缺貨來源重複或不正確');
  seen.add(row.id);
 }

 let remaining=Math.min(availableQty,receiptRemainingQty);
 for(const row of rows){
  if(remaining<=0||allocations.length>=maxItems)break;
  const qty=Math.min(remaining,row.shortageQty);
  allocations.push({reservationId:row.id,orderId:row.orderId,itemId:row.itemId,qty});
  remaining-=qty;
 }
 return {allocations,allocatedQty:Math.min(availableQty,receiptRemainingQty)-remaining,
  unallocatedQty:remaining,needsContinuation:remaining>0&&rows.length>allocations.length};
}
module.exports={planAllocationBatch};
