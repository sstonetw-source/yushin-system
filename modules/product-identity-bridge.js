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
