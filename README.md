# 雙向即時語音翻譯（Overseas Trans）

純靜態網頁的雙人即時語音翻譯工具：雙方各自選定語言，按下麥克風說話，**停頓 2 秒後自動翻譯並以對方語言播放語音**，下方同步顯示原文與譯文的對話紀錄。

## 執行方式

需使用 **Chrome 或 Edge**，並透過 `localhost`（或 HTTPS）開啟，否則無法使用麥克風與語音辨識：

```bash
cd overseas-trans

# 0) 第一次使用先安裝後端依賴（Edge Read Aloud 語音需要）
npm install

# 1) 啟動後端 proxy（避免瀏覽器直連翻譯 API 的 CORS 問題；會自動讀取 .env）
cp .env.example .env
# 依需求填入 AZURE_KEY / GOOGLE_KEY / DEEPL_KEY（至少一組）
npm run start:proxy

# 1b)（選用）啟動 pyannote.audio 說話者辨識服務，自動分辨甲方／乙方（見下方「自動辨識甲方／乙方」）
python3.11 -m venv diarize/.venv
diarize/.venv/bin/pip install -r diarize/requirements.txt
npm run start:diarize

# 2) 另開一個終端啟動前端靜態頁
python3 -m http.server 8000

# 開啟 http://localhost:8000
```

## 部署到 GitHub Pages / 安裝到手機（PWA）

專案內含 `manifest.webmanifest` 與 `sw.js`，部署到 HTTPS 網址後可在手機 Chrome 選單 →「安裝應用程式 / 加到主畫面」。推送到 `master`/`main` 時，[.github/workflows/pages.yml](.github/workflows/pages.yml) 會自動下載模型、組出靜態網站並部署（本機可用 `npm run build:pages` 預覽 `dist-pages/`）。

```bash
git add -A && git commit -m "feat: PWA + GitHub Pages"
gh repo create overseas-trans --public --source=. --push
# 到 repo Settings → Pages → Source 選「GitHub Actions」
# 網址：https://<帳號>.github.io/overseas-trans/
```

純靜態環境沒有 proxy：預設改為「直連 API + Web Speech 播放」，請在手機的設定面板貼上 Azure 或 Google Key（只存於該手機的 localStorage，不要寫進 repo）。Edge Read Aloud 語音、pyannote 聲紋辨識需要後端，在此模式不可用。

**DeepL 會出現 CORS error**（DeepL 不允許瀏覽器直連），解法擇一：
1. 改用 Azure / Google Key（兩者支援瀏覽器直連）。
2. 部署免費的 Cloudflare Worker 當中繼：到 Cloudflare Dashboard → Workers & Pages → Create → Hello World，貼上 [cloudflare-worker/deepl-relay.js](cloudflare-worker/deepl-relay.js) 後 Deploy；或用本專案一鍵部署：

```bash
npm install
npx wrangler login
npm run deploy:deepl-relay
```

成功後會得到 `https://overseas-trans-deepl-relay.<子網域>.workers.dev`。把這個網址填進設定面板的「DeepL 中繼 URL」即可。Worker 內的 `ALLOWED_ORIGINS` 預設只允許 `https://huawei0915.github.io`，網域不同請修改。

## 使用方式

1. 後端 proxy 啟動後，前端設定面板預設使用 **Proxy 模式**（`http://localhost:8787`）。
2. 若使用 Proxy 模式，翻譯 API Key 請設定在後端 `.env`，前端不用再貼 key。
3. 用「測試連線」驗證服務可用後即可開始。
4. 甲方 / 乙方各自選擇語言，按下「開始對話」（只需按一次）。
5. 點甲方 / 乙方卡片切換目前說話者；系統也會在每句定稿前自動偵測來源語言（Azure/Google）並校正說話者語系。
6. 持續說話即可，**停頓 2 秒自動結句**；若 2 秒內有新語音則取消倒數、繼續累積，避免中途切段。
7. 定稿後自動翻譯 → 播放譯文語音 → 顯示於對話紀錄，全程不需再按任何按鈕。
8. 播放譯文時會自動暫停辨識，避免麥克風把喇叭聲音誤收進來。
9. 對話結束時按「停止對話」。

## 自動辨識甲方／乙方（pyannote.audio）

勾選畫面上的「自動辨識甲/乙方（pyannote 聲紋）」後，系統會一邊辨識語音、一邊錄下麥克風音訊，用 `pyannote/wespeaker-voxceleb-resnet34-LM`（pyannote.audio 的 speaker embedding 模型，公開模型、不需 HF token）取出每句話的聲紋並線上分群成兩位說話者，再自動：

