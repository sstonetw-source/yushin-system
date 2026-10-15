window.startNextQuote = function() {
    if (!confirm('確定要開始製作下一張估價單嗎？目前畫面上的內容將會被清空（如果還沒匯出 PDF，請先確認已經處理好）。')) return;
    setQuoteEditingContext('');
    setQuoteOutputStatus('');
    resetQuoteFormForNextOne();
    saveQuoteDraft();
};

function resetQuoteFormForNextOne() {
    document.getElementById('clientName').value = '';
    document.getElementById('ordererName').value = '';
    document.getElementById('discountRateInput').value = 0;
    document.getElementById('validDays').value = 90;
    document.getElementById('quoteRemarks').value = '';

    document.getElementById('quoteItems').innerHTML = '';
    addQuoteRow();
    calculateTotals();

    // 單號直接把目前這組號碼的流水號 +1，不重新查一次雲端——
    // 因為上一張單的雲端存檔是背景進行、不保證這時候已經真的寫進 Firestore，
    // 這時如果重新查詢「目前最大流水號」，很可能還查到上一張存檔前的舊資料，算出來的下一號反而會撞號
    const quoteNoInput = document.getElementById('quoteNo');
    const parts = (quoteNoInput.value || '').split('-');
    const lastPart = parts[parts.length - 1];
    const lastSeq = parseInt(lastPart, 10);
    if (parts.length >= 2 && !isNaN(lastSeq)) {
        parts[parts.length - 1] = String(lastSeq + 1).padStart(lastPart.length, '0');
        quoteNoInput.value = parts.join('-');
    }
}

// 新增：處理狀態切換的函數
// 先在畫面上立即反應（樂觀更新），不用等雲端回應才變色，感覺上會快很多；
// 如果雲端寫入失敗，才把狀態復原並提示錯誤
