// Ephemeral read model; no writes, persistent cache, or embedded-lot fallback.
let inventoryLotGroups=new Map(),inventoryLotProductGroups=new Map();
let inventoryLotViewGeneration=0,inventoryLotGroupSequence=0;
const inventoryLotExpandedProducts=new Set();
let inventoryLotSearchState=null;
function resetInventoryLotView(){
    inventoryLotViewGeneration++;inventoryLotGroups=new Map();inventoryLotProductGroups=new Map();inventoryLotExpandedProducts.clear();
}
function invalidateInventoryLotView(productKey=''){
    if(!productKey){resetInventoryLotView();return;}
    const id=inventoryLotProductGroups.get(productKey),group=inventoryLotGroups.get(id);
    if(group){group.invalidated=true;inventoryLotGroups.delete(id);group.keys.forEach(key=>inventoryLotProductGroups.delete(key));}
}
function inventoryLotViewState(item={}){
    const key=String(item.productKey||item.productId||'').trim(),group=inventoryLotGroups.get(inventoryLotProductGroups.get(key));
    return {key,lots:group?YushinInventory.sortLotsForIssue([...group.rows.values()].filter(lot=>lot.productKey===key)):[],
        loading:!!group?.loading,error:group?.error||'',complete:!!group&&!group.invalidated&&!group.loading&&!group.error&&!group.hasMore,hasMore:!!group?.hasMore,loaded:!!group?.loaded};
}
async function loadInventoryLotGroup(group){
    if(group.loading)return group.loading;
    const generation=inventoryLotViewGeneration,uid=currentUser?.uid,role=currentUserRole;
    const isCurrent=()=>!group.invalidated&&generation===inventoryLotViewGeneration&&uid===currentUser?.uid&&role===currentUserRole&&inventoryLotGroups.get(group.id)===group;
    const assertContext=()=>{if(!isCurrent())throw new Error('批次查詢已失效。');};
    group.error='';
    group.loading=(async()=>{
        try{
            const page=await readInventoryLotsForProducts(group.keys,{cursor:group.cursor,assertContext});assertContext();
            page.rows.forEach(lot=>group.rows.set(lot.id,lot));group.cursor=page.cursor;group.hasMore=page.hasMore;group.loaded=true;
        }catch(err){if(isCurrent())group.error='批次讀取失敗，請重試';}
        finally{group.loading=null;}
    })();
    await group.loading;
}
async function loadInventoryLotsForPage(items=[]){
    const keys=[...new Set(items.map(item=>String(item.productKey||item.productId||'').trim()).filter(Boolean))];
    const missing=keys.filter(key=>!inventoryLotProductGroups.has(key));
    for(let index=0;index<missing.length;index+=30){
        const group={id:++inventoryLotGroupSequence,keys:missing.slice(index,index+30),rows:new Map(),cursor:null,hasMore:true,loaded:false,loading:null,error:''};
        inventoryLotGroups.set(group.id,group);group.keys.forEach(key=>inventoryLotProductGroups.set(key,group.id));
    }
    const groups=[...new Set(keys.map(key=>inventoryLotProductGroups.get(key)))].map(id=>inventoryLotGroups.get(id)).filter(group=>!group.loaded||group.error);
    await runReadJobs(groups.map(group=>()=>loadInventoryLotGroup(group)),4);
}
window.loadMoreInventoryLots=async function(productKey){
    const uid=currentUser?.uid,role=currentUserRole,generation=inventoryLotViewGeneration;
    inventoryLotExpandedProducts.add(productKey);
    const group=inventoryLotGroups.get(inventoryLotProductGroups.get(productKey));
    const pending=!group?loadInventoryLotsForPage([{productKey}]):group.hasMore||group.error?loadInventoryLotGroup(group):Promise.resolve();renderInventoryList();await pending;
    if(uid===currentUser?.uid&&role===currentUserRole&&generation===inventoryLotViewGeneration)renderInventoryList();
};
function inventoryLotCellHtml(item){
    const state=inventoryLotViewState(item),expanded=inventoryLotExpandedProducts.has(state.key);
    const rows=expanded?state.lots:state.lots.slice(0,3);
    const lines=rows.map(lot=>`${escapeHtml(lot.lotNo||'無批號')} ${escapeHtml(lot.expiryDate)}${lotStatus(lot)?' ['+lotStatus(lot)+']':''} <small>(${escapeHtml(lot.warehouseId)}：${lot.qty})</small>`);
    if(state.error)lines.push(escapeHtml(state.error));
    else if(state.loading)lines.push('批次讀取中…');
    else if(!state.loaded)lines.push('批次尚未讀取');
    else if(!state.complete)lines.push('批次尚未讀完，以上為已讀資料');
    else if(!state.lots.length)lines.push('沒有剩餘批次；未分批庫存不在此列');
    if(!state.loading&&(!state.loaded||state.hasMore||state.error||(!expanded&&state.lots.length>3)))lines.push(`<button type="button" class="btn-small btn-secondary" onclick="loadMoreInventoryLots(${inlineJsValue(state.key)})">${state.error?'重試批次':!state.loaded?'載入批次':state.hasMore?'載入更多批次':'顯示全部批次'}</button>`);
    return lines.join('<br>');
}
function inventoryLotSearchIsCurrent(state){
    return state===inventoryLotSearchState&&state.generation===inventorySearchGeneration&&state.uid===currentUser?.uid&&state.role===currentUserRole
        &&state.keyword===String(document.getElementById('inventorySearch')?.value||'').trim();
}
function renderInventoryLotSearchControls(){
    const button=document.getElementById('inventoryLotSearchMoreBtn'),state=inventoryLotSearchState;
    if(button){button.hidden=!state||!inventoryLotSearchIsCurrent(state)||!state.pages.some(page=>page.hasMore);button.disabled=!!state?.loading;}
}
async function appendInventoryLotSearchPage(state){
    const assertContext=()=>{if(!inventoryLotSearchIsCurrent(state))throw new Error('庫存搜尋已失效。');};
    const targets=state.pages.filter(page=>page.hasMore);
    const pages=await Promise.all(targets.map(page=>readInventoryLotMatches(state.keyword,page.field,{cursor:page.cursor,pageSize:50,assertContext})));
    assertContext();
    const productKeys=[...new Set(pages.flatMap(page=>page.rows.map(row=>row.productKey)))];
    const rows=await readInventoryForLotProducts(productKeys,{assertContext});assertContext();
    rows.forEach(row=>state.results.set(row.id,row));
    pages.forEach((page,index)=>{targets[index].cursor=page.cursor;targets[index].hasMore=page.hasMore;});
}
window.loadMoreInventoryLotSearch=async function(){
    const state=inventoryLotSearchState;if(!state||state.loading||!inventoryLotSearchIsCurrent(state))return;
    state.loading=true;renderInventoryLotSearchControls();
    const status=document.getElementById('inventorySearchStatus');
    try{
        await appendInventoryLotSearchPage(state);
        const rows=[...state.results.values()];
        await Promise.all([loadWarehouseStocksForInventoryPage(rows),loadInventoryLotsForPage(rows)]);
        if(!inventoryLotSearchIsCurrent(state))return;
        inventorySearchResults=rows.sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
        if(status)status.textContent=`找到 ${rows.length} 筆庫存${state.pages.some(page=>page.hasMore)?'；批號結果尚未讀完':'；批號搜尋完成'}`;
    }catch(err){if(inventoryLotSearchIsCurrent(state)&&status)status.textContent='部分搜尋失敗，請重試批號結果';}
    finally{state.loading=false;if(inventoryLotSearchIsCurrent(state)){renderInventoryList();renderInventoryLotSearchControls();}}
};
