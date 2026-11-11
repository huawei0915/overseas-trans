// 多引擎文字轉語音（TTS）：Web Speech / Microsoft Edge Read Aloud / Piper Plus / Piper / Kokoro
// 各引擎統一介面：supports(langId)、speak(text, langId, ctx)、preload?(langIds, ctx)
// ctx 提供：cancelled()、cached(key, producer)、playBlob(blob)、status(msg)
// 引擎不支援該語言或播放失敗時，自動退回 Web Speech 並在狀態列提示。

const TTS_ENGINE_OPTIONS = [
  { id: 'webspeech', label: 'Web Speech API（瀏覽器內建）' },
  { id: 'edge', label: 'Microsoft Edge Read Aloud（推薦・需啟動 proxy）' },
  { id: 'piperplus', label: 'Piper Plus（本機離線・日韓中英西法葡）' },
  { id: 'piper', label: 'Piper TTS（本機離線・中英西法德葡越）' },
  { id: 'kokoro', label: 'Kokoro TTS（本機離線・僅英文）' },
];
const DEFAULT_TTS_ENGINE = 'edge';

const EDGE_VOICES = {
  'zh-TW': 'zh-TW-HsiaoChenNeural',
  'zh-CN': 'zh-CN-XiaoxiaoNeural',
  en: 'en-US-AriaNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
  es: 'es-ES-ElviraNeural',
  fr: 'fr-FR-DeniseNeural',
  de: 'de-DE-KatjaNeural',
  pt: 'pt-PT-RaquelNeural',
  id: 'id-ID-GadisNeural',
  vi: 'vi-VN-HoaiMyNeural',
  th: 'th-TH-PremwadeeNeural',
};

// Piper 沒有日/韓/泰/印尼語；繁體中文沿用普通話語音（zh_CN）
const PIPER_VOICES = {
  'zh-TW': 'zh_CN-huayan-medium',
  'zh-CN': 'zh_CN-huayan-medium',
  en: 'en_US-hfc_female-medium',
  es: 'es_ES-davefx-medium',
  fr: 'fr_FR-siwis-medium',
  de: 'de_DE-thorsten-medium',
  pt: 'pt_BR-faber-medium',
  vi: 'vi_VN-vais1000-medium',
};

// kokoro-js 目前只內建英文語音
const KOKORO_VOICES = { en: 'af_heart' };
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// onnxruntime-web 必須釘在 1.18.0：Piper 套件固定從 cdnjs 載入該版本的 WASM，
// 若 esm.sh 解析成較新版本，JS 與 WASM 版本不符會載入失敗
const PIPER_MODULE_URL = 'https://esm.sh/@mintplex-labs/piper-tts-web@1.0.5?deps=onnxruntime-web@1.18.0';
// 必須載入專為瀏覽器打包的 kokoro.web.js；esm.sh 會給 Node 版（使用 fs.readFile）而無法執行
const KOKORO_MODULE_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

const AUDIO_CACHE_LIMIT = 50;

let piperModulePromise = null;
function loadPiper() {
  piperModulePromise ??= import(PIPER_MODULE_URL).catch((err) => {
    piperModulePromise = null;
    throw err;
  });
  return piperModulePromise;
}

const piperDownloads = new Map(); // voiceId -> Promise
async function ensurePiperVoice(voiceId, ctx) {
  const piper = await loadPiper();
  if (!piperDownloads.has(voiceId)) {
    const task = (async () => {
      let stored = [];
      try { stored = await piper.stored(); } catch { /* OPFS 不可用時直接讓 predict 自行處理 */ }
      if (stored.includes(voiceId)) return;
      await piper.download(voiceId, (p) => {
        if (p?.total) ctx.status(`Piper：下載語音模型 ${Math.round((p.loaded * 100) / p.total)}%`);
      });
    })().catch((err) => {
      piperDownloads.delete(voiceId);
      throw err;
    });
    piperDownloads.set(voiceId, task);
  }
  await piperDownloads.get(voiceId);
  return piper;
}

