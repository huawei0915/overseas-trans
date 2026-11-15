// 主流程：語音辨識 → 靜音 1 秒結句 → 判定甲/乙方 → 容錯翻譯 → TTS 播放 → 對話紀錄
// 語音辨識有兩種模式：
//  · 伺服器模式（勾選「自動辨識甲/乙方」）：只錄一路麥克風，整句音訊交給後端轉文字 + 聲紋分群，手機也能用
//  · 瀏覽器模式：Web Speech API，以語言偵測推斷說話者
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
  const listener = new VoiceListener();
  const speakerServer = new SpeakerServer(() => cfg.proxyBaseUrl);

  const SERVER_LANG_CONFIDENCE = 0.8; // 後端語言偵測信心高於此值時，以語言決定甲/乙方
  let serverMode = false;        // 目前 session 是否由後端辨識（伺服器模式）
  let clusterToParty = {};       // 聲紋群 → 'a' | 'b'
  let serverQueue = Promise.resolve(); // 一句一句依序處理，確保聲紋登錄與翻譯/播放順序

  function setSpeakerStatus(message, isError = false) {
    els.speakerStatus.textContent = message;
    els.speakerStatus.classList.toggle('error', isError);
  }

  els.autoSpeaker.checked = !!cfg.autoSpeaker;
  els.autoSpeaker.addEventListener('change', () => {
    cfg.autoSpeaker = els.autoSpeaker.checked;
    cfg.autoSpeakerChosen = true;
    AppConfig.save(cfg);
    setSpeakerStatus('');
    // 進行中切換辨識模式：停掉目前的再依新設定重新開始
    if (sessionActive) {
      stopSession();
      void startSession();
    }
  });
  els.speakerReset.addEventListener('click', () => {
    clusterToParty = {};
    void speakerServer.reset();
    setSpeakerStatus('已重置聲紋，下一句會重新判定甲/乙方');
  });

  // 第一位被辨識出的說話者歸給語言對應的一方（雙方語言不同時），否則歸給「當下選定的說話者」；第二位歸給另一方
  function partyForCluster(idx, langParty) {
    if (!('0' in clusterToParty)) {
      const first = langParty || currentSpeaker;
      clusterToParty['0'] = first;
      clusterToParty['1'] = first === 'a' ? 'b' : 'a';
    }
    return clusterToParty[String(idx)] || null;
  }

  // 伺服器模式一句話：音訊 → 後端（轉文字 + 聲紋）→ 判定甲/乙方 → 翻譯播放
  async function handleServerUtterance(pcm) {
    els.interim.textContent = '辨識中…';
    let r;
    try {
      r = await speakerServer.transcribe(pcm, { langs: [cfg.langA, cfg.langB], enroll: true });
    } catch (err) {
      setSpeakerStatus(`語音辨識失敗：${err.message}`, true);
      return;
    } finally {
      if (sessionActive) els.interim.textContent = '聆聽中…';
    }
    setSpeakerStatus('');
    const text = String(r.text || '').trim();
    if (!text) return;

    // 雙方語言不同時，辨識出的語言就是最直接的線索（且翻譯方向必須與實際說的語言一致）：
    // 語言信心夠高就以語言為準，並用它校正第一位說話者的歸屬；信心不足才採用聲紋
    const distinctLangs = cfg.langA !== cfg.langB;
    const langParty = distinctLangs && r.language ? partyFromLanguage(r.language) : null;
    const langConfident = !!langParty && (r.language_confidence ?? 1) >= SERVER_LANG_CONFIDENCE;
    const voiceParty = r.speaker != null ? partyForCluster(r.speaker, langConfident ? langParty : null) : null;
    let party;
    let detectedBy = null;
    if (langConfident || (langParty && !voiceParty)) {
      party = langParty;
      detectedBy = 'whisper';
    } else if (voiceParty) {
      party = voiceParty;
      detectedBy = 'voiceprint';
    } else {
      party = currentSpeaker; // 音訊太短、沒有聲紋也無從判斷語言
    }
    if (party !== currentSpeaker) {
      currentSpeaker = party;
      updateMicUI();
    }
    const sourceLangId = party === 'a' ? cfg.langA : cfg.langB;
    await translateAndSpeak(text, party, sourceLangId, detectedBy);
  }

  function enqueueServerUtterance(pcm) {
    serverQueue = serverQueue.then(() => handleServerUtterance(pcm)).catch(() => {});
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
    if (sessionActive && !serverMode && currentSpeaker === 'a') restartRecognition();
  });
  els.langB.addEventListener('change', () => {
    cfg.langB = els.langB.value;
    AppConfig.save(cfg);
    preloadTts();
    if (sessionActive && !serverMode && currentSpeaker === 'b') restartRecognition();
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
    navigator.brave.isBrave().then((v) => { isBrave = !!v; }).catch(() => { });
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
    if (sessionActive) {
      if (serverMode) {
        if (speaking) listener.pause();
        else listener.resume();
        els.interim.textContent = speaking ? '' : '聆聽中…';
      } else if (speaking) stt.pause();
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
    p.textContent = '尚無對話。按下「開始對話」後即可持續說話，停頓 1 秒會自動翻譯並播放，直到按下「停止對話」為止。';
    els.transcript.appendChild(p);
  }

  function addUtteranceCard(party, original, sourceLangId, detectedBy = null) {
    clearTranscriptPlaceholder();
    const lang = findLanguage(sourceLangId);
    const card = document.createElement('div');
    card.className = `msg from-${party}`;
    const time = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const detectedName = detectedBy && PROVIDERS[detectedBy] ? PROVIDERS[detectedBy].name : detectedBy;
    const detectedTag = detectedBy === 'voiceprint' ? ' · 聲紋辨識' : detectedBy === 'whisper' ? ' · 語音語言辨識' : detectedName ? ` · 自動偵測(${detectedName})` : '';
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

  async function handleUtterance(text) {
    let party = currentSpeaker;
    let sourceLangId = party === 'a' ? cfg.langA : cfg.langB;
    let detectedBy = null;

    const detected = await translator.detectLanguage(text, cfg);
    if (detected?.langId) {
      sourceLangId = detected.langId;
      detectedBy = detected.provider;
      const inferredParty = partyFromLanguage(detected.langId);
      if (inferredParty !== currentSpeaker) {
        currentSpeaker = inferredParty;
        updateMicUI();
        if (sessionActive && !serverMode && !stt.paused) {
          restartRecognition();
        }
      }
      party = inferredParty;
    }

    await translateAndSpeak(text, party, sourceLangId, detectedBy);
  }

  async function translateAndSpeak(text, party, sourceLangId, detectedBy) {
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
      onUtterance: (text) => {
        // 結句後繼續聆聽，不需再按任何按鈕
        els.interim.textContent = '聆聽中…';
        handleUtterance(text);
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

  let starting = false;
  let startToken = 0; // 啟動中再按一次按鈕可取消（例如伺服器模型還在載入）

  // 伺服器模式：先開一路麥克風（在點擊手勢內取得權限），再等後端模型就緒。回傳 false 表示無法使用伺服器，改走瀏覽器模式
  async function startServerSession(token) {
    let ready = false;
    els.interim.textContent = '啟動麥克風…';
    try {
      await listener.start({
        onSpeechStart: () => { if (ready) els.interim.textContent = '說話中…'; },
        onDiscard: () => { if (ready) els.interim.textContent = '聆聽中…'; },
        onUtterance: (pcm) => { if (ready) enqueueServerUtterance(pcm); },
      });
    } catch (err) {
      listener.stop(false);
      els.interim.textContent = '';
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      setMicWarning(denied
        ? '麥克風權限被拒絕。請在瀏覽器網址列/網站設定允許麥克風後重試。'
        : `無法啟動麥克風：${err?.message || err?.name || '未知錯誤'}`);
      return true;
    }
    if (token !== startToken) return true;

    setSpeakerStatus('連線辨識伺服器…');
    els.interim.textContent = '連線辨識伺服器…';
    try {
      await speakerServer.waitReady((msg) => {
        if (token !== startToken) return;
        setSpeakerStatus(msg);
        els.interim.textContent = msg;
      }, () => token !== startToken);
    } catch (err) {
      if (token !== startToken) return true;
      listener.stop(false);
      els.interim.textContent = '';
      if (!stt.supported) {
        setSpeakerStatus(`辨識伺服器無法使用（${err.message}）`, true);
        setMicWarning('辨識伺服器無法使用，且此瀏覽器不支援內建語音辨識。請確認後端已啟動並在設定填入正確的 Proxy 網址。');
        return true;
      }
      setSpeakerStatus(`辨識伺服器無法使用（${err.message}），已改用瀏覽器語音辨識`, true);
      return false;
    }
    if (token !== startToken) return true;
    ready = true;
    setMicWarning('');
    setSpeakerStatus('');
    serverMode = true;
    sessionActive = true;
    updateMicUI();
    els.interim.textContent = '聆聽中…';
    return true;
  }

  async function startSession() {
    serverMode = false;
    const token = ++startToken;
    if (cfg.autoSpeaker) {
      listener.prepare(); // 需在點擊手勢內同步建立（iOS Safari）
      starting = true;
      try {
        if (await startServerSession(token)) return;
      } finally {
        if (token === startToken) starting = false;
      }
    }
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
    startRecognition();
  }

  function stopSession() {
    sessionActive = false;
    if (serverMode) listener.stop(); // 會把說到一半的那一句送去辨識
    serverMode = false;
    stt.stop(); // 會先把累積到一半的那一句翻譯完
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
    if (sessionActive && !serverMode) {
      stt.stop(); // 先把上一位說到一半的句子翻譯完
      currentSpeaker = party;
      startRecognition();
    } else {
      currentSpeaker = party;
    }
    updateMicUI();
  }

  els.micMaster.addEventListener('click', () => {
    if (starting) {
      startToken++;
      starting = false;
      listener.stop(false);
      setSpeakerStatus('');
      els.interim.textContent = '';
    } else if (sessionActive) stopSession();
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
    els.cfgProxyUrl.value = cfg.proxyBaseUrl || DEFAULT_CONFIG.proxyBaseUrl;
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
    cfg.proxyBaseUrl = sanitizeProxyUrl(els.cfgProxyUrl.value) || DEFAULT_CONFIG.proxyBaseUrl;

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
