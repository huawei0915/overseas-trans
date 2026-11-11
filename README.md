# 雙向即時語音翻譯（Overseas Trans）

純靜態網頁的雙人即時語音翻譯工具：雙方各自選定語言，按下麥克風說話，**停頓 5 秒後自動翻譯並以對方語言播放語音**，下方同步顯示原文與譯文的對話紀錄。

## 執行方式

需使用 **Chrome 或 Edge**，並透過 `localhost`（或 HTTPS）開啟，否則無法使用麥克風與語音辨識：

```bash
cd overseas-trans

# 1) 啟動後端 proxy（避免瀏覽器直連翻譯 API 的 CORS 問題）
cp .env.example .env
# 依需求填入 AZURE_KEY / GOOGLE_KEY / DEEPL_KEY（至少一組）
set -a && source .env && set +a
npm run start:proxy

# 2) 另開一個終端啟動前端靜態頁
python3 -m http.server 8000

# 開啟 http://localhost:8000
```

## 使用方式

1. 後端 proxy 啟動後，前端設定面板預設使用 **Proxy 模式**（`http://localhost:8787`）。
2. 若使用 Proxy 模式，翻譯 API Key 請設定在後端 `.env`，前端不用再貼 key。
3. 用「測試連線」驗證服務可用後即可開始。
4. 甲方 / 乙方各自選擇語言，按下「開始對話」（只需按一次）。
5. 點甲方 / 乙方卡片切換目前說話者；系統也會在每句定稿前自動偵測來源語言（Azure/Google）並校正說話者語系。
6. 持續說話即可，**停頓 5 秒自動結句**；若 5 秒內有新語音則取消倒數、繼續累積，避免中途切段。
7. 定稿後自動翻譯 → 播放譯文語音 → 顯示於對話紀錄，全程不需再按任何按鈕。
8. 播放譯文時會自動暫停辨識，避免麥克風把喇叭聲音誤收進來。
9. 對話結束時按「停止對話」。

## 自動容錯

額度用盡（HTTP 429 / 403 / 456）時，依設定順序自動切換（預設 **Azure → Google → DeepL**）。標頭的狀態燈會顯示每家服務為「就緒 / 使用中 / 額度已盡 / 未設定」。

## 架構

```
index.html      版面：語言選擇、麥克風按鈕、對話紀錄、設定面板
css/style.css   樣式
js/langs.js     語言碼對照表（Web Speech ↔ Azure / Google / DeepL）
js/config.js    localStorage 設定存取
js/translate.js 翻譯 provider 抽象層 + 額度容錯切換
js/stt.js       Web Speech 辨識 + 5 秒靜音自動結句
js/tts.js       speechSynthesis 播放佇列
js/app.js       主流程串接
proxy-server.mjs 後端 Proxy（/api/translate, /api/detect, /api/test）
```

## 注意事項

- 建議使用 Proxy 模式：把 API Key 放在後端 `.env`，避免前端外露並可避開 CORS。
- Web Speech API 的辨識在 Chrome/Edge 上最完整。
- DeepL `:fx` Key 為 Free 方案；系統會自動使用 `api-free.deepl.com`。貼上 Key 時若含引號（例如 `‘...:fx’`）會自動清理。
