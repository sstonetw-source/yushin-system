window.startNextQuote = async function() {
    if (!confirm('確定要開始製作下一張估價單嗎？目前畫面上的內容將會被清空（如果還沒匯出 PDF，請先確認已經處理好）。')) return;
    ++quoteNoGeneration;
    setQuoteEditingContext('');
    setQuoteOutputStatus('');
    await resetQuoteFormForNextOne();
    saveQuoteDraft();
};

async function resetQuoteFormForNextOne() {
    const quoteNoInput = document.getElementById('quoteNo');
    const previousNo = quoteNoInput.value || '';
    const selected = quoteOwnerFromSelection();
    document.getElementById('clientName').value = '';
    document.getElementById('ordererName').value = '';
    document.getElementById('discountRateInput').value = 0;
    document.getElementById('validDays').value = 90;
    document.getElementById('quoteRemarks').value = '';

    document.getElementById('quoteItems').innerHTML = '';
    addQuoteRow();
    calculateTotals();

    initDate();
    populateSalesDropdown(false);
    const eligible = salesList.filter(isSelectableCommercialOwner);
    let owner = ['sales','engineer'].includes(currentUserRole)
        ? {uid:currentUser?.uid,code:currentUserCode,name:currentUserName}
        : eligible.find(person => person.uid === selected.ownerUid);
    if (!owner && !selected.ownerUid && selected.salesCode) {
        const matches = eligible.filter(person => person.code === selected.salesCode);
        if (matches.length === 1) owner = matches[0];
    }
    if (!owner && currentUserRole === 'admin') owner = eligible.find(person => person.uid === currentUser?.uid);
    setQuoteOwnerSelection(owner ? {ownerUid:owner.uid,salesCode:owner.code,salesName:owner.name} : {});
    updateSalesPhoneDisplay();

    // Same-group local increments cannot race a preceding background save.
    // A new day, company or responsible person must use that group's safe lookup.
    const nextOwner = quoteOwnerFromSelection();
    if (!nextOwner.ownerUid || !nextOwner.salesCode) { quoteNoInput.value = ''; return; }
    const prefix = `${companyData[currentCompany].prefix}-${getFormattedDateCode()}-${nextOwner.salesCode}-`;
    const sequence = previousNo.startsWith(prefix) ? previousNo.slice(prefix.length) : '';
    if (/^\d+$/.test(sequence) && Number.isSafeInteger(Number(sequence) + 1)) {
        quoteNoInput.value = prefix + String(Number(sequence) + 1).padStart(Math.max(2,sequence.length), '0');
    } else {
        await generateQuoteNo();
    }

}

// 新增：處理狀態切換的函數
// 先在畫面上立即反應（樂觀更新），不用等雲端回應才變色，感覺上會快很多；
// 如果雲端寫入失敗，才把狀態復原並提示錯誤