let kokoroPromise = null;
function loadKokoro(ctx) {
  kokoroPromise ??= (async () => {
    const { KokoroTTS } = await import(KOKORO_MODULE_URL);
    return KokoroTTS.from_pretrained(KOKORO_MODEL, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p?.status === 'progress' && typeof p.progress === 'number') {
          ctx.status(`Kokoro：下載模型 ${Math.round(p.progress)}%`);
        }
      },
    });
  })().catch((err) => {
    kokoroPromise = null;
    throw err;
  });
  return kokoroPromise;
}

function normalizeLocale(s) {
  return String(s || '').replace('_', '-').toLowerCase();
}

// 在系統語音中挑最適合的：同語系優先，偏好 Premium / Enhanced / Neural 等高品質語音
function pickBestWebSpeechVoice(locale) {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const target = normalizeLocale(locale);
  const prefix = target.split('-')[0];
  let best = null;
  let bestScore = -Infinity;
  for (const v of voices) {
    const lang = normalizeLocale(v.lang);
    if (!lang.startsWith(prefix)) continue;
    let score = lang === target ? 100 : 0;
    if (/premium|enhanced|natural|neural|google/i.test(v.name)) score += 30;
    if (/compact/i.test(v.name)) score -= 20;
    if (v.default) score += 1;
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

const TTS_ENGINES = {
  webspeech: {
    id: 'webspeech',
    name: 'Web Speech',
    supports: () => 'speechSynthesis' in window,
    speak(text, langId, ctx) {
      return new Promise((resolve) => {
        const lang = findLanguage(langId);
        const locale = lang ? lang.tts : langId;
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = locale;
        const voice = pickBestWebSpeechVoice(locale);
        if (voice) utterance.voice = voice;
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        if (ctx.cancelled()) return resolve();
        speechSynthesis.speak(utterance);
      });
    },
  },

  edge: {
    id: 'edge',
    name: 'Edge Read Aloud',
    supports: (langId) => !!EDGE_VOICES[langId],
    async speak(text, langId, ctx) {
      const voice = EDGE_VOICES[langId];
      const base = String(ctx.config.proxyBaseUrl || 'http://localhost:8787').replace(/\/+$/, '');
      const blob = await ctx.cached(`edge|${voice}|${text}`, async () => {
        const res = await fetch(`${base}/api/tts/edge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || `Proxy 回應 ${res.status}`);
        }
        return res.blob();
      });
      await ctx.playBlob(blob);
    },
  },

  piper: {
    id: 'piper',
    name: 'Piper',
    supports: (langId) => !!PIPER_VOICES[langId],
    async preload(langIds, ctx) {
      for (const voiceId of new Set(langIds.map((l) => PIPER_VOICES[l]).filter(Boolean))) {
        ctx.status('Piper：載入引擎…');
        await ensurePiperVoice(voiceId, ctx);
      }
    },
    async speak(text, langId, ctx) {
      const voiceId = PIPER_VOICES[langId];
      const blob = await ctx.cached(`piper|${voiceId}|${text}`, async () => {
        ctx.status('Piper：載入引擎…');
        const piper = await ensurePiperVoice(voiceId, ctx);
        ctx.status('Piper：合成語音中…');
        return piper.predict({ text, voiceId });
      });
      await ctx.playBlob(blob);
    },
  },

  piperplus: {
    id: 'piperplus',
    name: 'Piper Plus',
    supports: isPiperPlusLang,
    preload: piperPlusPreload,
    async speak(text, langId, ctx) {
      const blob = await ctx.cached(`piperplus|${langId}|${text}`, () => piperPlusSynthesize(text, langId, ctx));
      await ctx.playBlob(blob);
    },
  },

  kokoro: {
    id: 'kokoro',
    name: 'Kokoro',
    supports: (langId) => !!KOKORO_VOICES[langId],
    async preload(langIds, ctx) {
      if (!langIds.some((l) => KOKORO_VOICES[l])) return;
      ctx.status('Kokoro：載入模型…');
      await loadKokoro(ctx);
    },
    async speak(text, langId, ctx) {
      const voice = KOKORO_VOICES[langId];
      const blob = await ctx.cached(`kokoro|${voice}|${text}`, async () => {
        ctx.status('Kokoro：載入模型…');
        const kokoro = await loadKokoro(ctx);
        ctx.status('Kokoro：合成語音中…');
        const audio = await kokoro.generate(text, { voice });
        return audio.toBlob();
      });
      await ctx.playBlob(blob);
    },
  },
};

class TTSPlayer {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.queue = [];
    this.speaking = false;
    this.generation = 0; // stopAll() 後遞增，使舊的播放流程自動作廢
    this.audioCache = new Map();
    this._cancelCurrent = null;
    this.onStateChange = null; // (speaking: boolean)
    this.onStatus = null; // (message: string)
    if ('speechSynthesis' in window) {
      speechSynthesis.getVoices();
      speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
    }
  }

  get engineId() {
    const id = this.getConfig().ttsEngine;
    return TTS_ENGINES[id] ? id : DEFAULT_TTS_ENGINE;
  }

  // langId：LANGUAGES 的 id（例如 'zh-TW'、'en'）
  speak(text, langId) {
    if (!text) return;
    this.queue.push({ text, langId });
    this._next();
  }

  stopAll() {
    this.generation++;
    this.queue = [];
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this._cancelCurrent?.();
    this.speaking = false;
    this.onStateChange?.(false);
  }

  // 切換引擎或語言後，先把需要下載的模型準備好，避免第一句才等待
  async preload(langIds) {
    const engine = TTS_ENGINES[this.engineId];
    if (!engine?.preload) {
      this._status('');
      return;
    }
    try {
      await engine.preload(langIds, this._ctx(this.generation));
      this._status(`${engine.name}：已就緒`);
    } catch (err) {
      this._status(`${engine.name} 準備失敗：${err.message || err}`);
    }
  }

  _status(message) {
    this.onStatus?.(message || '');
  }

  _ctx(gen) {
    return {
      config: this.getConfig(),
      cancelled: () => gen !== this.generation,
      status: (m) => {
        if (gen === this.generation) this._status(m);
      },
      cached: (key, producer) => this._cached(key, producer),
      playBlob: (blob) => this._playBlob(blob, gen),
    };
  }

  async _cached(key, producer) {
    if (this.audioCache.has(key)) return this.audioCache.get(key);
    const blob = await producer();
    this.audioCache.set(key, blob);
    if (this.audioCache.size > AUDIO_CACHE_LIMIT) {
      this.audioCache.delete(this.audioCache.keys().next().value);
    }
    return blob;
  }

  _playBlob(blob, gen) {
    return new Promise((resolve, reject) => {
      if (gen !== this.generation) return resolve();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      const cleanup = () => {
        URL.revokeObjectURL(url);
        if (this._cancelCurrent === cancel) this._cancelCurrent = null;
      };
      const cancel = () => {
        audio.pause();
        cleanup();
        resolve();
      };
      this._cancelCurrent = cancel;
      audio.onended = () => {
        cleanup();
        resolve();
      };
      audio.onerror = () => {
        cleanup();
        reject(new Error('音訊播放失敗'));
      };
      audio.play().catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  async _next() {
    if (this.speaking || this.queue.length === 0) return;
    const item = this.queue.shift();
    const gen = this.generation;
    this.speaking = true;
    this.onStateChange?.(true);
    try {
      await this._play(item, gen);
    } catch (err) {
      console.warn('[tts]', err);
    }
    if (gen !== this.generation) return;
    this.speaking = false;
    this.onStateChange?.(false);
    this._next();
  }

  async _play({ text, langId }, gen) {
    const ctx = this._ctx(gen);
    const engine = TTS_ENGINES[this.engineId];
    const fallback = TTS_ENGINES.webspeech;
    const langLabel = findLanguage(langId)?.label || langId;

    if (!engine.supports(langId)) {
      this._status(`${engine.name} 不支援「${langLabel}」，已改用 Web Speech`);
      await fallback.speak(text, langId, ctx);
      return;
    }

    try {
      await engine.speak(text, langId, ctx);
      if (!ctx.cancelled()) this._status(engine === fallback ? '' : `${engine.name}：播放完成`);
    } catch (err) {
      if (ctx.cancelled()) return;
      console.warn(`[tts] ${engine.name} 失敗`, err);
      this._status(`${engine.name} 失敗（${err.message || err}），已改用 Web Speech`);
      await fallback.speak(text, langId, ctx);
    }
  }
}
