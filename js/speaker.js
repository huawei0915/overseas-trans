// 說話者辨識（pyannote.audio）前端：錄下麥克風音訊，依時間切出每句語音送到後端辨識是誰在說話。
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

  // 取 [startMs, endMs] 的音訊，轉成 16 kHz mono 16-bit WAV；音訊不足時回傳 null
  sliceWav(startMs, endMs) {
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
    return encodeWav(downsample(merged, rate, SPEAKER_TARGET_RATE), SPEAKER_TARGET_RATE);
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

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// 呼叫後端（經 proxy 轉發到 diarize/server.py）。一個 session 對應一組甲/乙聲紋。
class SpeakerIdentifier {
  constructor(getBaseUrl) {
    this.getBaseUrl = getBaseUrl;
    this.sessionId = Math.random().toString(36).slice(2);
  }

  _url(path, params = '') {
    return `${this.getBaseUrl()}/api/speaker/${path}?session=${this.sessionId}${params}`;
  }

  async health() {
    const res = await fetch(this._url('health'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // enroll=false：只比對、不更新聲紋（說話途中的即時偵測用）
  async identify(wavBlob, enroll = true) {
    const res = await fetch(this._url('identify', `&enroll=${enroll ? 1 : 0}`), {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavBlob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async reset() {
    this.sessionId = Math.random().toString(36).slice(2);
  }
}
