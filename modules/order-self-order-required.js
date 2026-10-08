(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && root.document) {
        root.YushinOrderSelfRequired = api;
        api.install();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    const id = key => root.document?.getElementById(key);

    function validate(isSelf, supplier, cost) {
        if (!isSelf) return {valid:true};
        if (!String(supplier ?? '').trim()) return {
            valid:false, field:'orderSelfSupplier', message:'業務自行訂貨必須填寫供應商。'
        };
        const value = String(cost ?? '').trim();
        if (!value || !Number.isFinite(Number(value)) || Number(value) < 0) return {
            valid:false, field:'orderCostPrice', message:'業務自行訂貨必須填寫含稅成本（可填 0）。'
        };
        return {valid:true};
    }

    function isSelfOrder() {
        return id('orderProcurementType')?.value === 'SALES_SELF_ORDER';
    }

    function sync() {
        const self = isSelfOrder();
        for (const field of ['orderSelfSupplier', 'orderCostPrice']) {
            const input = id(field);
            if (!input) continue;
            input.required = self;
            if (!self && typeof input.setCustomValidity === 'function') input.setCustomValidity('');
        }
        for (const marker of ['orderSelfSupplierRequired', 'orderCostPriceRequired']) {
            const element = id(marker);
            if (element) element.hidden = !self;
        }
        const hint = id('orderSelfCostHint');
        if (hint) {
            hint.hidden = !self;
            hint.style.display = self ? 'block' : 'none';
        }
    }

    function checkAndReport() {
        const result = validate(isSelfOrder(), id('orderSelfSupplier')?.value, id('orderCostPrice')?.value);
        if (result.valid) return true;
        const input = id(result.field);
        if (input) {
            input.setCustomValidity(result.message);
            input.focus();
            input.reportValidity();
        }
        return false;
    }

    function hasCurrentProductInput() {
        return ['orderItemCode', 'orderItemName', 'orderItemNameEn'].some(key =>
            String(id(key)?.value || '').trim() !== ''
        );
    }

    function install() {
        const overlay = id('orderModalOverlay');
        const selector = id('orderProcurementType');
        if (!overlay || !selector || overlay.dataset.selfOrderRequiredBound === '1') return;
        overlay.dataset.selfOrderRequiredBound = '1';
        selector.addEventListener('change', sync);
        for (const field of ['orderSelfSupplier', 'orderCostPrice']) {
            const element = id(field);
            if (element) element.addEventListener('input', function () {
                this.setCustomValidity('');
            });
        }
        // Existing order form explicitly invokes this on modal open, draft edit and selection changes.
        if (typeof root.onOrderProcurementTypeChange === 'function') {
            const original = root.onOrderProcurementTypeChange;
            root.onOrderProcurementTypeChange = function (...args) {
                try { return original.apply(this, args); }
                finally { sync(); }
            };
        }
        // Capture before the inline click handlers, without changing the order write flow.
        overlay.addEventListener('click', function (event) {
            const button = event.target.closest?.('button');
            if (!button || !overlay.contains(button) || !isSelfOrder()) return;
            const action = button.getAttribute('onclick') || '';
            const adding = action.includes('addCurrentOrderItemToDraft()');
            const saving = action.includes('saveNewOrder()');
            if (!adding && !saving) return;
            sync();
            // A blank editing row is valid while saving already-added draft items.
            if ((adding || hasCurrentProductInput()) && !checkAndReport()) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        }, true);
        sync();
    }
    return {validate, sync, checkAndReport, install};
});
