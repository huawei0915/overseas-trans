// 主流程：STT → 靜音 2 秒 → 聲紋辨識甲/乙方（pyannote）→ 容錯翻譯 → TTS 播放 → 對話紀錄
(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    browserWarning: $('browser-warning'),
    micWarning: $('mic-warning'),
    langA: $('lang-a'),
    langB: $('lang-b'),
    micMaster: $('mic-master'),
    partyA: $('party-a'),
    partyB: $('party-b'),
    interim: $('interim'),
    speakerIndicator: $('speaker-indicator'),
    transcript: $('transcript'),
    clearTranscript: $('clear-transcript'),
    manualText: $('manual-text'),
    manualSend: $('manual-send'),
    ttsIndicator: $('tts-indicator'),
    ttsEngine: $('tts-engine'),
    ttsStatus: $('tts-status'),
    autoSpeaker: $('auto-speaker'),
    speakerReset: $('speaker-reset'),
    speakerStatus: $('speaker-status'),
    providerStatus: $('provider-status'),
    settingsModal: $('settings-modal'),
    providerOrder: $('provider-order'),
    cfgAzureKey: $('cfg-azure-key'),
    cfgAzureRegion: $('cfg-azure-region'),
    cfgGoogleKey: $('cfg-google-key'),
    cfgDeeplKey: $('cfg-deepl-key'),
    cfgDeeplPlan: $('cfg-deepl-plan'),
    cfgDeeplRelay: $('cfg-deepl-relay'),
    cfgUseProxy: $('cfg-use-proxy'),
    cfgProxyUrl: $('cfg-proxy-url'),
  };

  let cfg = AppConfig.load();
  const stt = new SpeechEngine();
  const tts = new TTSPlayer(() => cfg);
  const translator = new Translator();
  const recorder = new SpeakerRecorder();
  const identifier = new SpeakerIdentifier(() => (cfg.proxyBaseUrl || 'http://localhost:8787').replace(/\/+$/, ''));

  const SPEAKER_PAD_MS = 1200;   // 辨識結果比實際開口晚出現，往前多取一點音訊
  const SPEAKER_PROBE_MS = 1800; // 開口後多久做一次即時說話者偵測
  let clusterToParty = {};       // pyannote 聲紋群 → 'a' | 'b'
  let audioStartMs = 0;          // 本句音訊起點（說話者切換重啟辨識時保留）
  let probeTimer = null;

  function setSpeakerStatus(message, isError = false) {
    els.speakerStatus.textContent = message;
    els.speakerStatus.classList.toggle('error', isError);
  }

  async function checkSpeakerService() {
    if (!cfg.autoSpeaker) {
      setSpeakerStatus('');
      return false;
    }
    // 後端剛啟動或網路瞬斷時第一次請求可能失敗，重試一次再判定不可用
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await identifier.health();
        setSpeakerStatus('聲紋服務就緒');
        return true;
      } catch (err) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        const hint = err instanceof TypeError
          ? '連不到後端 proxy，請確認已執行 npm run start:proxy 與 npm run start:diarize，且「後端 proxy 網址」正確'
          : err.message;
        setSpeakerStatus(`聲紋服務無法使用（${hint}），已改用語言偵測`, true);
      }
    }
    return false;
  }

  els.autoSpeaker.checked = !!cfg.autoSpeaker;
  els.autoSpeaker.addEventListener('change', () => {
    cfg.autoSpeaker = els.autoSpeaker.checked;
    AppConfig.save(cfg);
    if (sessionActive) {
      if (cfg.autoSpeaker) void startSpeakerRecorder();
      else recorder.stop();
    }
    void checkSpeakerService();
  });
  els.speakerReset.addEventListener('click', () => {
    identifier.reset();
    clusterToParty = {};
    audioStartMs = 0;
    setSpeakerStatus('已重置聲紋，下一句會重新判定甲/乙方');
  });

  async function startSpeakerRecorder() {
    try {
      await recorder.start();
    } catch {
      setSpeakerStatus('無法錄音進行聲紋辨識，已改用語言偵測', true);
    }
  }

  // 第一位被辨識出的說話者歸給「當下選定的說話者」，第二位歸給另一方
  function partyForCluster(idx, allowAssign) {
    if (!('0' in clusterToParty)) {
      if (!allowAssign) return null;
      clusterToParty['0'] = currentSpeaker;
      clusterToParty['1'] = currentSpeaker === 'a' ? 'b' : 'a';
    }
    return clusterToParty[String(idx)] || null;
  }

  async function identifyByVoice(startMs, endMs, enroll) {
    if (!cfg.autoSpeaker || !recorder.running || !startMs) return null;
    const wav = recorder.sliceWav(startMs - SPEAKER_PAD_MS, endMs + 300);
    if (!wav) return null;
    try {
      const r = await identifier.identify(wav, enroll);
      setSpeakerStatus('聲紋服務就緒');
      if (r.speaker != null) return partyForCluster(r.speaker, enroll);
      // 即時偵測時與已登錄的聲紋都不像 → 判定為另一方開口
      if (!enroll && r.similarities?.length && '0' in clusterToParty) {
        return clusterToParty['0'] === 'a' ? 'b' : 'a';
      }
      return null;
    } catch (err) {
      setSpeakerStatus(`聲紋辨識失敗（${err.message}），已改用語言偵測`, true);
      return null;
    }
  }

  function switchSpeaker(party) {
    currentSpeaker = party;
    updateMicUI();
    if (sessionActive && !stt.paused) restartRecognition();
  }

  // 說話途中先偵測是誰，若換人了就立刻改用對方語言重新辨識（否則整句會用錯語言辨識）
  function scheduleSpeakerProbe(startMs) {
    clearTimeout(probeTimer);
    if (!cfg.autoSpeaker || !recorder.running || !('0' in clusterToParty)) return;
    probeTimer = setTimeout(async () => {
      const party = await identifyByVoice(audioStartMs || startMs, Date.now(), false);
      if (!party || party === currentSpeaker || !sessionActive || stt.startMs !== startMs) return;
      stt.discardPending();
      switchSpeaker(party);
    }, SPEAKER_PROBE_MS);
  }

  // ---------- 語音引擎選單 ----------

  tts.onStatus = (message) => {
    els.ttsStatus.textContent = message;
  };

  els.ttsEngine.innerHTML = '';
  for (const opt of TTS_ENGINE_OPTIONS) {
    const o = document.createElement('option');
    o.value = opt.id;
    o.textContent = opt.label;
    els.ttsEngine.appendChild(o);
  }
  if (!TTS_ENGINE_OPTIONS.some((o) => o.id === cfg.ttsEngine)) cfg.ttsEngine = DEFAULT_TTS_ENGINE;
  els.ttsEngine.value = cfg.ttsEngine;

  // Piper / Kokoro 需先下載模型：換引擎或語言時預先準備，避免第一句才等待
  function preloadTts() {
    void tts.preload([cfg.langA, cfg.langB]);
  }

  els.ttsEngine.addEventListener('change', () => {
    tts.stopAll();
    cfg.ttsEngine = els.ttsEngine.value;
    AppConfig.save(cfg);
    els.ttsStatus.textContent = '';
    preloadTts();
  });
  preloadTts();

  // ---------- 語言選單 ----------

  function fillLanguageSelect(select, selected) {
    select.innerHTML = '';
    for (const lang of LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.id;
      opt.textContent = lang.label;
      select.appendChild(opt);
    }
    select.value = selected;
  }

  fillLanguageSelect(els.langA, cfg.langA);
  fillLanguageSelect(els.langB, cfg.langB);

  els.langA.addEventListener('change', () => {
    cfg.langA = els.langA.value;
    AppConfig.save(cfg);
    preloadTts();
    if (sessionActive && currentSpeaker === 'a') restartRecognition();
  });
  els.langB.addEventListener('change', () => {
    cfg.langB = els.langB.value;
    AppConfig.save(cfg);
    preloadTts();
    if (sessionActive && currentSpeaker === 'b') restartRecognition();
  });

  // ---------- Provider 狀態燈 ----------

  function renderProviderStatus() {
    els.providerStatus.innerHTML = '';
    for (const s of translator.statusList(cfg)) {
      const chip = document.createElement('span');
      const classes = ['provider-chip'];
      if (s.exhausted) classes.push('exhausted');
      else if (s.configured) classes.push('ok');
      if (s.active && !s.exhausted) classes.push('active');
      chip.className = classes.join(' ');
      const stateText = s.exhausted ? '額度已盡' : s.configured ? (s.active ? '使用中' : '就緒') : '未設定';
      chip.innerHTML = `<span class="dot"></span>${s.name} · ${stateText}`;
      els.providerStatus.appendChild(chip);
    }
  }
  translator.onStatusChange = renderProviderStatus;

  let toastTimer = null;
  translator.onNotice = (message) => {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 8000);
  };
  renderProviderStatus();

  // ---------- 瀏覽器支援檢查 ----------

  if (!stt.supported) els.browserWarning.classList.remove('hidden');
  const isElectronHost = /Electron|Code-Insiders|Code\//i.test(navigator.userAgent);
  let isBrave = false;
  if (navigator.brave?.isBrave) {
    navigator.brave.isBrave().then((v) => { isBrave = !!v; }).catch(() => {});
  }

  function setMicWarning(message = '') {
    const el = els.micWarning;
    if (!message) {
      el.classList.add('hidden');
      return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
  }

  // ---------- TTS 播放狀態 ----------

  tts.onStateChange = (speaking) => {
    els.ttsIndicator.classList.toggle('hidden', !speaking);
    // 播放譯文時暫停辨識，避免麥克風把喇叭聲音又辨識回去造成迴圈
    recorder.clear();
    audioStartMs = 0;
    clearTimeout(probeTimer);
    if (sessionActive) {
      if (speaking) stt.pause();
      else stt.resume();
    }
  };

  // ---------- 對話紀錄 ----------

  function clearTranscriptPlaceholder() {
    const placeholder = els.transcript.querySelector('.transcript-empty');
    if (placeholder) placeholder.remove();
  }

  function resetTranscript() {
    els.transcript.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'transcript-empty';
    p.textContent = '尚無對話。按下「開始對話」後即可持續說話，停頓 2 秒會自動翻譯並播放，直到按下「停止對話」為止。';
    els.transcript.appendChild(p);
  }

  function addUtteranceCard(party, original, sourceLangId, detectedBy = null) {
    clearTranscriptPlaceholder();
    const lang = findLanguage(sourceLangId);
    const card = document.createElement('div');
    card.className = `msg from-${party}`;
    const time = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const detectedName = detectedBy && PROVIDERS[detectedBy] ? PROVIDERS[detectedBy].name : detectedBy;
    const detectedTag = detectedBy === 'pyannote' ? ' · 聲紋辨識' : detectedName ? ` · 自動偵測(${detectedName})` : '';
    card.innerHTML = `
      <div class="msg-meta">${party === 'a' ? '甲方' : '乙方'} · ${lang ? lang.label : sourceLangId}${detectedTag} · ${time}</div>
      <div class="msg-original"></div>
      <div class="msg-translation pending">翻譯中…</div>
    `;
    card.querySelector('.msg-original').textContent = original;
    els.transcript.appendChild(card);
    els.transcript.scrollTop = els.transcript.scrollHeight;
    return card;
  }

  function setCardTranslation(card, text, providerId, targetLangId = null) {
    const slot = card.querySelector('.msg-translation');
    slot.classList.remove('pending');
    slot.textContent = '';

    const textEl = document.createElement('span');
    textEl.className = 'translation-text';
    textEl.textContent = text;
    slot.appendChild(textEl);

    if (providerId) {
      const tag = document.createElement('span');
      tag.className = 'provider-tag';
      tag.textContent = `via ${PROVIDERS[providerId]?.name || providerId}`;
      slot.appendChild(tag);
    }

    if (targetLangId) {
      const replayBtn = document.createElement('button');
      replayBtn.type = 'button';
      replayBtn.className = 'replay-btn';
      replayBtn.title = '重複播放譯文';
      replayBtn.setAttribute('aria-label', '重複播放譯文');
      replayBtn.textContent = '🔊';
      replayBtn.addEventListener('click', () => {
        tts.stopAll();
        tts.speak(text, targetLangId);
      });
      slot.appendChild(replayBtn);
    }
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }

  function setCardError(card, message) {
    const slot = card.querySelector('.msg-translation');
    slot.classList.remove('pending');
    slot.classList.add('error');
    slot.textContent = `翻譯失敗：${message}`;
  }

  // ---------- 核心流程：一句話完成 → 翻譯 → 播放 ----------

  function partyFromLanguage(langId) {
    if (langId === cfg.langA && langId !== cfg.langB) return 'a';
    if (langId === cfg.langB && langId !== cfg.langA) return 'b';
    return currentSpeaker;
  }

  async function handleUtterance(text, meta = null) {
    let party = currentSpeaker;
    let sourceLangId = party === 'a' ? cfg.langA : cfg.langB;
    let detectedBy = null;

    const startMs = meta?.startMs ? Math.min(meta.startMs, audioStartMs || meta.startMs) : 0;
    audioStartMs = 0;
    const voiceParty = meta ? await identifyByVoice(startMs, meta.endMs, true) : null;

    if (voiceParty) {
      party = voiceParty;
      sourceLangId = party === 'a' ? cfg.langA : cfg.langB;
      detectedBy = 'pyannote';
      if (party !== currentSpeaker) switchSpeaker(party);
    }

    const detected = voiceParty ? null : await translator.detectLanguage(text, cfg);
    if (detected?.langId) {
      sourceLangId = detected.langId;
      detectedBy = detected.provider;
      const inferredParty = partyFromLanguage(detected.langId);
      if (inferredParty !== currentSpeaker) {
        currentSpeaker = inferredParty;
        updateMicUI();
        if (sessionActive && !stt.paused) {
          restartRecognition();
        }
      }
      party = inferredParty;
    }

    const targetLangId = party === 'a' ? cfg.langB : cfg.langA;
    const card = addUtteranceCard(party, text, sourceLangId, detectedBy);

    // 雙方語言相同：不需翻譯也不播放
    if (sourceLangId === targetLangId) {
      setCardTranslation(card, '（雙方語言相同，無需翻譯）', null);
      return;
    }

    try {
      const { text: translated, provider } = await translator.translate(text, sourceLangId, targetLangId, cfg);
      setCardTranslation(card, translated, provider, targetLangId);
      tts.speak(translated, targetLangId);
    } catch (err) {
      setCardError(card, err.message);
      renderProviderStatus();
    }
  }

  // ---------- 麥克風控制（單一總開關）----------

  let sessionActive = false;   // 對話 session 是否進行中
  let currentSpeaker = 'a';    // 目前說話者：'a' | 'b'

  function speakerLangId() {
    return currentSpeaker === 'a' ? cfg.langA : cfg.langB;
  }

  function updateMicUI() {
    els.micMaster.classList.toggle('listening', sessionActive);
    els.micMaster.querySelector('.mic-icon').textContent = sessionActive ? '⏹' : '🎤';
    els.micMaster.querySelector('.mic-label').textContent = sessionActive ? '停止對話（持續聆聽中…）' : '開始對話';
    els.partyA.classList.toggle('speaker-active', currentSpeaker === 'a');
    els.partyB.classList.toggle('speaker-active', currentSpeaker === 'b');
    const lang = findLanguage(speakerLangId());
    els.speakerIndicator.textContent = `目前說話者：${currentSpeaker === 'a' ? '甲方' : '乙方'}（${lang ? lang.label : speakerLangId()}）`;
  }

  function startRecognition() {
    const langId = speakerLangId();
    const lang = findLanguage(langId);
    els.interim.textContent = '聆聽中…';
    stt.start(lang ? lang.stt : langId, {
      onInterim: (text) => {
        els.interim.textContent = text || '聆聽中…';
      },
      onSpeechStart: (startMs) => {
        if (!audioStartMs) audioStartMs = startMs;
        scheduleSpeakerProbe(startMs);
      },
      onUtterance: (text, meta) => {
        // 結句後繼續聆聽，不需再按任何按鈕
        clearTimeout(probeTimer);
        els.interim.textContent = '聆聽中…';
        handleUtterance(text, meta);
      },
      onError: (code) => {
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          setMicWarning('麥克風權限被拒絕。請點網址列左側圖示允許麥克風後重試。');
          sessionActive = false;
          updateMicUI();
          return;
        }
        if (code === 'audio-capture') {
          setMicWarning('找不到可用麥克風輸入裝置。請檢查裝置是否連接與系統音訊設定。');
          sessionActive = false;
          updateMicUI();
          return;
        }
        if (code === 'network') {
          if (isBrave) {
            setMicWarning('Brave 瀏覽器已停用語音辨識所需的 Google 服務，無法使用 Web Speech（一定會出現 network 錯誤）。請改用 Chrome 或 Safari 開啟 http://localhost:8000。');
          } else if (isElectronHost) {
            setMicWarning('目前在 VS Code 內建瀏覽器（Electron）執行，Web Speech 常會回傳 network 錯誤。請改用 Chrome/Edge 直接開啟 http://localhost:8000 測試 STT。');
          } else {
            setMicWarning('語音辨識服務連線異常，請檢查網路、VPN/防火牆後重試。');
          }
          return;
        }
        if (code === 'no-speech') {
          setMicWarning('目前未偵測到語音，請靠近麥克風再試。');
          return;
        }
        if (code) {
          setMicWarning(`語音辨識發生問題：${code}`);
          sessionActive = false;
          updateMicUI();
        }
      },
      // 刻意不處理 onStateChange：停止/重啟皆由本層控制，
      // 避免 stop() 觸發的回呼在切換說話者時誤關 session
    });
  }

  function restartRecognition() {
    stt.stop();
    startRecognition();
  }

  async function ensureMicrophoneReady() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  }

  async function startSession() {
    if (!stt.supported) {
      els.browserWarning.classList.remove('hidden');
      return;
    }
    try {
      await ensureMicrophoneReady();
      setMicWarning('');
    } catch {
      setMicWarning('無法取得麥克風。請確認已允許此網站使用麥克風，且系統有可用的輸入裝置。');
      return;
    }
    sessionActive = true;
    updateMicUI();
    if (cfg.autoSpeaker && (await checkSpeakerService())) await startSpeakerRecorder();
    startRecognition();
  }

  function stopSession() {
    sessionActive = false;
    clearTimeout(probeTimer);
    stt.stop(); // 會先把累積到一半的那一句翻譯完（需在關閉錄音前，才取得得到音訊）
    setTimeout(() => { if (!sessionActive) recorder.stop(); }, 3000);
    tts.stopAll();
    els.interim.textContent = '';
    updateMicUI();
  }

  function submitManualText() {
    const text = (els.manualText?.value || '').trim();
    if (!text) return;
    handleUtterance(text);
    els.manualText.value = '';
    els.manualText.focus();
  }

  function selectSpeaker(party) {
    if (party === currentSpeaker) return;
    if (sessionActive) {
      stt.stop(); // 先把上一位說到一半的句子翻譯完
      currentSpeaker = party;
      startRecognition();
    } else {
      currentSpeaker = party;
    }
    updateMicUI();
  }

  els.micMaster.addEventListener('click', () => {
    if (sessionActive) stopSession();
    else void startSession();
  });

  els.manualSend?.addEventListener('click', submitManualText);
  els.manualText?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitManualText();
    }
  });
  els.clearTranscript?.addEventListener('click', resetTranscript);

  for (const [cardEl, party] of [[els.partyA, 'a'], [els.partyB, 'b']]) {
    cardEl.addEventListener('click', () => selectSpeaker(party));
    cardEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectSpeaker(party);
      }
    });
    // 點語言下拉選單不觸發說話者切換
    cardEl.querySelector('select').addEventListener('click', (e) => e.stopPropagation());
  }

  updateMicUI();

  // ---------- 設定面板 ----------

  function openSettings() {
    els.cfgAzureKey.value = cfg.azureKey;
    els.cfgAzureRegion.value = cfg.azureRegion;
    els.cfgGoogleKey.value = cfg.googleKey;
    els.cfgDeeplKey.value = cfg.deeplKey;
    els.cfgDeeplPlan.value = cfg.deeplPlan;
    els.cfgDeeplRelay.value = cfg.deeplRelayUrl || '';
    els.cfgUseProxy.checked = !!cfg.useProxy;
    els.cfgProxyUrl.value = cfg.proxyBaseUrl || 'http://localhost:8787';
    renderProviderOrder();
    els.settingsModal.classList.remove('hidden');
  }

  function closeSettings() {
    els.settingsModal.classList.add('hidden');
  }

  function sanitizeApiKey(value) {
    // 移除前後空白、智慧引號/一般引號，以及常見零寬字元
    return String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .replace(/^['"`‘’“”]+|['"`‘’“”]+$/g, '')
      .trim();
  }

  function sanitizeProxyUrl(value) {
    return String(value || '')
      .trim()
      .replace(/\/+$/, '');
  }

  function readSettingsForm() {
    cfg.azureKey = sanitizeApiKey(els.cfgAzureKey.value);
    cfg.azureRegion = els.cfgAzureRegion.value.trim() || 'southeastasia';
    cfg.googleKey = sanitizeApiKey(els.cfgGoogleKey.value);
    cfg.deeplKey = sanitizeApiKey(els.cfgDeeplKey.value);
    cfg.deeplPlan = els.cfgDeeplPlan.value;
    cfg.deeplRelayUrl = sanitizeProxyUrl(els.cfgDeeplRelay.value);
    cfg.useProxy = !!els.cfgUseProxy.checked;
    cfg.proxyBaseUrl = sanitizeProxyUrl(els.cfgProxyUrl.value) || 'http://localhost:8787';

    // DeepL Free key（:fx）一律走 free endpoint，避免選到 pro 造成 403
    if (cfg.deeplKey.toLowerCase().endsWith(':fx')) {
      cfg.deeplPlan = 'free';
      els.cfgDeeplPlan.value = 'free';
    }
  }

  // 設定面板中的優先順序列表（含上移/下移）
  function renderProviderOrder() {
    els.providerOrder.innerHTML = '';
    cfg.providerOrder.forEach((pid, idx) => {
      const provider = PROVIDERS[pid];
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      const configured = cfg.useProxy ? true : provider.isConfigured(cfg);
      nameSpan.innerHTML = `${idx + 1}. ${provider.name} <span class="configured-tag ${configured ? 'yes' : ''}">${configured ? '已設定' : '未設定 Key'}</span>`;

      const btns = document.createElement('span');
      btns.className = 'order-btns';
      const up = document.createElement('button');
      up.type = 'button';
      up.textContent = '↑';
      up.disabled = idx === 0;
      up.addEventListener('click', () => moveProvider(idx, -1));
      const down = document.createElement('button');
      down.type = 'button';
      down.textContent = '↓';
      down.disabled = idx === cfg.providerOrder.length - 1;
      down.addEventListener('click', () => moveProvider(idx, 1));
      btns.appendChild(up);
      btns.appendChild(down);

      li.appendChild(nameSpan);
      li.appendChild(btns);
      els.providerOrder.appendChild(li);
    });
  }

  function moveProvider(idx, delta) {
    readSettingsForm();
    const order = cfg.providerOrder;
    const [item] = order.splice(idx, 1);
    order.splice(idx + delta, 0, item);
    renderProviderOrder();
  }

  // 測試連線按鈕
  document.querySelectorAll('[data-test]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pid = btn.dataset.test;
      const resultEl = $(`test-${pid}`);
      readSettingsForm();
      resultEl.className = 'test-result';
      resultEl.textContent = '測試中…';
      try {
        const translated = await translator.testProvider(pid, cfg);
        resultEl.classList.add('ok');
        resultEl.textContent = `成功：「Hello」→「${translated}」`;
        translator.exhausted.delete(pid); // 測試成功就解除耗盡標記
      } catch (err) {
        resultEl.classList.add('fail');
        resultEl.textContent = `失敗：${err.message}`;
      }
      renderProviderStatus();
    });
  });

  $('btn-settings').addEventListener('click', openSettings);
  $('btn-close-settings').addEventListener('click', closeSettings);
  els.settingsModal.addEventListener('click', (e) => {
    if (e.target === els.settingsModal) closeSettings();
  });
  $('btn-save-settings').addEventListener('click', () => {
    readSettingsForm();
    AppConfig.save(cfg);
    renderProviderStatus();
    closeSettings();
  });

})();
