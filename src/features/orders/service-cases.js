let serviceCaseView=null;
const SERVICE_EVENT_LABELS={SAMPLE_RECEIVED:'收取檢體',DEVICE_RECEIVED:'收取器材',
    EXPERIMENT_COMPLETED:'實驗完成',REPORT_SENT:'報告已交付',VENDOR_SENT:'寄送委外單位',
    VENDOR_RETURNED:'委外返件',CUSTOMER_RETURNED:'器材交還客戶',
    CUSTOMER_DELIVERED:'成果交付客戶',REPAIR_COMPLETED:'維修完成'};
const SERVICE_CUSTODY_LABELS={NOT_RECEIVED:'尚未收件',IN_HOUSE:'公司保管',AT_VENDOR:'委外單位保管',
    RETURNED_TO_CUSTOMER:'已交還客戶',CUSTOMER_SITE:'客戶現場'};
const SERVICE_WORK_LABELS={delivery:'待服務處理',billing:'服務完成・待核銷',complete:'服務完成・已核銷',closed:'訂單已停止履約'};
// Read-only, short-lived UI hint sourced only from the server-verified case index.
// This must never be used for workCategories, billing writes or fulfillment decisions.
const verifiedServiceListHints=new Map();
const SERVICE_LIST_HINT_TTL_MS=120000;
function serviceCaseVerifiedItemHint(orderId,item){
    if(!serviceCaseEntryEnabled()||!currentUser?.uid
        ||String(item?.productType||'').trim().toUpperCase()!=='SERVICE')return '';
    const key=JSON.stringify([currentUser.uid,currentUserRole,sessionDataGeneration,orderId,item.itemId]);
    const saved=verifiedServiceListHints.get(key),now=Date.now();
    if(!saved)return '';
    if(saved.readAt>now||now-saved.readAt>SERVICE_LIST_HINT_TTL_MS){
        verifiedServiceListHints.delete(key);return '';
    }
    return `<small class="service-case-verified-hint">${escapeHtml(item.itemName||item.itemCode||'服務品項')}：上次查核完成 ${escapeHtml(saved.completedQty)}/${escapeHtml(saved.orderedQty)}（${escapeHtml(SERVICE_WORK_LABELS[saved.category])}；僅供畫面參考）</small>`;
}
function serviceCaseVerifiedOrderHints(orderId,items){
    return (items||[]).map(item=>serviceCaseVerifiedItemHint(orderId,item)).join('');
}
function rememberVerifiedServiceItem(view,orderId,itemId,progress,category){
    if(!Object.prototype.hasOwnProperty.call(SERVICE_WORK_LABELS,category)
        ||!progress||!Number.isFinite(progress.orderedQty)
        ||!Number.isFinite(progress.completedQty)||progress.orderedQty<=0
        ||progress.completedQty<0||progress.completedQty>progress.orderedQty)return false;
    const key=JSON.stringify([view.uid,view.role,view.generation,orderId,itemId]);
    if(verifiedServiceListHints.size>=100)verifiedServiceListHints.clear();
    verifiedServiceListHints.set(key,{readAt:Date.now(),category,
        orderedQty:progress.orderedQty,completedQty:progress.completedQty});
    return true;
}
function serviceCaseEntryEnabled(){
    return globalThis.YUSHIN_SERVICE_CASE_EMULATOR===true
        &&['admin','sales','warehouse','engineer'].includes(currentUserRole);
}
function serviceCaseActionHtml(order){
    return serviceCaseEntryEnabled()&&(order.items||[]).some(i=>String(i.productType||'').trim().toUpperCase()==='SERVICE')
        ?`<button type="button" class="btn-small btn-secondary" onclick="openServiceCases(${inlineJsValue(order.id)})">服務案件</button>`:'';
}
function renderServiceCaseEntry(){
    const button=document.getElementById('serviceCaseEntry');if(button)button.hidden=!serviceCaseEntryEnabled();
}
function serviceCaseCurrent(view){
    if(serviceCaseView!==view||view.uid!==currentUser?.uid||view.role!==currentUserRole
        ||view.generation!==sessionDataGeneration)throw Error('登入身分或服務畫面已變更，請重新開啟。');
}
window.resetServiceCaseView=function(){
    serviceCaseView=null;const overlay=document.getElementById('serviceCaseOverlay');
    overlay?.classList.remove('active');if(overlay)overlay.innerHTML='';
};
window.closeServiceCases=function(){if(!serviceCaseView?.busy)resetServiceCaseView();};
function serviceCaseShell(){
    let overlay=document.getElementById('serviceCaseOverlay');
    if(!overlay){overlay=document.createElement('div');overlay.id='serviceCaseOverlay';overlay.className='modal-overlay';document.body.appendChild(overlay);}
    overlay.innerHTML='<div class="modal" role="dialog" aria-modal="true" aria-labelledby="serviceCaseTitle">'
        +'<h3 id="serviceCaseTitle">服務案件</h3><div id="serviceCaseBody"></div><p id="serviceCaseMessage" role="status"></p>'
        +'<button type="button" class="btn-secondary" onclick="closeServiceCases()">關閉</button></div>';
    overlay.classList.add('active');
}
window.openServiceCases=async function(orderId){
    if(serviceCaseView?.busy)return;
    let view;
    try{
        const {uid,role}=serviceCaseTransport();
        view={uid,role,generation:sessionDataGeneration,busy:false,request:0};serviceCaseView=view;
        serviceCaseShell();
        const pending=pendingServiceCaseIntent();
        if(pending){renderServiceCasePending(view,pending);return;}
        const order=orderId?(ordersCache||[]).find(o=>o.id===orderId):null;
        if(order){view.order={orderId:order.id,orderNo:order.orderNo,customerName:order.customerName,
            items:(order.items||[]).filter(i=>String(i.productType||'').trim().toUpperCase()==='SERVICE')};}
        renderServiceCaseOrder(view);
        if(view.order?.items.length)await loadServiceCaseItem(view.order.items[0].itemId);
    }catch(error){if(view&&serviceCaseView===view)serviceCaseMessage(view,error.message);else if(!view)alert(error.message);}
};
function serviceCaseMessage(view,message){
    serviceCaseCurrent(view);document.getElementById('serviceCaseMessage').textContent=message;
}
function renderServiceCaseOrder(view){
    serviceCaseCurrent(view);
    document.getElementById('serviceCaseBody').innerHTML=
        '<label for="serviceOrderNo">訂單編號</label><input id="serviceOrderNo" maxlength="160">'
        +'<button type="button" onclick="findServiceCaseOrder()">查詢服務訂單</button>'
        +(view.order?`<p>${escapeHtml(view.order.customerName||'')}｜${escapeHtml(view.order.orderNo||'')}</p>`
        +`<button type="button" id="verifyServiceOrderButton" onclick="verifyServiceOrderProgress()">查核整張服務單進度</button><div id="serviceOrderSummaryBody"></div><label for="serviceItemChoice">服務品項</label><select id="serviceItemChoice" onchange="loadServiceCaseItem(this.value)">${view.order.items.map(i=>`<option value="${escapeAttr(i.itemId)}">${escapeHtml(i.itemName||'服務品項')}</option>`).join('')}</select><div id="serviceItemBody"></div>`:'');
    if(view.order)document.getElementById('serviceOrderNo').value=view.order.orderNo||'';
}
window.findServiceCaseOrder=async function(){
    const view=serviceCaseView;if(!view||view.busy)return;
    let seq;
    try{
        serviceCaseCurrent(view);seq=++view.request;view.orderLookup=seq;
        // Invalidate the previous order's actions before awaiting a new lookup.
        // A failed lookup must not leave an actionable form for the old order.
        view.data=null;view.selected=null;view.summary=null;
        const body=document.getElementById('serviceItemBody');if(body)body.textContent='查詢訂單中…';
        const choice=document.getElementById('serviceItemChoice');if(choice)choice.disabled=true;
        const order=await readServiceCases({orderNo:document.getElementById('serviceOrderNo').value.trim()});
        serviceCaseCurrent(view);if(seq!==view.request)return;
        view.orderLookup=null;view.order=order;renderServiceCaseOrder(view);await loadServiceCaseItem(order.items[0].itemId);
    }catch(error){if(serviceCaseView===view&&seq===view.request&&view.uid===currentUser?.uid&&view.role===currentUserRole
        &&view.generation===sessionDataGeneration){
        const body=document.getElementById('serviceItemBody');if(body)body.textContent='訂單查詢失敗，請重新查詢。';
        serviceCaseMessage(view,error.message);
    }}finally{if(serviceCaseView===view&&view.orderLookup===seq)view.orderLookup=null;}
};
window.loadServiceCaseItem=async function(itemId){
    const view=serviceCaseView;if(!view||view.busy||view.orderLookup)return;
    serviceCaseCurrent(view);const seq=++view.request;
    document.getElementById('serviceItemBody').textContent='讀取案件中…';view.data=null;view.itemId=itemId;
    try{
        const data=await readServiceCases({orderId:view.order.orderId,itemId});serviceCaseCurrent(view);
        if(seq!==view.request)return;view.data=data;view.needsReload=false;
        // The item/status/quantities are returned by the authorized backend
        // after reading the registered cases. Never reconstruct them from order flags.
        if(data.orderId===view.order.orderId&&data.itemId===itemId)
            rememberVerifiedServiceItem(view,data.orderId,itemId,data.itemProgress,data.itemWorkCategory);
        if(document.getElementById('order-system')?.classList?.contains?.('active'))window.renderOrdersList?.();
        if(data.items)Object.assign(view.order,{items:data.items,orderNo:data.orderNo,customerName:data.customerName});
        renderServiceCaseItem(view);
        serviceCaseMessage(view,'');
    }catch(error){if(serviceCaseView===view&&seq===view.request&&view.uid===currentUser?.uid&&view.role===currentUserRole&&view.generation===sessionDataGeneration){
        document.getElementById('serviceItemBody').textContent='無法載入案件，請重新選擇品項。';serviceCaseMessage(view,error.message);
    }}
};
// Explicit whole-order verification, never invoked by list rendering.
// The verified view does not authorize billing or modify Firestore indexes.
window.verifyServiceOrderProgress=async function(){
    const view=serviceCaseView;if(!view||view.busy||view.verifying||view.orderLookup||!view.order?.orderId)return;
    serviceCaseCurrent(view);
    const orderId=view.order.orderId,seq=view.request;
    const body=document.getElementById('serviceOrderSummaryBody');
    const button=document.getElementById('verifyServiceOrderButton');
    view.verifying=true;if(button){button.disabled=true;button.textContent='查核中…';}
    if(body)body.textContent='正在核對整張服務訂單的案件事件…';
    try{
        const data=await readServiceOrderProgress(orderId);
        serviceCaseCurrent(view);
        if(view.request!==seq||view.orderLookup||view.order?.orderId!==orderId)return;
        const allowedIds=new Set(view.order.items.map(item=>item.itemId));
        if(data.orderId!==orderId||!Array.isArray(data.items)
            ||data.items.length!==allowedIds.size
            ||new Set(data.items.map(item=>item.itemId)).size!==allowedIds.size
            ||data.items.some(item=>!allowedIds.has(item.itemId)))
            throw Error('整單查核來源品項不一致，請重新查詢。');
        for(const item of data.items){
            if(!rememberVerifiedServiceItem(view,orderId,item.itemId,
                {orderedQty:item.orderedQty,completedQty:item.completedQty},item.workCategory))
                throw Error('服務完成量或狀態未通過驗證。');
        }
        view.summary=data;
        if(body)body.innerHTML='<p>服務案件整單查核：已完成 '
            +escapeHtml(data.completedQty)+'／'+escapeHtml(data.orderedQty)
            +(data.mixedOrder?'（此訂單另有一般商品，未包含在服務進度中）':'')+'</p><ul>'
            +data.items.map(item=>'<li>'+escapeHtml(item.itemName)+'：'
                +escapeHtml(item.completedQty)+'／'+escapeHtml(item.orderedQty)
                +'・'+escapeHtml(SERVICE_WORK_LABELS[item.workCategory])+'</li>').join('')+'</ul>'
            +'<small>僅供最近一次查核參考，不影響核銷及原訂單工作分類。</small>';
        if(document.getElementById('order-system')?.classList?.contains?.('active'))window.renderOrdersList?.();
    }catch(error){
        if(serviceCaseView===view&&view.uid===currentUser?.uid
            &&view.role===currentUserRole&&view.generation===sessionDataGeneration
            &&view.request===seq&&view.order?.orderId===orderId){
            if(body)body.textContent='整張服務單查核未完成：'+error.message;
        }
    }finally{
        view.verifying=false;
        if(serviceCaseView===view&&view.order?.orderId===orderId
            &&document.getElementById('verifyServiceOrderButton')===button&&button){
            button.disabled=false;button.textContent='查核整張服務單進度';
        }
    }
};
function renderServiceCaseItem(view){
    serviceCaseCurrent(view);const data=view.data,p=data.itemProgress;
    document.getElementById('serviceItemBody').innerHTML=`<p>服務品項狀態：${escapeHtml(SERVICE_WORK_LABELS[data.itemWorkCategory]||'待查核')}</p><p>訂單數量 ${p.orderedQty}｜已開案 ${p.allocatedQty}｜完成 ${p.completedQty}｜待完成 ${p.remainingQty}</p>`
        +data.cases.map(row=>`<details><summary>${escapeHtml(row.caseId)}｜數量 ${row.serviceQty}｜${row.completed?'流程完成':escapeHtml(SERVICE_EVENT_LABELS[row.nextEvent]||'待處理')}｜${escapeHtml(SERVICE_CUSTODY_LABELS[row.custody]||row.custody)}</summary><ol>${row.events.map(e=>`<li>${escapeHtml(SERVICE_EVENT_LABELS[e.type]||e.type)} ${escapeHtml(e.occurredAt)}${e.partyName?'｜'+escapeHtml(e.partyName):''}${e.receivedBy?'｜'+escapeHtml(e.receivedBy):''}${e.reportRef?'｜'+escapeHtml(e.reportRef):''}${e.deliveryRef?'｜'+escapeHtml(e.deliveryRef):''}${e.workSummary?'｜'+escapeHtml(e.workSummary):''}${e.notes?'｜'+escapeHtml(e.notes):''}</li>`).join('')}</ol></details>`).join('')
        +`<label for="serviceCaseChoice">作業案件</label><select id="serviceCaseChoice" onchange="renderServiceCaseAction()"><option value="">${data.canStart?'新增服務案件':'請選擇可執行的案件'}</option>${data.cases.filter(c=>c.canAdvance).map(c=>`<option value="${escapeAttr(c.caseId)}">${escapeHtml(c.caseId)}｜${escapeHtml(SERVICE_EVENT_LABELS[c.nextEvent])}</option>`).join('')}</select><div id="serviceCaseAction"></div>`;
    renderServiceCaseAction();
}
window.renderServiceCaseAction=function(){
    const view=serviceCaseView;if(!view?.data||view.busy)return;serviceCaseCurrent(view);
    const selected=document.getElementById('serviceCaseChoice').value;
    const row=view.data.cases.find(c=>c.caseId===selected);view.selected=row||null;
    const permitted=row?row.canAdvance:view.data.canStart&&view.data.itemProgress.unassignedQty>0;
    if(!permitted){document.getElementById('serviceCaseAction').textContent='目前沒有可執行的作業，可查閱上方案件歷程。';return;}
    const type=row?row.nextEvent:YushinServiceWork.STEPS[view.data.kind][0];view.eventType=type;
    const field={VENDOR_SENT:['partyName','委外收件單位'],CUSTOMER_RETURNED:['receivedBy','客戶領收人'],
        REPORT_SENT:['reportRef','報告憑證／檔案編號'],CUSTOMER_DELIVERED:['deliveryRef','成果交付憑證'],REPAIR_COMPLETED:['workSummary','維修內容']}[type];
    document.getElementById('serviceCaseAction').innerHTML='<fieldset id="serviceCaseFields">'
        +(!row?'<label for="serviceNewCaseId">案件／檢體／器材編號</label><input id="serviceNewCaseId" maxlength="160">'
        +'<label for="serviceNewQty">對應訂單數量</label><input id="serviceNewQty" type="number" min="0" step="any"><small>依本案件對應的訂購量填寫。</small>':'')
        +'<label for="serviceOccurredAt">實際作業時間</label><input id="serviceOccurredAt" type="datetime-local" step="1">'
        +(field?`<label for="serviceEvidence">${field[1]}</label><input id="serviceEvidence" maxlength="1000">`:'')
        +'<label for="serviceNotes">備註</label><textarea id="serviceNotes" maxlength="1000"></textarea>'
        +`<button type="button" id="serviceCaseSave" onclick="saveServiceCaseAction()">確認${escapeHtml(SERVICE_EVENT_LABELS[type])}</button></fieldset>`;
    const now=new Date();document.getElementById('serviceOccurredAt').value=new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,19);
    view.evidenceField=field?.[0];
};
function renderServiceCasePending(view,saved){
    serviceCaseCurrent(view);view.pending=true;
    document.getElementById('serviceCaseBody').innerHTML=`<p>前次服務操作結果待確認，請以原資料確認。</p><p>案件：${escapeHtml(saved.intent.caseId)}｜數量：${saved.intent.serviceQty}｜${escapeHtml(SERVICE_EVENT_LABELS[saved.intent.event.type]||saved.intent.event.type)}</p><button type="button" id="serviceCaseRetry" onclick="saveServiceCaseAction()">確認前次服務操作結果</button>`;
}
window.saveServiceCaseAction=async function(){
    const view=serviceCaseView;if(!view||view.busy||view.needsReload||view.orderLookup)return;
    let confirmed=false;
    try{
        serviceCaseCurrent(view);let intent;
        if(!pendingServiceCaseIntent()){
            if(!view.data)throw Error('請先完成服務訂單與案件查詢。');
            const at=new Date(document.getElementById('serviceOccurredAt').value);
            if(!Number.isFinite(at.getTime()))throw Error('請填寫有效的實際作業時間。');
            const event={id:crypto.randomUUID(),type:view.eventType,occurredAt:at.toISOString(),notes:document.getElementById('serviceNotes').value};
            if(view.evidenceField)event[view.evidenceField]=document.getElementById('serviceEvidence').value;
            intent={orderId:view.order.orderId,itemId:view.itemId,caseId:view.selected?.caseId||document.getElementById('serviceNewCaseId').value.trim(),
                serviceQty:view.selected?.serviceQty??Number(document.getElementById('serviceNewQty').value),event};
        }
        view.busy=true;document.getElementById('serviceCaseFields')?.setAttribute('disabled','');
        const retry=document.getElementById('serviceCaseRetry');if(retry)retry.disabled=true;
        const proof=await commitServiceCaseIntent(intent);confirmed=true;serviceCaseCurrent(view);
        view.busy=false;view.pending=false;view.needsReload=true;
        // Reload minimal server-authorized service data, including after a recovered page.
        if(view.order?.orderId!==proof.orderId)view.order={orderId:proof.orderId,items:[{itemId:proof.itemId,itemName:'服務品項'}]};
        renderServiceCaseOrder(view);await loadServiceCaseItem(proof.itemId);serviceCaseCurrent(view);
        if(!view.data)throw Error('案件進度重新載入失敗，請重新開啟查詢。');
        renderServiceCaseOrder(view);document.getElementById('serviceItemChoice').value=proof.itemId;renderServiceCaseItem(view);
        serviceCaseMessage(view,'服務操作已確認。');
    }catch(error){
        if(serviceCaseView===view&&view.uid===currentUser?.uid&&view.role===currentUserRole&&view.generation===sessionDataGeneration){
            view.busy=false;
            try{const saved=pendingServiceCaseIntent();if(saved)renderServiceCasePending(view,saved);else document.getElementById('serviceCaseFields')?.removeAttribute('disabled');}
            catch(storageError){document.getElementById('serviceCaseBody').textContent=storageError.message;}
            serviceCaseMessage(view,(confirmed?'服務操作已確認；':'')+error.message);
        }
    }finally{if(serviceCaseView===view)view.busy=false;}
};
