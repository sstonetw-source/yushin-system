(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.YushinReservation=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 const n=v=>Math.max(0,Number(v||0));
 function planShortageAllocation(reservations=[],availableQty=0){
   let remaining=n(availableQty);
   const rows=reservations.map((row,index)=>({...row,__index:index}))
     .filter(row=>n(row.shortageQty)>0)
     .sort((a,b)=>String(a.orderDate||'9999-12-31').localeCompare(String(b.orderDate||'9999-12-31'))||String(a.orderId||'').localeCompare(String(b.orderId||''))||String(a.itemId||'').localeCompare(String(b.itemId||'')));
   const allocations=[];
   for(const row of rows){
     if(remaining<=0)break;
     const qty=Math.min(remaining,n(row.shortageQty));
     if(qty<=0)continue;
     allocations.push({orderId:row.orderId||'',itemId:row.itemId||'',reservationId:row.id||'',qty});
     remaining-=qty;
   }
   return {allocations,allocatedQty:n(availableQty)-remaining,remainingQty:remaining};
 }
 return {planShortageAllocation};
});
