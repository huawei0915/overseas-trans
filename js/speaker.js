// 伺服器端語音辨識 + 說話者辨識的前端：
// 只用「一路」麥克風錄音（不使用 Web Speech，所以手機上不會有兩個程式搶麥克風而一直停在「聆聽中」），
// 在瀏覽器內以音量切出每一句（靜音 1 秒結句），把整句音訊傳給後端（diarize/server.py）
// 由後端轉文字並以 wespeaker 聲紋分群出甲/乙方。瀏覽器本身不做任何模型運算。

const VOICE_TARGET_RATE = 16000;
const VOICE_SILENCE_MS = 1000;      // 靜音多久視為一句結束
const VOICE_MIN_VOICED_MS = 400;    // 有聲時間不足視為雜音，丟棄
const VOICE_MAX_UTTERANCE_MS = 25000;
const VOICE_PREROLL_CHUNKS = 4;     // 開口前多保留幾塊音訊，避免吃掉字首
const VOICE_START_RMS = 0.015;
const VOICE_KEEP_RMS = 0.008;

class VoiceListener {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.running = false;
    this.paused = false;
    this.starting = null;
    this.callbacks = {};
    this._resetState();
    this.noiseFloor = 0;
  }

  _resetState() {
    this.preroll = [];
    this.parts = [];
    this.speaking = false;
    this.voicedRun = 0;
    this.voicedMs = 0;
    this.silentMs = 0;
    this.totalMs = 0;
    this.startMs = 0;
  }

  // 必須在使用者點擊的事件處理器內「同步」呼叫：iOS Safari 只允許在手勢中建立/啟動 AudioContext
  prepare() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  start(callbacks) {
    this.callbacks = callbacks || {};
    this.starting ??= this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start() {
    if (this.running) return;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('此瀏覽器不支援麥克風（需 HTTPS 網址）');
      this.prepare();
      if (!this.ctx) throw new Error('此瀏覽器不支援 Web Audio');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // resume() 在被瀏覽器阻擋時可能永遠不 resolve，限時等待，由下方活檢明確報錯
      if (this.ctx.state === 'suspended') await Promise.race([this.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.node = this.ctx.createScriptProcessor(4096, 1, 1);
      let chunkCount = 0;
      this.node.onaudioprocess = (e) => {
        chunkCount++;
        this._onChunk(new Float32Array(e.inputBuffer.getChannelData(0)), this.ctx.sampleRate);
      };
      this.source.connect(this.node);
      this.node.connect(this.ctx.destination); // ScriptProcessor 需連到輸出才會觸發；輸出為靜音
      this.running = true;
      this.paused = false;
      this._resetState();
      // 活檢：確認真的有音訊流進來，失敗就明確報錯而不是靜靜沒反應
      await new Promise((resolve, reject) => {
        setTimeout(() => {
          if (chunkCount) resolve();
          else reject(new Error('麥克風錄音未啟動（音訊處理被瀏覽器暫停）'));
        }, 1000);
      });
    } catch (err) {
      this.stop(false);
      throw err;
    }
  }

  _onChunk(data, rate) {
    if (!this.running || this.paused) return;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const dur = (data.length / rate) * 1000;
    const chunk = { data, rate };
    this.totalMs += dur;

    if (!this.speaking) {
      this.noiseFloor = this.noiseFloor ? this.noiseFloor * 0.95 + rms * 0.05 : rms;
      const startThr = Math.max(VOICE_START_RMS, this.noiseFloor * 3);
      this.preroll.push(chunk);
      if (this.preroll.length > VOICE_PREROLL_CHUNKS) this.preroll.shift();
      this.voicedRun = rms > startThr ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= 2) {
        this.speaking = true;
        this.parts = [...this.preroll];
        this.preroll = [];
        this.voicedMs = dur * this.voicedRun;
        this.silentMs = 0;
        this.startMs = Date.now() - this.parts.reduce((n, c) => n + (c.data.length / c.rate) * 1000, 0);
        this.callbacks.onSpeechStart?.();
      }
      return;
    }

    this.parts.push(chunk);
    const keepThr = Math.max(VOICE_KEEP_RMS, this.noiseFloor * 1.8);
    if (rms > keepThr) {
      this.voicedMs += dur;
      this.silentMs = 0;
    } else {
      this.silentMs += dur;
    }
    const lengthMs = this.parts.reduce((n, c) => n + (c.data.length / c.rate) * 1000, 0);
    if (this.silentMs >= VOICE_SILENCE_MS || lengthMs >= VOICE_MAX_UTTERANCE_MS) this._finalize();
  }

  _finalize() {
    const parts = this.parts;
    const voicedMs = this.voicedMs;
    const startMs = this.startMs;
    this._resetState();
    if (voicedMs < VOICE_MIN_VOICED_MS || !parts.length) {
      this.callbacks.onDiscard?.();
      return;
    }
    const total = parts.reduce((n, c) => n + c.data.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of parts) { merged.set(c.data, off); off += c.data.length; }
    const pcm = voiceDownsample(merged, parts[0].rate, VOICE_TARGET_RATE);
    this.callbacks.onUtterance?.(pcm, { startMs, endMs: Date.now() });
  }

  // 播放譯文期間暫停收音並丟棄暫存，避免把喇叭聲音辨識進來
  pause() {
    this.paused = true;
    this._resetState();
  }

  resume() {
    if (!this.paused) return;
    this._resetState();
    this.paused = false;
  }

  // flush：結束時把說到一半的那一句送出
  stop(flush = true) {
    if (flush && this.running && this.speaking) this._finalize();
    this.running = false;
    this.paused = false;
    try { this.node?.disconnect(); } catch { /* ignore */ }
    try { this.source?.disconnect(); } catch { /* ignore */ }
    if (this.node) this.node.onaudioprocess = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = this.source = this.stream = this.ctx = null;
    this._resetState();
  }
}

function voiceDownsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    // 區間平均，避免直接抽樣造成混疊
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    out[i] = sum / Math.max(1, b - a);
  }
  return out;
}

function pcmToWav(pcm, rate = VOICE_TARGET_RATE) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);   // PCM
  v.setUint16(22, 1, true);   // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// ---------- 後端 API（經由 proxy 的 /api/speaker/*）----------

class SpeakerServer {
  constructor(getBaseUrl) {
    this.getBaseUrl = getBaseUrl;
    this.session = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  _url(path, params = {}) {
    const base = String(this.getBaseUrl() || '').replace(/\/+$/, '');
    if (!base) throw new Error('Proxy Base URL 未設定');
    const qs = new URLSearchParams({ session: this.session, ...params });
    return `${base}/api/speaker${path}?${qs}`;
  }

  async _fetchJson(url, init, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `伺服器回應 ${res.status}`);
        err.loading = !!data.loading;
        throw err;
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('連線逾時');
      if (err instanceof TypeError) throw new Error('無法連線到辨識伺服器');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // 等到後端模型載入完成（冷啟動可能要一兩分鐘）；伺服器連不上或模型載入失敗就丟出錯誤
  async waitReady(onStatus, isCancelled = () => false, maxMs = 120000) {
    const deadline = Date.now() + maxMs;
    let netFailures = 0;
    while (!isCancelled()) {
      try {
        const h = await this._fetchJson(this._url('/health'), {}, 10000);
        if (h.error) throw new Error(h.error);
        if (h.ready) return h;
        onStatus?.('伺服器載入辨識模型中…');
        netFailures = 0;
      } catch (err) {
        // 首次請求常因穿隧/冷啟動失敗：重試幾次再放棄
        if (++netFailures >= 3 || Date.now() > deadline) throw err;
      }
      if (Date.now() > deadline) throw new Error('伺服器模型載入逾時');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // 回傳 { text, language, speaker, similarities, seconds }；text 為空表示沒有可辨識的語音
  async transcribe(pcm, { langs, enroll = true }) {
    const url = this._url('/transcribe', { langs: langs.join(','), enroll: enroll ? '1' : '0' });
    return this._fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: pcmToWav(pcm) }, 60000);
  }

  async reset() {
    try {
      await this._fetchJson(this._url('/reset'), { method: 'POST' }, 10000);
    } catch { /* 重置失敗不影響使用 */ }
  }
}
