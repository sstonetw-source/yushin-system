(function(root) {
    'use strict';

    const DOCUMENT_TITLE = '決標單價分析';
    const BUTTON_ID = 'decisionPriceAnalysisBtn';

    function setDecisionAnalysisStatus(message, isError = false) {
        const status = document.getElementById('quoteOutputStatus');
        if (!status) return;
        status.style.display = message ? '' : 'none';
        status.textContent = message || '';
        status.classList.toggle('error', !!isError);
    }

    function decisionAnalysisFileName(quoteData = {}) {
        const baseName = typeof quotePdfFileName === 'function'
            ? quotePdfFileName(quoteData).replace(/\.pdf$/i, '')
            : ([quoteData.quoteNo, quoteData.ordererName || quoteData.clientName].filter(Boolean).join('-') || '文件')
                .replace(/[\\/:*?"<>|]+/g, '-')
                .replace(/\s+/g, ' ')
                .trim();
        return `${baseName}-${DOCUMENT_TITLE}.pdf`;
    }

    root.exportDecisionPriceAnalysisPdf = async function() {
        const validationMessage = typeof currentQuoteOutputValidation === 'function'
            ? currentQuoteOutputValidation()
            : '';
        if (validationMessage) {
            root.alert(validationMessage);
            return;
        }

        const button = document.getElementById(BUTTON_ID);
        const originalLabel = button?.innerText || `建立${DOCUMENT_TITLE}表`;
        if (button) {
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            button.innerText = `正在建立${DOCUMENT_TITLE}…`;
        }
        setDecisionAnalysisStatus('');

        let stage = null;
        try {
            if (typeof root.html2canvas !== 'function' || !root.jspdf?.jsPDF) {
                throw new Error('PDF 元件尚未載入');
            }
            if (typeof collectCurrentQuoteRecord !== 'function' ||
                typeof createQuotePdfStage !== 'function' ||
                typeof quotePdfPageHeightPx !== 'function' ||
                typeof paginateQuotePdfDocument !== 'function' ||
                typeof waitForPdfImages !== 'function' ||
                typeof addDocumentPagesToPdf !== 'function') {
                throw new Error('估價單 PDF 功能尚未完成載入');
            }

            if (root.DocumentDownloads?.prepare) {
                await root.DocumentDownloads.prepare('quote');
            }

            // 只讀取目前估價單編輯內容來產生分析表，不另外建立或覆寫 quotes 紀錄。
            const quoteData = collectCurrentQuoteRecord();
            const exportDom = createQuotePdfStage(quoteData);
            stage = exportDom.stage;
            const documentNode = exportDom.documentNode || exportDom.clone || stage?.querySelector('.quote-pdf-document');
            if (!documentNode) throw new Error('找不到估價單 PDF 版型');

            const title = documentNode.querySelector('.quote-pdf-title');
            if (!title) throw new Error('找不到估價單文件標題');
            title.textContent = DOCUMENT_TITLE;

            const numberValue = documentNode.querySelector('.quote-pdf-no');
            const numberLabel = numberValue?.parentElement?.querySelector('label');
            if (numberLabel) {
                numberLabel.textContent = '決標分析單價單號：';
                numberLabel.style.width = 'auto';
                numberLabel.style.whiteSpace = 'nowrap';
            }

            // 決標單價分析是分析／標價清單，不是正式對外估價文件，因此不顯示公司印章。
            documentNode.querySelectorAll('.stamp-section').forEach(section => section.remove());

            // 決標單價分析不顯示估價單有效期限；正式估價單仍保留原本的有效期限。
            const validityNote = [...documentNode.querySelectorAll('.footer-note')]
                .find(note => note.textContent.includes('本估價單有效期限'));
            validityNote?.remove();

            await waitForPdfImages(documentNode);
            const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
            const scale = isMobile ? 1.15 : 1.65;
            const singlePageLimit = quotePdfPageHeightPx(stage) - 12;
            const isSinglePage = documentNode.scrollHeight <= singlePageLimit;
            const pages = isSinglePage
                ? [documentNode]
                : paginateQuotePdfDocument(stage, documentNode);
            if (!isSinglePage) await waitForPdfImages(stage);

            const pdf = new root.jspdf.jsPDF({
                orientation: 'portrait',
                unit: 'mm',
                format: 'a4',
                compress: !isSinglePage
            });
            await addDocumentPagesToPdf(pdf, pages, {
                scale,
                isolateRoot: stage,
                onProgress: (pageNo, pageCount) => {
                    if (button) button.innerText = `正在建立${DOCUMENT_TITLE}… ${pageNo}/${pageCount}`;
                }
            });

            const fileName = decisionAnalysisFileName(quoteData);
            if (root.DocumentDownloads?.savePdf) {
                await root.DocumentDownloads.savePdf('quote', pdf, fileName);
            } else {
                pdf.save(fileName);
            }
            setDecisionAnalysisStatus(`${DOCUMENT_TITLE} PDF 已建立。`);
        } catch (err) {
            console.error(`建立${DOCUMENT_TITLE}失敗：`, err);
            setDecisionAnalysisStatus(`建立${DOCUMENT_TITLE}失敗：${err?.message || err}`, true);
            root.alert(`建立${DOCUMENT_TITLE}失敗：${err?.message || err}`);
        } finally {
            stage?.remove();
            if (button) {
                button.disabled = false;
                button.removeAttribute('aria-busy');
                button.innerText = originalLabel;
            }
        }
    };
})(typeof window !== 'undefined' ? window : globalThis);
