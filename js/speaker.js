// 說話者辨識前端：錄下麥克風音訊，依時間切出每句語音，在瀏覽器內以 wespeaker ResNet34（ONNX，onnxruntime-web）
// 取出聲紋並線上分群成甲/乙兩位說話者。全程在本機執行，音訊不會離開裝置，不需要任何後端。
// Web Speech API 拿不到原始音訊，因此另開一路 getUserMedia 錄音，與辨識並行。

const SPEAKER_TARGET_RATE = 16000;
const SPEAKER_BUFFER_MS = 60000;

class SpeakerRecorder {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.chunks = []; // { endMs, rate, data: Float32Array }
    this.running = false;
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      const data = new Float32Array(e.inputBuffer.getChannelData(0));
      const now = Date.now();
      this.chunks.push({ endMs: now, rate: this.ctx.sampleRate, data });
      const cutoff = now - SPEAKER_BUFFER_MS;
      while (this.chunks.length && this.chunks[0].endMs < cutoff) this.chunks.shift();
    };
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination); // ScriptProcessor 需連到輸出才會觸發；輸出為靜音
    this.running = true;
  }

  stop() {
    this.running = false;
    try { this.node?.disconnect(); } catch { /* ignore */ }
    try { this.source?.disconnect(); } catch { /* ignore */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = this.source = this.stream = this.ctx = null;
    this.chunks = [];
  }

  // 丟棄目前已錄的音訊（播放譯文期間錄到的喇叭聲不應拿去辨識）
  clear() {
    this.chunks = [];
  }

  // 取 [startMs, endMs] 的音訊，轉成 16 kHz mono Float32；沒有音訊時回傳 null
  slicePcm(startMs, endMs) {
    const parts = [];
    let rate = 0;
    for (const c of this.chunks) {
      const dur = (c.data.length / c.rate) * 1000;
      const cStart = c.endMs - dur;
      if (c.endMs < startMs || cStart > endMs) continue;
      parts.push(c.data);
      rate = c.rate;
    }
    if (!parts.length) return null;
    const total = parts.reduce((n, p) => n + p.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const p of parts) { merged.set(p, off); off += p.length; }
    return downsample(merged, rate, SPEAKER_TARGET_RATE);
  }
}

function downsample(input, fromRate, toRate) {
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

// ---------- 特徵擷取：與 torchaudio.compliance.kaldi.fbank（wespeaker 設定）等價 ----------

const FBANK = { rate: SPEAKER_TARGET_RATE, frameLen: 400, frameShift: 160, nfft: 512, bins: 80, lowFreq: 20, preemph: 0.97 };
const FBANK_EPS = 1.1920929e-7;

const fbankWindow = Float32Array.from({ length: FBANK.frameLen }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FBANK.frameLen - 1)));

const fbankMelBanks = (() => {
  const mel = (f) => 1127 * Math.log(1 + f / 700);
  const nBins = FBANK.nfft / 2;
  const binWidth = FBANK.rate / FBANK.nfft;
  const melLow = mel(FBANK.lowFreq);
  const melHigh = mel(FBANK.rate / 2);
  const delta = (melHigh - melLow) / (FBANK.bins + 1);
  return Array.from({ length: FBANK.bins }, (_, b) => {
    const left = melLow + b * delta;
    const center = melLow + (b + 1) * delta;
    const right = melLow + (b + 2) * delta;
    const weights = new Float32Array(nBins + 1); // 最後一格（Nyquist）固定為 0
    for (let k = 0; k < nBins; k++) {
      const m = mel(binWidth * k);
      weights[k] = Math.max(0, Math.min((m - left) / (center - left), (right - m) / (right - center)));
    }
    return weights;
  });
})();

const fftTwiddle = (() => {
  const n = FBANK.nfft;
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  return { cos, sin };
})();