- 判定這句話是甲方還是乙方 → 以該方語言為來源、另一方語言為譯文，自動切換翻譯方向與播放語言。
- **第一位被辨識出的說話者歸給「當下選定的說話者」**（預設甲方；開始前點卡片可改），第二位歸給另一方。
- 說話途中（約開口後 1.8 秒）會即時偵測是否換人，換人就立刻改用對方語言重新辨識（換人前 ~2 秒的內容會被捨棄，因為是以錯誤語言辨識的）。
- 聲紋判錯或換了現場的人時，按「重置聲紋」重新開始；服務未啟動或失敗時自動退回原本的「語言偵測」。

設定：環境變數 `DIARIZE_THRESHOLD`（預設 0.5，餘弦相似度≥此值視為同一人）、`DIARIZE_MIN_SECONDS`（預設 1.0，過短的音訊不辨識）、`DIARIZE_PORT`（預設 8788；proxy 以 `DIARIZE_URL` 轉發）。音訊只傳到本機服務。

## 自動容錯

額度用盡（HTTP 429 / 403 / 456）時，依設定順序自動切換（預設 **Azure → Google → DeepL**）。標頭的狀態燈會顯示每家服務為「就緒 / 使用中 / 額度已盡 / 未設定」。

## 語音引擎（播放譯文）

畫面上「🔊 語音引擎」下拉選單可隨時切換，選擇會被記住：

| 引擎 | 執行位置 | 支援語言 | 說明 |
|---|---|---|---|
| Web Speech API | 瀏覽器內建 | 全部 | 品質取決於系統語音，會自動挑選較高品質的語音 |
| **Microsoft Edge Read Aloud**（預設） | 經 proxy 後端 | 全部 12 種 | 神經語音，品質最好；需啟動 proxy，不需 API Key |
| Piper TTS | 瀏覽器內（WASM） | 中（簡體語音）/英/西/法/德/葡/越 | 離線可用；首次需下載語音模型（每個約數十 MB）並快取在瀏覽器 |
| Kokoro TTS | 瀏覽器內（WASM） | 僅英文 | 離線可用；首次需下載約 90 MB 模型 |

- 選到 Piper / Kokoro 時會**預先下載模型**（狀態顯示在下拉選單旁），不必等到第一句才開始。
- 引擎不支援目標語言（例如 Kokoro 播中文、Piper 播日文），或引擎失敗（例如 proxy 沒開）時，會**自動退回 Web Speech** 並在狀態列說明原因。
- 譯文旁的 🔊 按鈕會重播同一句；Edge / Piper / Kokoro 的音訊有快取，重播不會重複合成或呼叫後端。

## 架構

```
index.html      版面：語言選擇、麥克風按鈕、語音引擎選單、對話紀錄、設定面板
css/style.css   樣式
js/langs.js     語言碼對照表（Web Speech ↔ Azure / Google / DeepL）
js/config.js    localStorage 設定存取
js/translate.js 翻譯 provider 抽象層 + 額度容錯切換
js/stt.js       Web Speech 辨識 + 2 秒靜音自動結句
js/tts.js       多引擎 TTS（Web Speech / Edge / Piper / Kokoro）+ 播放佇列 + 自動退回
js/speaker.js   麥克風錄音切段 + 呼叫聲紋服務
js/app.js       主流程串接
diarize/server.py pyannote.audio 說話者辨識服務（/identify, /reset, /health）
proxy-server.mjs 後端 Proxy（/api/translate, /api/detect, /api/test, /api/tts/edge, /api/speaker/*）
```

## 注意事項

- 建議使用 Proxy 模式：把 API Key 放在後端 `.env`，避免前端外露並可避開 CORS。
- Web Speech API 的辨識在 Chrome/Edge/Safari 上可用；**Brave 不支援**（已停用 Google 語音服務）。語音「播放」（TTS）不受此限，任何瀏覽器都能選用上述四種引擎。
- Piper / Kokoro 的程式與模型透過 CDN（esm.sh、jsDelivr、cdnjs、HuggingFace）載入，首次使用需要網路。
- DeepL `:fx` Key 為 Free 方案；系統會自動使用 `api-free.deepl.com`。貼上 Key 時若含引號（例如 `‘...:fx’`）會自動清理。
