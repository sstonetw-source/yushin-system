/* Recover released free stock from durable flags on the existing location ledger. */
(function(root){
  async function recoverLocation({db,runTransaction,allocate,normalize,stockDocId,assertContext,stockId,actor}){
    assertContext();
    let initial=null;
    await runTransaction(async tx=>{
      initial=null;
      assertContext();
      const snapshot=await tx.get(db.collection('warehouseStocks').doc(stockId));
      if(!snapshot.exists||snapshot.data().allocationPending!==true)return;
      const stock=snapshot.data(),key=stock.productKey,warehouseId=stock.warehouseId;
      if(!key||!warehouseId||String(warehouseId).startsWith('custody-')||stockDocId(warehouseId,key)!==stockId)throw Error('待分配庫存的位置或產品識別不正確。');
      if(!Number.isSafeInteger(stock.allocationRevision)||stock.allocationRevision<=0)throw Error('待分配庫存缺少有效進度版本。');
      const inv=await tx.get(db.collection('inventory').doc(encodeURIComponent(key)));
      const master=await tx.get(db.collection('warehouses').doc(warehouseId));
      assertContext();
      if(!inv.exists||inv.data().productKey!==key)throw Error('公司庫存與分倉產品識別不一致，請由管理員檢查。');
      if(!master.exists||master.data().active===false||master.data().systemCustody)throw Error('待分配倉庫不存在或已停用。');
      const validStock=data=>['onHand','reserved'].every(k=>typeof data[k]==='number'&&Number.isFinite(data[k])&&data[k]>=0)&&data.reserved<=data.onHand;
      if(!validStock(stock)||!validStock(inv.data()))throw Error('公司或分倉庫存數量不正確，請由管理員檢查。');
      const free=normalize(stock).available,aggregateFree=normalize(inv.data()).available;
      initial={stock,key,warehouseId,revision:stock.allocationRevision,free,qty:Math.min(free,aggregateFree)};
    });
    if(!initial)return {completed:true,allocatedQty:0,affectedOrderIds:[]};
    // A mismatch cannot be silently cleared just because aggregate stock is exhausted.
    if(initial.free>initial.qty)throw Error('分倉有可用庫存，但公司總可用量不足，請由管理員檢查。');
    const allocation=initial.qty>0
      ?await allocate(initial.key,initial.warehouseId,initial.qty,actor,'','','receipts',assertContext)
      :{allocatedQty:0,affectedOrderIds:[],completionReason:'exhausted'};
    assertContext();
    if(!['exhausted','no-demand'].includes(allocation.completionReason))throw Error('庫存分配尚未完成，請重新處理。');
    let completed=false;
    await runTransaction(async tx=>{
      completed=false;
      assertContext();
      const ref=db.collection('warehouseStocks').doc(stockId),snapshot=await tx.get(ref);
      const inv=await tx.get(db.collection('inventory').doc(encodeURIComponent(initial.key)));
      assertContext();
      if(!snapshot.exists||!inv.exists)throw Error('庫存資料已不存在，不能清除待處理進度。');
      const stock=snapshot.data();
      if(stock.productKey!==initial.key||stock.warehouseId!==initial.warehouseId)throw Error('庫存識別已變更。');
      // A new release while scanning must survive this older worker's completion.
      if(stock.allocationRevision!==initial.revision)return;
      if(stock.allocationPending===true)tx.update(ref,{allocationPending:false});
      completed=true;
    });
    return {...allocation,completed};
  }
  const api={recoverLocation};root.YushinFreeStockRecovery=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(typeof document==='undefined')return;

  let rows=[],errors=new Map(),loading=null,context='',generation=0,cursor=null,hasMore=false;
  const scheduled=new Set(),busy=new Set();let timer=null;
  const identity=()=>String(currentUser?.uid||'')+'|'+currentUserRole;
  const allowed=()=>canReceiveInventoryCapability()&&canAccessPage('inventory');
  const guard=who=>()=>{if(!allowed()||identity()!==who)throw Error('登入帳號或角色已變更，請重新開啟倉庫。');};
  const render=()=>{
    const panel=document.getElementById('freeStockRecoveryPanel'),body=document.getElementById('freeStockRecoveryBody');
    if(!panel||!body)return;panel.hidden=!allowed()||(!rows.length&&!errors.size&&!loading&&!hasMore);if(panel.hidden)return;
    const name=id=>warehouseMasterCache.find(w=>w.id===id)?.warehouseName||id;
    document.getElementById('freeStockRecoveryStatus').textContent=loading?'正在處理釋放後的庫存分配…':errors.size?(errors.get('load')||'部分庫存分配尚未完成，請查看下方品項。'):rows.length?'庫存分配待處理。':hasMore?'還有待分配庫存，請按「處理更多」。':'庫存分配已更新。';
    body.innerHTML=rows.map(s=>`<tr><td data-th="倉庫">${escapeHtml(name(s.warehouseId))}</td><td data-th="品項">${escapeHtml(s.itemCode||s.productKey)}<br>${escapeHtml(s.itemName||'')}</td><td data-th="可用數量">${Number(inventoryNumbers(s).available)}</td><td data-th="狀態">${escapeHtml(errors.get(s.id)||'等待分配')}</td><td data-th="操作"><button type="button" class="btn-secondary" onclick="retryFreeStockRecovery(${inlineJsValue(s.id)},this)" ${busy.has(s.id)?'disabled':''}>重試分配</button></td></tr>`).join('');
    const more=document.getElementById('freeStockRecoveryMore');if(more)more.hidden=!hasMore;
  };
  const recover=async(stockId,who)=>{
    if(busy.has(stockId))return;busy.add(stockId);render();
    try{
      const result=await recoverLocation({db,runTransaction:runRoleTransaction,allocate:allocateFreeReceiptStockToShortages,
        normalize:inventoryNumbers,stockDocId:warehouseStockDocId,assertContext:guard(who),stockId,actor:deliveryActor()});
      guard(who)();errors.delete(stockId);
      if(result.completed)rows=rows.filter(s=>s.id!==stockId);
      invalidateProcurementDemandQueue();markMainPageDirty('orders.po','orders.list','admin');
      try{await refreshAffectedOrderCaches(result.affectedOrderIds||[]);}catch(_){if(identity()===who)showActionFeedback('庫存分配已完成，但畫面更新失敗；請重新開啟倉庫及訂單頁。','warning');}
      return result;
    }catch(err){if(identity()===who){errors.set(stockId,err.message);showActionFeedback('庫存已釋放，但分配尚未完成：'+err.message,'warning');}throw err;}
    finally{if(identity()===who){busy.delete(stockId);render();}}
  };
  root.resetFreeStockRecovery=function(){generation++;rows=[];errors.clear();busy.clear();scheduled.clear();context='';cursor=null;hasMore=false;loading=null;if(timer!==null)clearTimeout(timer);timer=null;render();};
  root.loadFreeStockRecovery=async function(more=false,process=true){
    if(!allowed())return;const who=identity();if(context!==who){root.resetFreeStockRecovery();context=who;}
    if(loading)return loading;const ticket=generation;
    loading=(async()=>{
      try{
        let q=db.collection('warehouseStocks').where('allocationPending','==',true).limit(50);
        if(more&&cursor)q=q.startAfter(cursor);
        const page=await firestoreReadWithTimeout(q.get(),'待分配庫存');guard(who)();if(ticket!==generation)return;
        errors.delete('load');const next=page.docs.map(d=>({...d.data(),id:d.id}));rows=more?[...rows,...next.filter(s=>!rows.some(r=>r.id===s.id))]:next;
        cursor=page.docs.at(-1)||null;hasMore=page.size===50;render();
        // Do not loop through every historical row on opening a page.
        for(const stock of process?next:[]){guard(who)();if(ticket!==generation)return;try{await recover(stock.id,who);}catch(err){if(identity()!==who)return;}}
      }catch(err){if(identity()===who&&ticket===generation){errors.set('load',err.message);showActionFeedback('待分配庫存讀取未完成：'+err.message,'warning');}}
      finally{if(identity()===who&&ticket===generation){loading=null;render();}}
    })();render();return loading;
  };
  root.retryFreeStockRecovery=async function(stockId,button){
    if(!allowed())return;const state=beginActionButton(button,'分配中…');
    try{await recover(stockId,identity());}catch(_){}finally{endActionButton(button,state);}
  };
  root.onFreeStockReleased=function(ids,uid,role){
    if(!allowed()||currentUser?.uid!==uid||currentUserRole!==role)return;
    for(const id of ids)scheduled.add(id);
    if(timer!==null)return;const who=identity(),ticket=generation;
    timer=setTimeout(async()=>{
      timer=null;if(identity()!==who||ticket!==generation||!allowed())return;
      const ids=[...scheduled];scheduled.clear();let needsRefresh=false;
      for(const id of ids){if(identity()!==who||ticket!==generation||!allowed())return;try{const result=await recover(id,who);needsRefresh=needsRefresh||!result?.completed;}catch(_){needsRefresh=true;}}
      // Show failed/newer durable jobs without immediately executing the same failure twice.
      if(needsRefresh)await root.loadFreeStockRecovery(false,false);
    },250);
  };
})(typeof globalThis!=='undefined'?globalThis:this);
