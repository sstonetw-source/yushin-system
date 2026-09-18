# Phase 10 整合驗收清單

> 目標：在合併 main 前，逐項驗證桌機、iPhone 與五角色。任何失敗先修正，不直接帶入正式版。

## 裝置
- [ ] Desktop Safari/Chrome
- [ ] iPhone Safari

## 角色
- [ ] 管理員：全公司資料、五角色視角切換、權限設定
- [ ] 業務：Forecast、估價、訂單；不可越權管理採購/庫存
- [ ] 採購：採購單、收貨流程；不可越權管理員設定
- [ ] 倉管：庫存、Lot/Expiry、Ledger；不可越權管理員設定
- [ ] 工程師：儀器/維修；不可越權商務資料

## 核心流程
- [ ] Forecast 手動新增
- [ ] 估價單 → Forecast
- [ ] Forecast → 估價單
- [ ] Forecast → 訂單
- [ ] 估價單 → 訂單
- [ ] 訂單成立 Reserved 增加
- [ ] 訂單取消/作廢 Reserved 回復且不可重複
- [ ] 部分出貨 On Hand/Reserved 正確
- [ ] 完整出貨 On Hand/Reserved 正確
- [ ] 缺貨產生採購需求
- [ ] 一般備貨採購
- [ ] 採購發單只增加 Incoming，不增加 On Hand
- [ ] 部分收貨 Incoming 減少、On Hand 增加
- [ ] 完整收貨
- [ ] 重複收貨不重複入庫
- [ ] 期初庫存
- [ ] 盤點調整
- [ ] 退貨
- [ ] 報廢
- [ ] Lot/Batch 保存
- [ ] Expiry 30/60/90 天提示
- [ ] FEFO 排序

## 異常與效能
- [ ] 快速連點按鈕不重複寫入
- [ ] Firestore 寫入失敗時 UI 可恢復
- [ ] 權限不足時前端禁止且 Rules 拒絕
- [ ] 清單維持分頁，不一次載入全歷史
- [ ] 全歷史貨號搜尋仍可使用
- [ ] iPhone 返回不重載整頁
- [ ] 長估價單列印不切斷品項

## 進銷存分析
- [ ] 實際進貨只計 receipt
- [ ] 銷售以實際送貨口徑
- [ ] 進銷差額 = 銷售 - 實際進貨
- [ ] 庫存成本與 Product Master 成本一致
- [ ] Incoming 金額正確
- [ ] 日期區間切換正確

## 上線前
- [ ] Preview 完成上述驗收
- [ ] Firestore Rules 使用測試帳號驗證
- [ ] 必要 composite indexes 已建立
- [ ] GitHub Actions 綠燈
- [ ] 備份正式 Firestore
- [ ] 再依序合併至 main
