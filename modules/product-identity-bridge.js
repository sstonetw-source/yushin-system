(function () {
    'use strict';

    function normalizePartNo(value) {
        return String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s\-_]+/g, '');
    }

    function savedPoItems(po) {
        const source = [po?.items, po?.orderItems, po?.purchaseItems, po?.lineItems, po?.products]
            .find(items => Array.isArray(items) && items.length)
            || ((po?.itemName || po?.productName || po?.itemCode || po?.productCode) ? [po] : []);
        return source.map((item, index) => ({
            ...item,
            _index: index,
            itemCode: item.itemCode || item.productCode || item.code || item.model || '',
            itemName: item.itemName || item.productName || item.name || item.nameCn || '',
            productId: item.productId || '',
            orderId: item.orderId || item.sourceOrderId || '',
            orderItemIndex: item.orderItemIndex ?? index
        }));
    }

    async function exactProductByCode(code) {
        const normalized = normalizePartNo(code);
        if (!normalized) return null;
        const snap = await db.collection('products').where('normalizedPartNo', '==', normalized).limit(3).get();
        const active = snap.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(product => product.status !== 'INACTIVE' && product.active !== false);
        if (active.length !== 1) {
            if (active.length > 1) throw new Error(`貨號 ${code} 在 Product Master 有 ${active.length} 筆符合資料，請先整理重複產品。`);
            return null;
        }
        return active[0];
    }

    async function repairSourceOrderIdentity(item, identity) {
        if (!item.orderId) return;
        const ref = db.collection('orders').doc(item.orderId);
        await db.runTransaction(async tx => {
            const snap = await tx.get(ref);
            if (!snap.exists) return;
            const order = snap.data();
            const items = Array.isArray(order.items) ? order.items.map(row => ({ ...row })) : [];
            const index = Number(item.orderItemIndex || 0);
            if (!items[index]) return;
            const source = items[index];
            // 只補缺少的識別資料；不覆蓋已存在且不同的 Product ID，避免把舊單誤綁到另一產品。
            if (source.productId && source.productId !== identity.productId) {
                throw new Error('來源訂單已有不同 Product ID，請先人工確認資料，系統不會自動覆蓋。');
            }
            items[index] = {
                ...source,
                productId: identity.productId,
                itemCode: source.itemCode || identity.itemCode,
                itemCodeKey: source.itemCodeKey || normalizePartNo(identity.itemCode),
                inventoryProductKey: source.inventoryProductKey || identity.productId
            };
            tx.update(ref, { items, itemCount: items.length, orderSchemaVersion: 2, updatedAt: new Date().toISOString() });
        });
    }

    async function ensurePoItemIdentity(poId, itemIndex) {
        const ref = db.collection('purchaseOrders').doc(poId);
        const snap = await ref.get();
        if (!snap.exists) throw new Error('找不到訂購單。');
        const po = snap.data();
        const items = savedPoItems(po);
        const item = items[itemIndex];
        if (!item) throw new Error('找不到訂購單品項。');
        if (item.productId) return;

        let code = String(item.itemCode || '').trim();
        let product = code ? await exactProductByCode(code) : null;
        if (!product) {
            const entered = window.prompt(`「${item.itemName || '此品項'}」缺少 Product ID。\n請輸入 Product Master 中的正確貨號後再入庫：`, code);
            if (entered === null) throw new Error('已取消入庫；尚未指定 Product Master。');
            code = String(entered || '').trim();
            if (!code) throw new Error('必須輸入正確貨號才能入庫。');
            product = await exactProductByCode(code);
            if (!product) throw new Error(`Product Master 找不到貨號 ${code}，請先建立／確認產品主檔。`);
        }

        const productId = String(product.productId || product.id || '').trim();
        const itemCode = String(product.manufacturerPartNo || product.sku || code).trim();
        if (!productId) throw new Error('Product Master 此產品缺少 Product ID。');
        const nextItems = items.map((row, index) => index === itemIndex ? {
            ...row,
            productId,
            itemCode,
            itemName: row.itemName || product.productName || product.nameCn || product.nameEn || '',
            brand: row.brand || product.brandName || product.brand || ''
        } : row);

        await ref.set({ items: nextItems.map(({ _index, ...row }) => row), updatedAt: new Date().toISOString() }, { merge: true });
        await repairSourceOrderIdentity(item, { productId, itemCode });
    }

    async function ensurePoIdentity(poId, onlyIndex = null) {
        const snap = await db.collection('purchaseOrders').doc(poId).get();
        if (!snap.exists) throw new Error('找不到訂購單。');
        const items = savedPoItems(snap.data());
        const indexes = onlyIndex === null ? items.map((_, index) => index) : [Number(onlyIndex)];
        for (const index of indexes) {
            const item = items[index];
            if (!item || item.productId || (item.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') continue;
            await ensurePoItemIdentity(poId, index);
        }
    }

    const originalReceiveItem = window.receivePurchaseOrderItem;
    if (typeof originalReceiveItem === 'function') {
        window.receivePurchaseOrderItem = async function (poId, itemIndex) {
            try {
                await ensurePoIdentity(poId, itemIndex);
                return originalReceiveItem.call(this, poId, itemIndex);
            } catch (err) {
                alert('到貨前產品資料檢查未通過：' + (err?.message || err));
            }
        };
    }

    const originalReceivePo = window.receivePurchaseOrder;
    if (typeof originalReceivePo === 'function') {
        window.receivePurchaseOrder = async function (poId) {
            try {
                await ensurePoIdentity(poId);
                return originalReceivePo.call(this, poId);
            } catch (err) {
                alert('到貨前產品資料檢查未通過：' + (err?.message || err));
            }
        };
    }
})();

