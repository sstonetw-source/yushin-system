(function externalWarehouseDispatchModule(root) {
    'use strict';
    let draft = null;
    const busy = new Set();
    const noticeCache = new Map();
    const canOperate = () => ['admin', 'purchaser', 'warehouse'].includes(currentUserRole);
    const warehouseType = warehouse => warehouse?.warehouseType === 'EXTERNAL' ? 'EXTERNAL' : 'INTERNAL';
    const findWarehouse = id => warehouseMasterCache.find(warehouse => warehouse.id === id && warehouse.active !== false);
    const noticeId = (orderId, itemId) => `${orderId}__${itemId}`;
    const safe = value => String(value || '').replace(/[\\/:*?"<>|]+/g, '_');
    const isoNow = () => new Date().toISOString();

    function externalLines(order, warehouseId) {
        if (normalizedOrderStatus(order) !== 'normal' || orderInventorySyncIncomplete(order)) return [];
        return normalizedOrderItems(order).map((item, itemIndex) => {
            const itemWarehouseId = item.warehouseId || order.warehouseId || defaultWarehouse()?.id || '';
            if (itemWarehouseId !== warehouseId || (item.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return null;
            const state = itemDispatchState(order, item);
            const qty = Math.max(0, Number(state.pending || 0) + Number(state.shippable || 0));
            const id = noticeId(order.id, item.itemId);
            const known = noticeCache.get(id);
            return (qty > 0 || known)
                ? { itemId: item.itemId, itemIndex, code: item.itemCode || '', name: item.itemName || '',
                    qty: known ? Number(known.qty || 0) : qty, availableQty: qty, warehouseId, noticeId: id, notice: known || null }
                : null;
        }).filter(Boolean);
    }

    function groupsForQueue(order) {
        if (normalizedOrderStatus(order) !== 'normal' || orderInventorySyncIncomplete(order)) return [];
        const warehouses = new Set(normalizedOrderItems(order)
            .filter(item => (item.fulfillmentType || 'WAREHOUSE') !== 'DIRECT_SHIP')
            .map(item => item.warehouseId || order.warehouseId || defaultWarehouse()?.id || '')
            .filter(id => warehouseType(findWarehouse(id)) === 'EXTERNAL'));
        return [...warehouses].map(warehouseId => ({
            warehouseId, warehouse: findWarehouse(warehouseId),
            lines: externalLines(order, warehouseId)
        })).filter(group => group.lines.length);
    }

    root.renderExternalWarehouseQueue = function() {
        const body = document.getElementById('externalWarehouseBody');
        const status = document.getElementById('externalWarehouseQueueStatus');
        if (!body) return;
        if (!canOperate()) {
            body.innerHTML = '<tr><td colspan="5">此操作僅供採購、倉管與管理員使用。</td></tr>';
            return;
        }
        const rows = [];
        (ordersCache.length ? ordersCache : purchasingDispatchCache).forEach(order => {
            for (const group of groupsForQueue(order)) {
                const pending = group.lines.filter(line => line.availableQty > 0);
                if (!pending.length && !group.lines.some(line => line.notice)) continue;
                const notices = group.lines.map(line => line.notice).filter(Boolean);
                const state = notices.length === group.lines.length
                    ? (notices.every(notice => notice.status === 'SHIPPED') ? '外倉已出貨'
                        : notices.every(notice => ['NOTIFIED','SHIPPED'].includes(notice.status)) ? '已通知（待出貨）' : '待通知')
                    : '待確認通知';
                rows.push(`<tr>
                    <td>${escapeHtml(order.orderNo || order.quoteNo || order.id)}</td>
                    <td>${escapeHtml(order.customerName || '')}</td>
                    <td>${escapeHtml(group.warehouse?.warehouseName || group.warehouseId)}</td>
                    <td>${escapeHtml(group.lines.map(line => `${line.code || line.name} × ${line.qty}`).join('、'))}</td>
                    <td><span class="order-progress-badge">${state}</span>
                        <button type="button" class="btn-small btn-secondary" onclick="openExternalWarehouseNotice(${inlineJsValue(order.id)},${inlineJsValue(group.warehouseId)})">外倉出貨通知</button>
                    </td></tr>`);
            }
        });
        body.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="5" style="color:#777">目前已載入的訂單中沒有待處理的外倉品項。</td></tr>';
        if (status) status.textContent = rows.length ? `已載入 ${rows.length} 組外倉出貨需求` : '只顯示已指定「外部倉庫」的品項';
    };

    function setFeedback(message, error = false) {
        const target = document.getElementById('externalWarehouseNoticeStatus');
        if (!target) return;
        target.textContent = message || '';
        target.style.color = error ? '#a92323' : '#315476';
    }

    function renderModal() {
        if (!draft) return;
        const overlay = document.getElementById('externalWarehouseNoticeOverlay');
        if (!overlay) return;
        const { warehouse, order, lines } = draft;
        const notified = lines.filter(line => line.notice?.status === 'NOTIFIED');
        const shipped = lines.filter(line => line.notice?.status === 'SHIPPED');
        const pending = lines.filter(line => !line.notice);
        overlay.innerHTML = `<div class="eq-modal-box external-notice-box" style="max-width:900px">
            <h3>外倉出貨通知｜${escapeHtml(warehouse.warehouseName || warehouse.id)}</h3>
            <p>${escapeHtml(order.orderNo || order.quoteNo || order.id)}｜${escapeHtml(order.customerName || '')}</p>
            <p style="font-size:13px;color:#555">僅列出本外倉品項。下載文件不代表已通知、不扣庫存；確認外倉已出貨後才正式登記送貨及扣除該倉庫存。</p>
            <div class="dispatch-list-fields">
                <label>送貨地址<input id="externalNoticeAddress" value="${escapeAttr(draft.address)}" placeholder="客戶送貨地址"></label>
                <label>聯絡人<input id="externalNoticeContact" value="${escapeAttr(draft.contact)}" placeholder="聯絡人"></label>
                <label>電話<input id="externalNoticePhone" value="${escapeAttr(draft.phone)}" placeholder="聯絡電話"></label>
                <label>預計出貨日<input type="date" id="externalNoticeExpectedDate" value="${escapeAttr(draft.expectedDate)}"></label>
                <label>備註<input id="externalNoticeNotes" value="${escapeAttr(draft.notes)}" placeholder="交貨注意事項（選填）"></label>
            </div>
            <div class="table-wrap"><table><thead><tr><th>貨號</th><th>品名</th><th>通知數量</th><th>處理狀態</th><th>操作</th></tr></thead>
            <tbody>${lines.map(line => `<tr><td>${escapeHtml(line.code)}</td><td>${escapeHtml(line.name)}</td>
                <td>${line.qty}</td>
                <td>${line.notice?.status === 'SHIPPED' ? '外倉已出貨' : line.notice?.status === 'NOTIFIED' ? '已通知（待出貨）' : '尚未通知'}</td>
                <td>${line.notice?.status === 'NOTIFIED'
                    ? `<button type="button" class="btn-small" onclick="confirmExternalWarehouseShipped(${inlineJsValue(line.itemId)},this)">確認外倉已出貨</button>`
                    : line.notice?.status === 'SHIPPED' ? '<span class="order-progress-badge">已記錄</span>' : ''}</td></tr>`).join('')}</tbody></table></div>
            <div class="toolbar external-notice-actions">
                <button type="button" class="btn-secondary" onclick="exportExternalWarehouseNotice('pdf',this)">下載通知單 PDF</button>
                <button type="button" class="btn-secondary" onclick="exportExternalWarehouseNotice('excel',this)">Excel</button>
                ${pending.length ? '<button type="button" onclick="markExternalWarehouseNotified(this)">確認已通知外倉</button>' : ''}
                <button type="button" class="btn-secondary" onclick="closeExternalWarehouseNotice()">關閉</button>
            </div>
            <p id="externalWarehouseNoticeStatus" role="status" style="font-size:13px;margin-top:10px">
                ${notified.length} 筆已通知，${shipped.length} 筆已出貨，${pending.length} 筆尚未通知。
            </p>
        </div>`;
    }

    function captureFields() {
        if (!draft) return;
        draft.address = document.getElementById('externalNoticeAddress')?.value.trim() || '';
        draft.contact = document.getElementById('externalNoticeContact')?.value.trim() || '';
        draft.phone = document.getElementById('externalNoticePhone')?.value.trim() || '';
        draft.expectedDate = document.getElementById('externalNoticeExpectedDate')?.value || '';
        draft.notes = document.getElementById('externalNoticeNotes')?.value.trim() || '';
    }

    async function reloadDraft() {
        if (!draft) return;
        const [orderSnapshot] = await Promise.all([
            firestoreReadWithTimeout(db.collection('orders').doc(draft.orderId).get(), '讀取外倉訂單'),
            loadWarehouseMaster()
        ]);
        if (!orderSnapshot.exists) throw new Error('找不到客戶訂單。');
        const order = { id:draft.orderId, ...orderSnapshot.data() };
        if (normalizedOrderStatus(order) !== 'normal' || orderInventorySyncIncomplete(order)) {
            throw new Error('訂單已取消或庫存尚未同步完成，無法操作。');
        }
        const warehouse = findWarehouse(draft.warehouseId);
        if (warehouseType(warehouse) !== 'EXTERNAL') throw new Error('這個倉庫不是啟用中的外部倉庫。');
        const assigned = normalizedOrderItems(order).filter(item =>
            (item.fulfillmentType || 'WAREHOUSE') !== 'DIRECT_SHIP' &&
            (item.warehouseId || order.warehouseId || defaultWarehouse()?.id || '') === draft.warehouseId
        );
        if (!assigned.length) throw new Error('本訂單沒有指定此外倉的品項。');
        const notices = await Promise.all(assigned.map(item =>
            firestoreReadWithTimeout(db.collection('externalDispatchNotices').doc(noticeId(draft.orderId, item.itemId)).get(), '讀取外倉通知')
        ));
        notices.forEach((snapshot, index) => {
            if (snapshot.exists) noticeCache.set(snapshot.id, { id:snapshot.id, ...snapshot.data() });
            else noticeCache.delete(noticeId(draft.orderId, assigned[index].itemId));
        });
        draft.order = order;
        draft.warehouse = warehouse;
        draft.lines = externalLines(order, draft.warehouseId);
        if (!draft.lines.length) throw new Error('目前沒有可通知的外倉品項。');
        renderModal();
        root.renderExternalWarehouseQueue();
    }

    root.openExternalWarehouseNotice = async function(orderId, warehouseId) {
        if (!canOperate() || !canAccessPage('orders.po')) return;
        if (busy.has('open')) return;
        busy.add('open');
        try {
            draft = {
                orderId, warehouseId,
                address:'', contact:'', phone:'', expectedDate:'', notes:'',
                lines:[], order:null, warehouse:null
            };
            const overlay = document.getElementById('externalWarehouseNoticeOverlay');
            if (!overlay) throw new Error('外倉通知畫面尚未載入。');
            overlay.classList.add('active');
            overlay.innerHTML = '<div class="eq-modal-box">正在載入外倉出貨資料…</div>';
            const order = await firestoreReadWithTimeout(db.collection('orders').doc(orderId).get(), '外倉訂單');
            if (!order.exists) throw new Error('找不到訂單。');
            const o = order.data();
            draft.address = o.shippingAddress || o.deliveryAddress || '';
            draft.contact = o.customerContact || '';
            draft.phone = o.customerPhone || '';
            draft.expectedDate = o.deliveryDate || '';
            await reloadDraft();
        } catch (err) {
            root.closeExternalWarehouseNotice();
            showActionFeedback(`開啟外倉出貨通知失敗：${err.message}`, 'warning');
        } finally {
            busy.delete('open');
        }
    };

    root.closeExternalWarehouseNotice = function() {
        if (busy.has('notify') || busy.has('ship') || busy.has('pdf')) return;
        document.getElementById('externalWarehouseNoticeOverlay')?.classList.remove('active');
        draft = null;
    };

    root.exportExternalWarehouseNotice = async function(format, button) {
        if (!draft || !canOperate()) return;
        if (busy.has('pdf')) return;
        captureFields();
        const original = button?.textContent || '';
        if (button) { button.disabled = true; button.textContent = '製作中…'; }
        busy.add('pdf');
        let stage = null;
        try {
            if (format === 'pdf') {
                if (typeof root.html2canvas !== 'function' || !root.jspdf?.jsPDF) throw new Error('PDF 元件尚未載入。');
                await root.DocumentDownloads?.prepare?.('purchase');
            }
            const info = { ...draft, lines:draft.lines.map(line => ({...line})) };
            const fileName = `外倉出貨通知-${safe(info.warehouse.warehouseName)}-${safe(info.order.orderNo || info.order.id)}-${localDateString()}`;
            if (format === 'excel') {
                if (!root.XLSX) throw new Error('Excel 元件尚未載入。');
                const rows = info.lines.map(line => ({
                    '訂單號':info.order.orderNo || info.order.id,
                    '外倉':info.warehouse.warehouseName,
                    '客戶':info.order.customerName || '',
                    '送貨地址':info.address, '聯絡人':info.contact, '電話':info.phone,
                    '預計出貨日':info.expectedDate, '貨號':line.code, '品名':line.name,
                    '數量':line.qty, '備註':info.notes
                }));
                const wb = root.XLSX.utils.book_new();
                root.XLSX.utils.book_append_sheet(wb, root.XLSX.utils.json_to_sheet(rows), '外倉出貨通知');
                root.XLSX.writeFile(wb, fileName + '.xlsx');
            } else if (format === 'pdf') {
                stage = document.createElement('div');
                stage.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:white;color:#111;';
                document.body.appendChild(stage);
                const pages = [];
                for (let start = 0; start < info.lines.length; start += 10) {
                    const page = document.createElement('div');
                    page.style.cssText = 'width:794px;min-height:700px;padding:30px;box-sizing:border-box;background:#fff;font-size:15px;';
                    page.innerHTML = `<h2 style="text-align:center">外倉出貨通知單</h2>
                        <p>外倉：${escapeHtml(info.warehouse.warehouseName)}</p>
                        <p>訂單號：${escapeHtml(info.order.orderNo || info.order.id)}　日期：${localDateString()}</p>
                        <p>客戶：${escapeHtml(info.order.customerName || '')}</p>
                        <p>送貨地址：${escapeHtml(info.address)}</p>
                        <p>聯絡人：${escapeHtml(info.contact)}　電話：${escapeHtml(info.phone)}</p>
                        <p>預計出貨日：${escapeHtml(info.expectedDate || '未指定')}　又鑫窗口：${escapeHtml(info.order.salesName || currentUserName || '')}</p>
                        <table style="width:100%;border-collapse:collapse;table-layout:fixed;">
                        <thead><tr><th style="border:1px solid #aaa;padding:7px;width:25%">貨號</th><th style="border:1px solid #aaa;padding:7px">品名</th><th style="border:1px solid #aaa;padding:7px;width:12%">數量</th></tr></thead>
                        <tbody>${info.lines.slice(start,start+10).map(line=>`<tr><td style="border:1px solid #aaa;padding:7px;overflow-wrap:anywhere">${escapeHtml(line.code)}</td>
                            <td style="border:1px solid #aaa;padding:7px;overflow-wrap:anywhere">${escapeHtml(line.name)}</td>
                            <td style="border:1px solid #aaa;padding:7px;text-align:center">${line.qty}</td></tr>`).join('')}</tbody></table>
                        <p style="white-space:pre-wrap">備註：${escapeHtml(info.notes || '無')}</p>
                        <p>請外倉依通知單備貨並回覆實際出貨時間與批號。本文件不代表已出貨，系統庫存不因下載而變更。</p>`;
                    stage.appendChild(page);
                    pages.push(page);
                }
                const pdf = new root.jspdf.jsPDF({orientation:'portrait',unit:'mm',format:'a4',compress:pages.length>1});
                await addDocumentPagesToPdf(pdf,pages,{isolateRoot:stage,
                    onProgress:(no,total)=>{ if(button) button.textContent=`製作中… ${no}/${total}`; }});
                if (root.DocumentDownloads?.savePdf) await root.DocumentDownloads.savePdf('purchase',pdf,fileName+'.pdf');
                else pdf.save(fileName+'.pdf');
            } else {
                throw new Error('不支援的檔案格式。');
            }
            setFeedback('通知單已下載；尚未自動認定外倉收到通知，也沒有異動庫存。');
        } catch (err) {
            setFeedback(`產生外倉通知失敗：${err.message}`,true);
        } finally {
            stage?.remove();
            busy.delete('pdf');
            if (button) { button.disabled = false; button.textContent = original; }
        }
    };

    root.markExternalWarehouseNotified = async function(button) {
        if (!draft || !canOperate() || busy.has('notify')) return;
        captureFields();
        const target = draft;
        if (!confirm(`確認已將出貨指示通知「${target.warehouse.warehouseName}」？僅記錄通知，不扣庫存。`)) return;
        if (button) button.disabled = true;
        busy.add('notify');
        setFeedback('正在紀錄外倉通知…');
        try {
            await runRoleTransaction(async tx => {
                const orderRef = db.collection('orders').doc(target.orderId);
                const orderSnapshot = await tx.get(orderRef);
                if (!orderSnapshot.exists) throw new Error('訂單已不存在。');
                const order = { id:target.orderId, ...orderSnapshot.data() };
                if (normalizedOrderStatus(order) !== 'normal' || orderInventorySyncIncomplete(order)) throw new Error('訂單不能進行通知。');
                const items = normalizedOrderItems(order);
                const pending = target.lines.filter(line => !line.notice);
                const reads = [];
                for (const line of pending) {
                    const ref = db.collection('externalDispatchNotices').doc(line.noticeId);
                    reads.push({line,ref,snapshot:await tx.get(ref)});
                }
                const now=isoNow();
                for (const {line,ref,snapshot} of reads) {
                    if (snapshot.exists) {
                        if (!['NOTIFIED','SHIPPED'].includes(snapshot.data().status)) throw new Error('通知狀態已變更，請重新載入。');
                        continue;
                    }
                    const i = items.findIndex(item => item.itemId === line.itemId);
                    const item = items[i];
                    if (!item || (item.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') throw new Error('品項已變更。');
                    if ((item.warehouseId || order.warehouseId || defaultWarehouse()?.id || '') !== target.warehouseId) throw new Error('品項出貨倉庫已變更。');
                    const qty = Math.max(0, Number(itemDispatchState(order,item).pending || 0)+Number(itemDispatchState(order,item).shippable || 0));
                    if (qty <= 0 || qty !== line.availableQty) throw new Error('可出貨數量已變更，請重新開啟通知單。');
                    tx.set(ref,{
                        orderId:target.orderId,itemId:line.itemId,itemIndex:i,warehouseId:target.warehouseId,
                        orderNo:order.orderNo || '',ownerUid:order.ownerUid || '',salesCode:order.salesCode || '',
                        customerName:order.customerName || '',itemCode:item.itemCode || '',itemName:item.itemName || '',
                        qty,status:'NOTIFIED',
                        shippingAddress:target.address,contactName:target.contact,contactPhone:target.phone,
                        expectedDate:target.expectedDate,notes:target.notes,
                        notifiedByUid:currentUser?.uid || '',notifiedBy:currentUserName || '',
                        notifiedAt:now,createdAt:now,updatedAt:now
                    });
                }
            });
            await reloadDraft();
            setFeedback('外倉通知已登錄。請在收到外倉實際出貨確認後，按「確認外倉已出貨」。');
        } catch (err) {
            setFeedback(`紀錄外倉通知失敗：${err.message}`,true);
        } finally {
            busy.delete('notify');
            if (button) button.disabled = false;
        }
    };

    root.confirmExternalWarehouseShipped = async function(itemId,button) {
        if (!draft || !canOperate() || busy.has('ship')) return;
        const currentLine = draft.lines.find(line => line.itemId === itemId);
        if (!currentLine || currentLine.notice?.status !== 'NOTIFIED') return;
        const confirmation = `${currentLine.code || currentLine.name} × ${currentLine.qty}`;
        if (!confirm(`請確認外倉已實際出貨：${confirmation}\n確認後會依目前庫存紀錄扣除本外倉庫存並建立送貨紀錄；請勿重複操作。`)) return;
        busy.add('ship');
        if (button) {button.disabled = true;button.textContent = '確認中…';}
        setFeedback('正在核對庫存與記錄出貨…');
        try {
            let savedOrder;
            await runRoleTransaction(async tx => {
                const orderRef=db.collection('orders').doc(draft.orderId);
                const noticeRef=db.collection('externalDispatchNotices').doc(currentLine.noticeId);
                const orderSnap=await tx.get(orderRef);
                const noticeSnap=await tx.get(noticeRef);
                if(!orderSnap.exists || !noticeSnap.exists) throw new Error('通知或訂單已不存在。');
                const order=orderSnap.data(),notice=noticeSnap.data();
                if (normalizedOrderStatus(order) !== 'normal' || orderInventorySyncIncomplete(order)) throw new Error('訂單已取消或庫存未同步。');
                if (notice.status !== 'NOTIFIED' || notice.itemId !== itemId || notice.orderId !== draft.orderId
                    || notice.warehouseId !== draft.warehouseId) throw new Error('外倉通知已被其他人處理或修改。');
                const items=normalizedOrderItems(order);
                const idx=items.findIndex(item=>item.itemId===itemId);
                if(idx<0 || (items[idx].warehouseId || order.warehouseId || defaultWarehouse()?.id || '') !== notice.warehouseId) throw new Error('倉庫或品項已變更。');
                const item=items[idx];
                const state=itemDispatchState(order,item);
                const qty=Number(notice.qty || 0);
                if(qty<=0 || state.pending+state.shippable+1e-9<qty) throw new Error('目前可出貨數量不足，請重新核對訂單。');
                const actor=currentUserName || currentUser?.email || '外倉出貨';
                const now=isoNow();
                const record={
                    id:deliveryRecordId(),itemId,date:localDateString(),qty,
                    notes:`外倉 ${draft.warehouse.warehouseName} 已出貨`,
                    sourceType:'EXTERNAL_WAREHOUSE_SHIP',externalNoticeId:currentLine.noticeId,
                    warehouseId:notice.warehouseId,createdByUid:currentUser?.uid || '',
                    createdBy:actor,createdAt:now
                };
                const existingRecords=savedDeliveryRecords(order).slice();
                if(existingRecords.some(row=>row.externalNoticeId===currentLine.noticeId)) throw new Error('這份外倉通知已記錄出貨，不能重複扣庫存。');
                const itemOrder={...order,...item,itemId,deliveryRecords:existingRecords.filter(row=>row.itemId===itemId),isDelivered:false};
                const stock=await applyInventoryDeliveryDeltaInTransaction(tx,itemOrder,qty,actor,draft.orderId);
                record.lotAllocations=stock?.lotAllocations || [];
                record.cogs=Number(stock?.cogs || 0);
                record.movementId=stock?.movementId || '';
                existingRecords.push(record);
                items[idx]={...item,dispatchPreparedQty:Math.max(Number(item.dispatchPreparedQty||0),state.delivered+qty),
                    reservedQty:Number(stock?.newReservedQty ?? item.reservedQty ?? 0)};
                const deliveredQty=existingRecords.reduce((sum,row)=>sum+Number(row.qty||0),0);
                const total=orderQuantity(order);
                const effectiveDelivered=Math.max(0,deliveredQty-returnedQuantity(order));
                const history={action:'create',source:'external_warehouse',recordId:record.id,before:null,after:record,by:actor,at:now};
                const updates={items,deliveryRecords:existingRecords,deliveredQty,isDelivered:effectiveDelivered>=total,
                    deliveryHistory:firebase.firestore.FieldValue.arrayUnion(history),updatedAt:now};
                Object.assign(updates,orderWorkIndexFields({...order,...updates}));
                tx.update(orderRef,updates);
                tx.update(noticeRef,{
                    status:'SHIPPED',shippedByUid:currentUser?.uid || '',
                    shippedBy:actor,shippedAt:now,deliveryRecordId:record.id,
                    movementId:record.movementId,updatedAt:now
                });
                savedOrder={id:draft.orderId,...order,...updates};
            });
            const index=ordersCache.findIndex(order=>order.id===draft.orderId);
            if(index>=0)ordersCache[index]=savedOrder;
            syncOrderIntoPurchasingCaches(savedOrder,{render:false});
            writeAppDataCache('orders',ordersCache);
            await reloadDraft();
            if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
            setFeedback('外倉已出貨，送貨及該倉庫存已在同一筆交易記錄完成。');
        } catch(err) {
            setFeedback(`確認外倉出貨失敗：${err.message}`,true);
        } finally {
            busy.delete('ship');
            if(button)button.disabled=false;
        }
    };
})(window);
