# 雙向即時語音翻譯（Overseas Trans）

純靜態網頁的雙人即時語音翻譯工具：雙方各自選定語言，按下麥克風說話，**停頓 1 秒後自動翻譯並以對方語言播放語音**，下方同步顯示原文與譯文的對話紀錄。

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

# 1b) 下載離線模型（Piper / 韓文語音；聲紋模型也會一併下載給後端使用）
npm run setup:offline

# 1c) 啟動語音辨識 + 聲紋服務（「自動辨識甲/乙方」需要；首次啟動會下載 Whisper 模型）
python3 -m venv diarize/.venv && diarize/.venv/bin/pip install -r diarize/requirements.txt
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

純靜態環境沒有 proxy：預設改為「直連 API + Web Speech 播放」，請在手機的設定面板貼上 Azure 或 Google Key（只存於該手機的 localStorage，不要寫進 repo）。Edge Read Aloud 語音與「自動辨識甲/乙方」需要後端；要在手機上使用，請照下一節把後端部署到伺服器，並設定 `PUBLIC_PROXY_BASE_URL`。

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
6. 持續說話即可，**停頓 1 秒自動結句**；若 1 秒內有新語音則取消倒數、繼續累積，避免中途切段。
7. 定稿後自動翻譯 → 播放譯文語音 → 顯示於對話紀錄，全程不需再按任何按鈕。
8. 播放譯文時會自動暫停辨識，避免麥克風把喇叭聲音誤收進來。
9. 對話結束時按「停止對話」。

## 自動辨識甲方／乙方（伺服器端語音辨識 + 聲紋）

勾選畫面上的「自動辨識甲/乙方」後，手機**只開一路麥克風**錄音，瀏覽器依音量切出每一句（停頓 1 秒結句）並把整句音訊傳到後端；後端（[diarize/server.py](diarize/server.py)）一次完成：

1. **語音轉文字**：faster-whisper（預設 `small`，可用 `WHISPER_MODEL` 改成 `tiny`/`base`/`medium`），辨識語言限定在甲/乙雙方所選語言之內擇一。
2. **聲紋分群**：wespeaker ResNet34-LM（ONNX）取出聲紋，線上分群成兩位說話者。

前端據此自動判定甲方或乙方、切換翻譯方向與播放語言：

- **聲紋優先**（預設，旁邊的下拉選單可切換）：以聲紋分辨兩個人，雙方說同一種語言也能分；語言只用來確認「某一方第一次出現」（例如第一次聽到乙方的語言就直接登錄他的聲紋）。
- **語言優先**：雙方語言不同且後端語言偵測信心 ≥ 0.8（`DIARIZE_LANG_CONFIDENCE`）時，直接以說話語言決定甲/乙方，並同時登錄聲紋；其餘情況才用聲紋。
- 只認識一位說話者時，聲紋與他相似度 ≥ 門檻（0.5）就是他，否則視為另一方；沒有任何線索時，第一位歸給「當下選定的說話者」。
- 聲紋只取有人聲的片段計算（切掉前後靜音）；每句話的卡片與狀態列會顯示與甲/乙方聲紋的相似度，方便調整 `DIARIZE_THRESHOLD`。
- 聲紋判錯或換了現場的人時，按「重置聲紋」重新開始。
- 後端連不上時會自動退回瀏覽器內建的 Web Speech + 語言偵測，並在狀態列顯示原因。

**為什麼改成這樣**：先前版本同時用 Web Speech 辨識與另開一路錄音做聲紋，手機瀏覽器通常不允許兩者共用麥克風，結果畫面一直停在「聆聽中…」。現在伺服器模式完全不使用 Web Speech，只有一路麥克風，手機（iOS Safari / Android Chrome）可正常使用，也不需要使用者自己的電腦。

### 部署到伺服器（手機使用）

```bash
# 伺服器上（Docker）：同時啟動 proxy（翻譯、Edge TTS）與辨識服務
cp .env.example .env          # 填入翻譯 API Key
docker compose up -d --build  # 首次啟動會下載 Whisper 與聲紋模型（存在 volume，之後不用再下載）
```

- proxy 對外是 `8787` 埠；手機麥克風必須是 **https**，請用 Caddy / Nginx 或 `cloudflared tunnel --url http://localhost:8787` 提供 https 網址，填進 `.env` 的 `PUBLIC_PROXY_BASE_URL`（前端部署在 GitHub Pages 時也一樣）。
- 不想用 Docker：在伺服器上 `pip install -r diarize/requirements.txt` 後 `python diarize/server.py`，再用 `node proxy-server.mjs`；環境變數見 [diarize/server.py](diarize/server.py) 開頭（`DIARIZE_HOST`/`DIARIZE_PORT`、`WHISPER_MODEL`、`WHISPER_COMPUTE`、`DIARIZE_THRESHOLD`…）。
- 效能：`small` 在 2 核心 CPU 上辨識一句話約 2～5 秒；想更快改用 `WHISPER_MODEL=base`，想更準改用 `medium`（需要較多記憶體）。
- 相似度門檻（預設 0.5）可用 `DIARIZE_THRESHOLD` 調整；聲紋模型缺檔時後端會自行下載。
- 目前 proxy 沒有存取驗證，公開到網際網路時請自行在反向代理加上存取限制，以免他人佔用 CPU 與翻譯額度。