// 原地 radix-2 FFT（長度 FBANK.nfft）
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = fftTwiddle.cos[k * step];
        const wi = fftTwiddle.sin[k * step];
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// samples：16 kHz mono，範圍 [-1, 1]。回傳 { data: Float32Array(frames * 80), frames }，已做整段平均值正規化
function computeFbank(samples) {
  const frames = Math.floor((samples.length - FBANK.frameLen) / FBANK.frameShift) + 1;
  if (frames < 1) return null;
  const data = new Float32Array(frames * FBANK.bins);
  const re = new Float32Array(FBANK.nfft);
  const im = new Float32Array(FBANK.nfft);
  const frame = new Float32Array(FBANK.frameLen);
  const half = FBANK.nfft / 2;
  const power = new Float32Array(half + 1);

  for (let t = 0; t < frames; t++) {
    const off = t * FBANK.frameShift;
    let mean = 0;
    for (let i = 0; i < FBANK.frameLen; i++) {
      frame[i] = samples[off + i] * 32768;
      mean += frame[i];
    }
    mean /= FBANK.frameLen;
    for (let i = 0; i < FBANK.frameLen; i++) frame[i] -= mean;
    re.fill(0);
    im.fill(0);
    re[0] = (frame[0] - FBANK.preemph * frame[0]) * fbankWindow[0];
    for (let i = 1; i < FBANK.frameLen; i++) re[i] = (frame[i] - FBANK.preemph * frame[i - 1]) * fbankWindow[i];
    fftInPlace(re, im);
    for (let k = 0; k <= half; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    for (let b = 0; b < FBANK.bins; b++) {
      const w = fbankMelBanks[b];
      let sum = 0;
      for (let k = 0; k <= half; k++) sum += w[k] * power[k];
      data[t * FBANK.bins + b] = Math.log(Math.max(sum, FBANK_EPS));
    }
  }

  for (let b = 0; b < FBANK.bins; b++) {
    let mean = 0;
    for (let t = 0; t < frames; t++) mean += data[t * FBANK.bins + b];
    mean /= frames;
    for (let t = 0; t < frames; t++) data[t * FBANK.bins + b] -= mean;
  }
  return { data, frames };
}

// ---------- 聲紋模型與線上分群（邏輯與原 diarize/server.py 相同） ----------

const SPEAKER_MODEL_URL = 'models/wespeaker/voxceleb_resnet34_LM.onnx';
const SPEAKER_SETUP_HINT = '找不到聲紋模型，請先執行 npm run setup:offline';
const SPEAKER_SAME_THRESHOLD = 0.5; // 餘弦相似度 >= 此值視為同一人；越高越容易判成兩個人
const SPEAKER_MIN_SECONDS = 1.0;
const SPEAKER_MAX_SECONDS = 20;     // 過長的音訊只取最後這段，避免手機運算過久
const SPEAKER_MAX_SPEAKERS = 2;

class SpeakerIdentifier {
  constructor() {
    this.session = null;
    this.ort = null;
    this.loading = null;
    this.centroids = [];
    this.weights = [];
    this.queue = Promise.resolve();
  }

  // 載入模型（只會載入一次）；找不到模型或載入失敗時丟出錯誤
  health() {
    this.loading ??= (async () => {
      const url = new URL(SPEAKER_MODEL_URL, document.baseURI).href;
      let head;
      try {
        head = await fetch(url, { method: 'HEAD' });
      } catch {
        throw new Error(SPEAKER_SETUP_HINT);
      }
      if (!head.ok) throw new Error(SPEAKER_SETUP_HINT);
      this.ort = await import('onnxruntime-web');
      this.session = await this.ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
    })().catch((err) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  async _embed(pcm) {
    await this.health();
    const maxSamples = SPEAKER_MAX_SECONDS * SPEAKER_TARGET_RATE;
    const fbank = computeFbank(pcm.length > maxSamples ? pcm.subarray(pcm.length - maxSamples) : pcm);
    if (!fbank) return null;
    const feats = new this.ort.Tensor('float32', fbank.data, [1, fbank.frames, FBANK.bins]);
    const out = await this.session.run({ feats });
    const emb = Array.from(Object.values(out)[0].data);
    const norm = Math.hypot(...emb) + 1e-9;
    return emb.map((v) => v / norm);
  }

  // 一次只跑一個推論，避免即時偵測與定稿辨識同時佔用 WASM
  identify(pcm, enroll = true) {
    const run = () => this._identify(pcm, enroll);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async _identify(pcm, enroll) {
    const seconds = pcm.length / SPEAKER_TARGET_RATE;
    if (seconds < SPEAKER_MIN_SECONDS) return { speaker: null, reason: 'too_short', seconds };
    const emb = await this._embed(pcm);
    if (!emb) return { speaker: null, reason: 'too_short', seconds };

    const sims = this.centroids.map((c) => c.reduce((n, v, i) => n + v * emb[i], 0));
    if (!this.centroids.length) {
      if (!enroll) return { speaker: null, similarities: sims, created: false, seconds };
      return { speaker: this._add(emb, seconds), similarities: sims, created: true, seconds };
    }

    let best = 0;
    sims.forEach((v, i) => { if (v > sims[best]) best = i; });
    if (sims[best] >= SPEAKER_SAME_THRESHOLD) {
      if (enroll) this._update(best, emb, seconds);
      return { speaker: best, similarities: sims, created: false, seconds };
    }
    if (this.centroids.length < SPEAKER_MAX_SPEAKERS) {
      if (!enroll) return { speaker: null, similarities: sims, created: false, seconds };
      return { speaker: this._add(emb, seconds), similarities: sims, created: true, seconds };
    }
    return { speaker: best, similarities: sims, created: false, seconds };
  }

  _add(emb, seconds) {
    this.centroids.push(emb);
    this.weights.push(seconds);
    return this.centroids.length - 1;
  }

  _update(idx, emb, seconds) {
    const w = this.weights[idx];
    const merged = this.centroids[idx].map((v, i) => v * w + emb[i] * seconds);
    const norm = Math.hypot(...merged) + 1e-9;
    this.centroids[idx] = merged.map((v) => v / norm);
    this.weights[idx] = w + seconds;
  }

  reset() {
    this.centroids = [];
    this.weights = [];
  }
}
