/* =========================================================
   Forecast：業務機會追蹤
   - Stage 1~5
   - 狀態：進行中 / Win / Lost
   - 最新進度自動帶日期
   - 完整進度歷史存於 forecasts/{id}/progress
   - 不要求預計成交日期，也不直接異動庫存
   ========================================================= */
let forecastCache = [];
let forecastCursor = null;
let forecastHasMore = true;