(function () {
    'use strict';
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    // 新版介面已由正式 HTML / app.js 提供；舊版部署才需要以下相容補丁。
    if (document.getElementById('purchaseCompletedPanel')) return;

    const PATCH_ID = 'yushin-ux-patch-20260930';
    const raf = fn => window.requestAnimationFrame ? window.requestAnimationFrame(fn) : setTimeout(fn, 0);

    function safe(fn) {
        try { return fn(); } catch (err) { console.warn('[yushin ux patch]', err); }
    }

    function setTextBySelector(selector, text) {
        const el = document.querySelector(selector);
        if (el && el.textContent !== text) el.textContent = text;
    }

    function installStyles() {
        if (document.getElementById(PATCH_ID + '-style')) return;
        const style = document.createElement('style');
        style.id = PATCH_ID + '-style';
        style.textContent = `
            .yx-module-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px;flex-wrap:wrap;}
            .yx-module-header h2{margin:0;font-size:22px;color:#203040;}
            .yx-module-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
            #purchasePendingPanel table th:nth-child(2),#purchasePendingPanel table td:nth-child(2),
            #purchaseDispatchPanel table th:nth-child(2),#purchaseDispatchPanel table td:nth-child(2){display:none;}
            #poItemsBody input.yx-po-identity-input{min-width:110px;border:1px solid #d0d7de;border-radius:4px;padding:4px 6px;background:#fff;}
            #poItemsBody input.yx-po-identity-input:placeholder-shown{border-color:#d92d20;background:#fff7f6;}
            #purchaseCompletedPanel{display:none;}
            @media(max-width:720px){.yx-module-header{align-items:stretch}.yx-module-header h2{font-size:18px}.yx-module-actions button{width:100%;}}
        `;
        document.head.appendChild(style);
    }

    function ensureModuleHeaders() {
        safe(() => {
            const orderPanel = document.getElementById('orderListPanel');
            if (orderPanel && !document.getElementById('orderModuleHeader')) {
                const header = document.createElement('div');
                header.id = 'orderModuleHeader';
                header.className = 'yx-module-header no-print';
                header.innerHTML = '<h2>訂單管理</h2><div class="yx-module-actions" id="orderModuleActions"></div>';
                orderPanel.insertBefore(header, orderPanel.firstChild);
            }
            const orderAction = document.querySelector('#orderListPanel .order-primary-toolbar button[onclick="openOrderModal()"]');
            const orderActions = document.getElementById('orderModuleActions');
            if (orderAction && orderActions && orderAction.parentElement !== orderActions) {
                orderAction.textContent = '＋ 新增訂單';
                orderActions.appendChild(orderAction);
            }
        });

        safe(() => {
            const purchasing = document.getElementById('purchasing-system');
            const cards = document.getElementById('purchaseWorkCards');
            if (purchasing && cards && !document.getElementById('purchaseModuleHeader')) {
                const header = document.createElement('div');
                header.id = 'purchaseModuleHeader';
                header.className = 'yx-module-header no-print';
                header.innerHTML = '<h2>採購管理</h2><div class="yx-module-actions" id="purchaseModuleActions"></div>';
                purchasing.insertBefore(header, cards);
            }
            const purchaseAction = document.querySelector('#purchasePendingPanel button[onclick="openDirectStockPurchase()"]');
            const purchaseActions = document.getElementById('purchaseModuleActions');
            if (purchaseAction && purchaseActions && purchaseAction.parentElement !== purchaseActions) {
                purchaseAction.textContent = '＋ 新增採購單';
                purchaseActions.appendChild(purchaseAction);
            }
        });
    }

    function ensureCompletedPurchaseUi() {
        const cards = document.getElementById('purchaseWorkCards');
        if (!cards) return;
        if (!document.getElementById('purchase-card-completed')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'order-work-card';
            btn.id = 'purchase-card-completed';
            btn.setAttribute('onclick', "switchPurchasingView('completed', this)");
            btn.innerHTML = '<span>已完成</span><strong id="purchaseCountCompleted">0 筆</strong><small id="purchaseAmountCompleted">NT$ 0</small>';
            const history = document.getElementById('purchase-card-history');
            cards.insertBefore(btn, history || null);
        }
        setTextBySelector('#purchase-card-history span', '全部採購單');
        setTextBySelector('#purchase-card-history small', '正式訂購單');

        const purchasing = document.getElementById('purchasing-system');
        if (!purchasing || document.getElementById('purchaseCompletedPanel')) return;
        const panel = document.createElement('div');
        panel.id = 'purchaseCompletedPanel';
        panel.innerHTML = `
            <div class="toolbar no-print"><button type="button" class="btn-secondary" onclick="loadPurchasingDispatchOrders(true)">🔄 重新整理</button><span id="purchaseCompletedStatus" role="status"></span></div>
            <div class="inventory-summary-note">顯示採購端已完成打單的品項；客戶訂單仍會繼續待出貨、待核銷流程。</div>
            <div class="table-wrap"><table><thead><tr><th>訂單日期</th><th>客戶</th><th>負責業務</th><th>已完成採購品項</th><th>操作</th></tr></thead><tbody id="purchaseCompletedBody"></tbody></table></div>
        `;
        purchasing.appendChild(panel);
    }

    function isPurchasingCompletedItem(order, item) {
        if (!order || !item) return false;
        if (typeof normalizedOrderStatus === 'function' && normalizedOrderStatus(order) !== 'normal') return false;
        if ((item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return false;
        const state = typeof itemDispatchState === 'function' ? itemDispatchState(order, item) : null;
        return Number(item.dispatchPreparedQty || 0) > 0 && (!state || Number(state.pending || 0) <= 0);
    }

    function completedPurchaseRows() {
        const rows = [];
        const filters = typeof purchaseFilterContext === 'function' ? purchaseFilterContext() : null;
        const orders = Array.isArray(ordersCache) ? ordersCache : [];
        orders.forEach(order => {
            const items = typeof normalizedOrderItems === 'function' ? normalizedOrderItems(order) : (Array.isArray(order.items) ? order.items : []);
            items.forEach(item => {
                if (!isPurchasingCompletedItem(order, item)) return;
                if (filters && typeof purchaseLineMatchesFilters === 'function' && !purchaseLineMatchesFilters(order.orderDate, order.salesName, item.brand, filters)) return;
                rows.push({ order, item });
            });
        });
        return rows;
    }

    window.renderPurchasingCompletedOrders = function () {
        const body = document.getElementById('purchaseCompletedBody');
        const status = document.getElementById('purchaseCompletedStatus');
        if (!body) return;
        const rows = completedPurchaseRows();
        body.innerHTML = rows.map(({ order, item }) => {
            const state = typeof itemDispatchState === 'function' ? itemDispatchState(order, item) : { prepared: item.dispatchPreparedQty || 0 };
            const qty = Number(state.prepared || item.dispatchPreparedQty || item.qty || 0);
            return `<tr><td data-th="訂單日期">${escapeHtml(order.orderDate || '')}</td><td data-th="客戶">${escapeHtml(order.customerName || order.customer || '')}</td><td data-th="負責業務">${escapeHtml(order.salesName || '')}</td><td data-th="已完成採購品項">${escapeHtml(item.itemCode || item.itemName || item.itemId || '')} × ${qty}</td><td data-th="操作" class="no-print"><button type="button" class="btn-small btn-secondary" onclick="openDeliveryModal('${escapeAttr(order.id)}')">查看訂單進度</button></td></tr>`;
        }).join('');
        if (status) status.textContent = rows.length ? `已顯示 ${rows.length} 筆採購已完成品項` : '目前沒有採購已完成品項';
    };

    function updateCompletedMetrics() {
        const rows = completedPurchaseRows();
        const count = document.getElementById('purchaseCountCompleted');
        const amount = document.getElementById('purchaseAmountCompleted');
        if (count) count.textContent = `${rows.length} 筆`;
        if (amount) {
            const total = rows.reduce((sum, row) => sum + (Number(row.item.unitPrice || row.item.salesPrice || 0) * Number(row.item.qty || row.item.orderedQty || 0)), 0);
            amount.textContent = typeof formatStatsMoney === 'function' ? formatStatsMoney(total) : `NT$ ${Math.round(total).toLocaleString()}`;
        }
    }

    function showPurchasingPanel(view) {
        const pendingPanel = document.getElementById('purchasePendingPanel');
        const poPanel = document.getElementById('poListPanel');
        const dispatchPanel = document.getElementById('purchaseDispatchPanel');
        const completedPanel = document.getElementById('purchaseCompletedPanel');
        if (pendingPanel) pendingPanel.style.display = view === 'ordering' ? '' : 'none';
        if (poPanel) poPanel.style.display = (view === 'receiving' || view === 'history') ? '' : 'none';
        if (dispatchPanel) dispatchPanel.style.display = view === 'dispatch' ? '' : 'none';
        if (completedPanel) completedPanel.style.display = view === 'completed' ? '' : 'none';
    }

    function patchPurchasingFunctions() {
        if (window.__yushinUxPurchasingPatched) return;
        window.__yushinUxPurchasingPatched = true;
        const originalRenderCards = window.renderPurchasingWorkCards;
        if (typeof originalRenderCards === 'function') {
            window.renderPurchasingWorkCards = function () {
                const result = originalRenderCards.apply(this, arguments);
                ensureCompletedPurchaseUi();
                updateCompletedMetrics();
                return result;
            };
        }
        const originalRenderView = window.renderPurchasingView;
        if (typeof originalRenderView === 'function') {
            window.renderPurchasingView = function () {
                if (typeof purchasingView !== 'undefined' && purchasingView === 'completed') {
                    populatePurchasingFilters?.();
                    renderPurchasingWorkCards?.();
                    window.renderPurchasingCompletedOrders?.();
                    return;
                }
                return originalRenderView.apply(this, arguments);
            };
        }
        const originalSwitch = window.switchPurchasingView;
        if (typeof originalSwitch === 'function') {
            window.switchPurchasingView = function (view, tab) {
                if (view !== 'completed') return originalSwitch.apply(this, arguments);
                if (typeof canAccessPage === 'function' && !canAccessPage('orders.po')) return;
                purchasingView = 'completed';
                populatePurchasingFilters?.();
                ensureCompletedPurchaseUi();
                renderPurchasingWorkCards?.();
                document.querySelectorAll('#purchaseWorkCards .order-work-card').forEach(el => el.classList.toggle('active', el === (tab || document.getElementById('purchase-card-completed'))));
                showPurchasingPanel('completed');
                window.renderPurchasingCompletedOrders?.();
                if (typeof refreshPurchasingOrderCache === 'function') refreshPurchasingOrderCache(true).then(() => {
                    if (purchasingView === 'completed') {
                        renderPurchasingWorkCards?.();
                        window.renderPurchasingCompletedOrders?.();
                    }
                }).catch(err => console.warn('採購已完成資料刷新失敗：', err));
            };
        }
    }

    function replacePoButtonLabels() {
        document.querySelectorAll('button').forEach(button => {
            const text = (button.textContent || '').trim();
            if (text === '＋ 原廠備貨採購') button.textContent = '＋ 新增採購單';
            if (text === '儲存備貨訂購單' || text === '確認已訂購／儲存訂購單') button.textContent = '🖨️ 列印 / 存為 PDF（自動同步雲端）';
            if (text === '🖨️ 列印／輸出 PDF') button.textContent = '🖨️ 列印 / 存為 PDF';
            if (text === '＋ 新增備貨品項') button.textContent = '＋ 新增採購品項';
        });
        const hint = document.getElementById('poModeHint');
        if (hint) hint.textContent = hint.textContent
            .replace('原廠備貨採購', '新增採購單')
            .replace('備貨訂購單', '採購單');
        const status = document.getElementById('poSaveStatus');
        if (status) status.textContent = status.textContent
            .replace('這張備貨訂購單尚未建立', '這張採購單尚未建立')
            .replace('確認品項、廠商與單價後再儲存', '確認品項、廠商與單價後即可列印 / 存為 PDF');
    }

    function patchPoModeFunctions() {
        if (window.__yushinUxPoPatched) return;
        window.__yushinUxPoPatched = true;
        const originalUpdatePoButton = window.updatePoSaveButton;
        if (typeof originalUpdatePoButton === 'function') {
            window.updatePoSaveButton = function () {
                const result = originalUpdatePoButton.apply(this, arguments);
                replacePoButtonLabels();
                return result;
            };
        }
        const originalUpdateMode = window.updatePoModeUI;
        if (typeof originalUpdateMode === 'function') {
            window.updatePoModeUI = function () {
                const result = originalUpdateMode.apply(this, arguments);
                replacePoButtonLabels();
                return result;
            };
        }
        const originalRenderPoItems = window.renderPoItemsTable;
        if (typeof originalRenderPoItems === 'function') {
            window.renderPoItemsTable = function () {
                const result = originalRenderPoItems.apply(this, arguments);
                raf(patchPoIdentityEditors);
                return result;
            };
        }
    }

    function patchPoIdentityEditors() {
        const body = document.getElementById('poItemsBody');
        if (!body) return;
        const rows = [...body.querySelectorAll('tr')];
        rows.forEach((tr, idx) => {
            const cells = tr.querySelectorAll('td');
            if (cells.length < 3) return;
            const fields = [
                { cell: cells[0], field: 'itemName', placeholder: '品名 / 規格' },
                { cell: cells[1], field: 'itemCode', placeholder: '貨號' },
                { cell: cells[2], field: 'brand', placeholder: '廠牌' }
            ];
            fields.forEach(({ cell, field, placeholder }) => {
                if (cell.querySelector('input')) return;
                const value = (cell.textContent || '').trim();
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'yx-po-identity-input';
                input.value = value === 'undefined' ? '' : value;
                input.placeholder = placeholder;
                if (field === 'itemCode') input.setAttribute('list', 'priceModelList');
                if (field === 'brand') input.setAttribute('list', 'poBrandList');
                input.addEventListener('change', function () {
                    if (field === 'itemCode' && typeof window.onDirectPoCodeChange === 'function') window.onDirectPoCodeChange(idx, this.value);
                    else if (typeof window.updateDirectPoText === 'function') window.updateDirectPoText(idx, field, this.value);
                });
                cell.textContent = '';
                cell.appendChild(input);
            });
        });
    }

    function patchStaticTexts() {
        setTextBySelector('#purchase-card-history span', '全部採購單');
        document.querySelectorAll('*').forEach(el => {
            if (el.childNodes.length !== 1 || el.firstChild.nodeType !== Node.TEXT_NODE) return;
            const text = el.textContent;
            if (text === '＋ 原廠備貨採購') el.textContent = '＋ 新增採購單';
            if (text === '負責人') el.textContent = '負責業務';
        });
        replacePoButtonLabels();
    }

    function install() {
        installStyles();
        ensureModuleHeaders();
        ensureCompletedPurchaseUi();
        patchPurchasingFunctions();
        patchPoModeFunctions();
        patchStaticTexts();
        updateCompletedMetrics();
        patchPoIdentityEditors();
    }

    install();
    setTimeout(install, 300);
    setTimeout(install, 1200);
    const observer = new MutationObserver(() => {
        clearTimeout(window.__yushinUxPatchTimer);
        window.__yushinUxPatchTimer = setTimeout(() => safe(install), 80);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
})();
