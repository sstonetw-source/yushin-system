(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.YushinReservation=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 const n=v=>Math.max(0,Number(v||0));
 function allocateReceiptToShortages(shortages,receivedQty){
   let remaining=n(receivedQty);
   const allocations=[];
   const ordered=[...(shortages||[])].filter(x=>n(x.shortageQty)>0).sort((a,b)=>{
     const d=String(a.orderDate||'').localeCompare(String(b.orderDate||''));
     if(d)return d;
     return String(a.orderId||'').localeCompare(String(b.orderId||''))||String(a.itemId||'').localeCompare(String(b.itemId||''));
   });
   for(const row of ordered){
     if(remaining<=0)break;
     const qty=Math.min(remaining,n(row.shortageQty));
     if(qty>0){allocations.push({...row,qty});remaining-=qty;}
   }
   return {allocations,unallocatedQty:remaining,allocatedQty:n(receivedQty)-remaining};
 }
 return {allocateReceiptToShortages};
});