## 前端連線設定（.env）

不用寫死 IP：前端要連的網址放在 `.env` 的 `PUBLIC_*` 變數（範例見 [.env.example](.env.example)），建置時寫進 `js/env-config.js`（已加入 .gitignore）：

| 變數 | 說明 |
|---|---|
| `PUBLIC_PROXY_BASE_URL` | 後端 proxy（含語音辨識/聲紋服務、Edge TTS）對外的 **https** 網址，例如 Cloudflare Tunnel 網址 |
| `PUBLIC_DEEPL_RELAY_URL` | DeepL 中繼（Cloudflare Worker）網址 |
| `PUBLIC_USE_PROXY` / `PUBLIC_AUTO_SPEAKER` | 選填 `true`/`false`，預設有後端網址時為 `true` |

- 本機：改完 `.env` 執行 `npm run env:config`，重新整理頁面。
- GitHub Pages：到 repo **Settings → Secrets and variables → Actions → Variables** 設定同名變數，推送後由 workflow 建置時帶入。
- 注意：Cloudflare Worker（`deepl-relay`）只轉發 DeepL，**無法執行 Edge TTS**；需要的話請在自己的主機/伺服器跑 `npm run start:proxy`（或 `docker compose up -d`），再用 `cloudflared tunnel --url http://localhost:8787` 之類的方式取得 https 網址填入 `PUBLIC_PROXY_BASE_URL`（https 頁面不能連 http 後端）。

## 自動容錯

額度用盡（HTTP 429 / 403 / 456）時，依設定順序自動切換（預設 **Azure → Google → DeepL**）。標頭的狀態燈會顯示每家服務為「就緒 / 使用中 / 額度已盡 / 未設定」。

最後一道備援是內建的 **Google 免費翻譯**（`translate.googleapis.com/translate_a/single`，不需 Key）：付費服務額度用盡（會跳出提示）、失敗或完全沒設定 Key 時，自動改用它翻譯與偵測語言。這是非官方公開端點，無額度保證，可能被限流。

## 語音引擎（播放譯文）

畫面上「🔊 語音引擎」下拉選單可隨時切換，選擇會被記住：

| 引擎 | 執行位置 | 支援語言 | 說明 |
|---|---|---|---|
| Web Speech API | 瀏覽器內建 | 全部 | 品質取決於系統語音，會自動挑選較高品質的語音 |
| **Microsoft Edge Read Aloud**（預設） | 經 proxy 後端 | 全部 12 種 | 神經語音，品質最好；需啟動 proxy，不需 API Key |
| Google 翻譯語音 | 直接由瀏覽器載入 `translate.google.com/translate_tts` | 全部 12 種 | 免費、不需 Key 與 proxy，需連網；非官方端點，可能被限流 |
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
js/stt.js       Web Speech 辨識 + 1 秒靜音自動結句
js/tts.js       多引擎 TTS（Web Speech / Google / Edge / Piper / Kokoro）+ 播放佇列 + 自動退回
js/speaker.js   單路麥克風錄音 + 依音量切句（VoiceListener）、呼叫後端辨識（SpeakerServer）
js/app.js       主流程串接
diarize/server.py 後端：faster-whisper 語音轉文字 + wespeaker 聲紋分群（models/wespeaker/ 為聲紋 ONNX，缺檔時自動下載）
docker-compose.yml 一鍵部署後端（proxy + diarize）
proxy-server.mjs 後端 Proxy（/api/translate, /api/detect, /api/test, /api/tts/edge, /api/speaker/*（轉發到 diarize））
```

## 注意事項

- 建議使用 Proxy 模式：把 API Key 放在後端 `.env`，避免前端外露並可避開 CORS。
- Web Speech API 的辨識在 Chrome/Edge/Safari 上可用；**Brave 不支援**（已停用 Google 語音服務）。語音「播放」（TTS）不受此限，任何瀏覽器都能選用上述四種引擎。
- Piper / Kokoro 的程式與模型透過 CDN（esm.sh、jsDelivr、cdnjs、HuggingFace）載入，首次使用需要網路。
- DeepL `:fx` Key 為 Free 方案；系統會自動使用 `api-free.deepl.com`。貼上 Key 時若含引號（例如 `‘...:fx’`）會自動清理。
