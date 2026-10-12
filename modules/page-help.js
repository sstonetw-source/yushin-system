/* Page help reads existing UI state and capability predicates only; no network reads. */
(function () {
    'use strict';
    const pages = {
        'quote-system': { title: '估價單', permission: 'quote', scope: 'quotes', purpose: '製作估價單、三家比價與決標單價分析，查詢既有估價紀錄。', steps: ['選擇報價公司，填寫客戶與品項，確認金額後儲存或匯出 PDF。', '在估價單清單搜尋、查看或調出既有紀錄；成交後可依權限建立客戶訂單。'] },
        'forecast-system': { title: 'Forecast', permission: 'forecast', scope: 'forecasts', purpose: '追蹤客戶案件、預估金額及成交進度。', steps: ['新增案件後持續更新進度，成交或未成交時結案。', 'Stage 1：需求確認／Demo；2：報價／規格／方案；3：預算／經費申請；4：採購／標案／議價；5：成交／交機。', '進行中：持續追蹤；Win：成交結案；Lost：未成交結案。'] },
        'product-system': { title: '產品', permission: 'products', purpose: '搜尋產品主檔、查看庫存狀態，選品後帶入同一張單據。', steps: ['先選廠牌，再輸入完整貨號並按「搜尋產品」；需要產品清單時使用「瀏覽此廠牌產品」。', '勾選品項後，可依權限加入估價單、訂單或採購單。'] },
        'order-system': { title: '訂單', permission: 'orders.list', scope: 'orders', purpose: '管理客戶訂單，查看各品項採購、到貨、打單、送貨與核銷進度。', steps: ['新增訂單可一次加入多個品項；後續採購、到貨與出貨可依品項分批處理。', '已到貨品項完成打單後，業務可領貨或送貨，不必等待整張訂單全部到貨。', '核銷可先辦理，不必等所有品項完成送貨。取消與退貨請從原訂單處理，並確認畫面列出的庫存及採購影響。'] },
        'purchasing-system': { title: '採購', permission: 'orders.po', scope: 'orders', purpose: '處理客戶訂單採購需求、備貨與安全庫存補貨，追蹤採購單及到貨進度。', steps: ['選擇待採購品項，確認供應商與成本後建立採購單，或使用既有直接採購操作。', '依品項追蹤到貨；完成打單後，客戶訂單繼續進入送貨與核銷流程。', '客戶取消訂單後，已向供應商採購的貨品仍須另行確認是否能取消採購；無法取消的貨品到貨後成為可用庫存。'] },
        'inventory-system': { title: '倉庫', permission: 'inventory', purpose: '管理各倉庫數量，確認採購、退貨與調撥收貨，安排出貨及領貨。', steps: ['庫存清單：查看現有、已占用、可用與在途數量，依權限調整數量、庫存策略或調撥。', '收貨：點貨後確認實收數量；退貨申請本身不增加庫存，實際收貨才入庫。', '出貨：依出貨倉庫及交付方式處理主倉、分倉、調回主倉與待領貨；可列印出貨清單與地址貼紙。', '寄給業務後仍須由業務完成客戶送貨；分倉貨品可直接寄客戶，或先調回主倉。'] },
        'equipment-system': { title: '儀器', permission: 'equipment', scope: 'equipment', purpose: '管理客戶儀器與維修、保養、校正紀錄，查詢下次到期日。', steps: ['搜尋或篩選儀器，開啟紀錄查看基本資料與維修保養歷程。', '批量匯入依儀器編號新增或更新，保留既有維修保養紀錄；匯出以目前已載入的篩選結果為範圍。'] },
        'admin-system': { title: '管理員後台', permission: 'admin', purpose: '管理人員、廠牌、價目表、倉庫設定與進銷存分析，執行資料檢查及備份。', steps: ['選擇對應工作分頁；單一產品的日常操作使用「產品」頁面。', '資料檢查、備份與用量計算需手動執行；執行前先確認範圍與資料讀取影響。', '刪除價目表、清除資料或人員交接前，請核對預覽與確認訊息。'] }
    };
    const contexts = {
        inventoryStockPanel: '庫存清單', inventoryReceivingPanel: '收貨', inventoryShippingPanel: '出貨',
        quoteCreatePanel: '建立估價單', myQuotesPanel: '估價單清單',
        purchasePendingPanel: '待採購', poListPanel: '採購單清單', purchaseDispatchPanel: '待打單',
        purchaseCompletedPanel: '已完成打單', purchaseSupplierPanel: '供應商設定',
        'admin-sales': '人員名單', 'admin-agencies': '廠牌管理', 'admin-products': '價目表管理',
        'admin-statistics': '進銷存分析', 'admin-warehouses': '倉庫管理', 'admin-health': '資料健康',
        'admin-transfer': '人員異動交接', 'admin-storage': '資料庫管理'
    };
    const visible = node => !!node && !node.hidden && node.getClientRects().length > 0;
    const allowed = name => typeof window[name] === 'function' && window[name]();
    function section(body, title, lines) {
        if (!lines.length) return;
        const group = document.createElement('section');
        const heading = document.createElement('h4'); heading.textContent = title;
        const list = document.createElement('ul');
        lines.forEach(text => { const item = document.createElement('li'); item.textContent = text; list.append(item); });
        group.append(heading, list); body.append(group);
    }
    function permissions(page) {
        const role = typeof currentUserRole === 'undefined' ? null : currentUserRole;
        const label = typeof ROLE_LABELS === 'undefined' ? '' : ROLE_LABELS[role];
        const level = typeof getPagePermission === 'function' ? getPagePermission(page.permission) : 'none';
        const lines = [`目前身份：${label || '尚未確認'}；本頁${level === 'edit' ? '可操作' : level === 'view' ? '可查看' : '無存取權限'}。`];
        if (level === 'none') return lines;
        if (page.scope && typeof getDataScope === 'function') {
            const scope = getDataScope(page.scope);
            lines.push(scope === 'all' ? '資料範圍：全部授權資料。' : scope === 'own' ? '資料範圍：自己負責或系統授權給自己的紀錄。' : '資料範圍依目前帳號的授權限制。');
        }
        const key = page.permission;
        if (key === 'products') {
            lines.push(allowed('canManagePendingProductMaster') ? '可新增與編輯產品主檔。' : '產品主檔可查看；選品建立單據仍依各單據權限。');
            if (allowed('canDeleteProductMaster')) lines.push('可永久刪除產品主檔；執行前須確認影響。');
        }
        if (key === 'forecast') lines.push(allowed('canCreateForecastCapability') ? '可新增案件與更新進度。' : '無新增案件權限。');
        if (key === 'orders.list') lines.push(allowed('canManageOrderLifecycleCapability') ? '可依訂單歸屬及品項狀態辦理自行訂貨、送貨、核銷、取消與退貨。' : '客戶送貨、取消與退貨由有訂單處理權限的人員辦理。');
        if (key === 'orders.po') lines.push(allowed('canCreatePurchaseOrderCapability') ? '可建立採購單與處理採購需求。' : '採購單可查看；建立採購單由採購或管理員辦理。');
        if (key === 'inventory') {
            lines.push(allowed('canReceiveInventoryCapability') ? '可辦理收貨與倉庫作業。' : '可查看庫存，無收貨與倉庫數量異動權限。');
            if (allowed('canManageInventoryStockPolicy')) lines.push('可設定庫存策略與安全庫存。');
            if (allowed('canManageInventoryList')) lines.push('可移出或恢復庫存清單品項。');
        }
        if (key === 'equipment') lines.push(allowed('canManageEquipmentCapability') ? '可維護儀器與維修保養紀錄。' : '可依歸屬維護儀器基本資料；維修保養紀錄由工程師或管理員維護。');
        lines.push('實際操作仍依資料歸屬、品項狀態及系統權限檢查。');
        return lines;
    }
    function init() {
        const dialog = document.getElementById('pageHelpDialog');
        const body = document.getElementById('pageHelpBody');
        let trigger = null;
        document.addEventListener('click', event => {
            const button = event.target.closest('[data-page-help]');
            if (!button) return;
            const key = button.dataset.pageHelp, page = pages[key];
            const owner = document.getElementById(key);
            if (!page || !visible(owner)) return;
            trigger = button;
            document.getElementById('pageHelpTitle').textContent = page.title + '｜頁面說明';
            body.replaceChildren();
            section(body, '頁面功能', [page.purpose]);
            const context = Object.keys(contexts).find(id => owner.contains(document.getElementById(id)) && visible(document.getElementById(id)));
            if (context) section(body, '目前分頁', [contexts[context]]);
            section(body, '主要操作', page.steps);
            section(body, '目前角色權限', permissions(page));
            const notes = Array.from(document.querySelectorAll('[data-page-help-source]'))
                .filter(node => node.dataset.pageHelpSource === key && (!node.dataset.helpContext || visible(document.getElementById(node.dataset.helpContext))))
                .map(node => node.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
            section(body, '操作補充', [...new Set(notes)]);
            dialog.showModal();
            body.scrollTop = 0;
        });
        dialog.querySelector('[data-close-page-help]').addEventListener('click', () => dialog.close());
        dialog.addEventListener('click', event => {
            const rect = dialog.getBoundingClientRect();
            if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
        });
        dialog.addEventListener('close', () => { if (trigger?.isConnected) trigger.focus(); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
