// Piper Plus 離線語音：piper-plus（VITS + 自帶 G2P，MIT）與本機 ONNX 模型，全程在瀏覽器內以 WASM 合成。
// - 日 / 英 / 中 / 西 / 法 / 葡：piper-plus 多語模型（models/piper-plus/）
// - 韓：Piper Plus 目前沒有韓文訓練模型，改用 MMS-TTS Korean（VITS，models/mms-tts-kor/），韓文字先轉羅馬字
// 模型請先以 `npm run setup:offline` 下載；程式與模型皆由本機靜態伺服器提供，不需外部網路。

const PIPERPLUS_LANGS = { 'zh-TW': 'zh', 'zh-CN': 'zh', en: 'en', ja: 'ja', es: 'es', fr: 'fr', pt: 'pt' };
const PIPERPLUS_MODEL = 'models/piper-plus/tsukuyomi-chan-6lang-fp16.onnx';
const MMS_KO_DIR = 'models/mms-tts-kor/';
const MMS_KO_SAMPLE_RATE = 16000;
const SETUP_HINT = '找不到離線模型，請先執行 npm run setup:offline';

const absoluteUrl = (rel) => new URL(rel, document.baseURI).href;

function isPiperPlusLang(langId) {
  return !!PIPERPLUS_LANGS[langId] || langId === 'ko';
}

async function assertLocalFile(rel) {
  let res;
  try {
    res = await fetch(absoluteUrl(rel), { method: 'HEAD' });
  } catch {
    throw new Error(SETUP_HINT);
  }
  if (!res.ok) throw new Error(SETUP_HINT);
}

let ortPromise = null;
function loadOrt() {
  ortPromise ??= import('onnxruntime-web').catch((err) => {
    ortPromise = null;
    throw new Error(`無法載入 onnxruntime-web（請先執行 npm install）：${err.message || err}`);
  });
  return ortPromise;
}

let piperPlusPromise = null;
function loadPiperPlus(ctx) {
  piperPlusPromise ??= (async () => {
    await assertLocalFile(PIPERPLUS_MODEL);
    const [{ PiperPlus }, ort] = await Promise.all([import('piper-plus'), loadOrt()]);
    return PiperPlus.initialize({
      model: absoluteUrl(PIPERPLUS_MODEL),
      ort,
      showModelNotice: false,
      onProgress: ({ progress, message }) => {
        if (typeof progress === 'number' && message) ctx.status(`Piper Plus：${message}`);
      },
    });
  })().catch((err) => {
    piperPlusPromise = null;
    throw err;
  });
  return piperPlusPromise;
}

// ---------- 韓文：Hangul → 羅馬字（MMS-TTS Korean 的輸入格式，與 uroman 輸出相同的逐字母轉寫） ----------
const KO_INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const KO_MEDIALS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const KO_FINALS = ['', 'g', 'kk', 'gs', 'n', 'nj', 'nh', 'd', 'l', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm', 'b', 'bs', 's', 'ss', 'ng', 'j', 'ch', 'k', 't', 'p', 'h'];

function romanizeKorean(text) {
  let out = '';
  for (const ch of String(text).normalize('NFC').toLowerCase()) {
    const code = ch.codePointAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const idx = code - 0xac00;
      out += KO_INITIALS[Math.floor(idx / 588)] + KO_MEDIALS[Math.floor((idx % 588) / 28)] + KO_FINALS[idx % 28];
    } else if (/[a-z' -]/.test(ch)) {
      out += ch;
    } else if (/\s|[.,!?;:·…~、。，！？「」『』()（）"“”]/.test(ch)) {
      out += ' ';
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

// 依句末標點切句，過長者再依逗號 / 長度切，避免單次推論太長
function splitForMms(text) {
  const sentences = String(text)
    .split(/(?<=[.!?。！？…\n])/)
    .flatMap((s) => s.split(/(?<=[,，、;；])/))
    .map((s) => romanizeKorean(s))
    .filter(Boolean);
  const chunks = [];
  for (const s of sentences) {
    let rest = s;
    while (rest.length > 160) {
      const cut = rest.lastIndexOf(' ', 160);
      const at = cut > 40 ? cut : 160;
      chunks.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) chunks.push(rest);
  }
  return chunks;
}

let mmsPromise = null;
function loadMmsKorean(ctx) {
  mmsPromise ??= (async () => {
    await assertLocalFile(`${MMS_KO_DIR}model.onnx`);
    const ort = await loadOrt();
    ctx.status('Piper Plus：載入韓文模型…');
    const [vocab, session] = await Promise.all([
      fetch(absoluteUrl(`${MMS_KO_DIR}vocab.json`)).then((r) => r.json()),
      ort.InferenceSession.create(absoluteUrl(`${MMS_KO_DIR}model.onnx`), { executionProviders: ['wasm'] }),
    ]);
    return { ort, vocab, session };
  })().catch((err) => {
    mmsPromise = null;
    throw err;
  });
  return mmsPromise;
}

async function synthesizeMmsKorean(text, ctx) {
  const { ort, vocab, session } = await loadMmsKorean(ctx);
  const chunks = splitForMms(text);
  if (!chunks.length) throw new Error('沒有可朗讀的韓文內容');
  const parts = [];
  for (const chunk of chunks) {
    const ids = [...chunk].map((c) => vocab[c]).filter((id) => id !== undefined);
    if (!ids.length) continue;
    // add_blank：每個字元前後插入 pad（id 0）
    const input = new BigInt64Array(ids.length * 2 + 1);
    ids.forEach((id, i) => {
      input[i * 2 + 1] = BigInt(id);
    });
    const dims = [1, input.length];
    const result = await session.run({
      input_ids: new ort.Tensor('int64', input, dims),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(input.length).fill(1n), dims),
    });
    parts.push(result[session.outputNames[0]].data);
  }
  if (!parts.length) throw new Error('沒有可朗讀的韓文內容');

  const gap = Math.round(MMS_KO_SAMPLE_RATE * 0.25);
  const total = parts.reduce((n, p) => n + p.length, 0) + gap * (parts.length - 1);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    samples.set(p, offset);
    offset += p.length + gap;
  }
  return float32ToWavBlob(samples, MMS_KO_SAMPLE_RATE);
}

function float32ToWavBlob(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (pos, s) => [...s].forEach((c, i) => view.setUint8(pos + i, c.charCodeAt(0)));
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// piper-plus 的拼音字典以簡體為主，繁體中文先轉成簡體再合成
let t2cnPromise = null;
function loadTraditionalToSimplified() {
  t2cnPromise ??= import('opencc-js/t2cn')
    .then((m) => m.Converter({ from: 'tw', to: 'cn' }))
    .catch((err) => {
      console.warn('[piperplus] 繁轉簡載入失敗，改用原文', err);
      return (s) => s;
    });
  return t2cnPromise;
}

async function piperPlusPreload(langIds, ctx) {
  if (langIds.some((l) => PIPERPLUS_LANGS[l])) {
    ctx.status('Piper Plus：載入引擎…');
    await loadPiperPlus(ctx);
  }
  if (langIds.includes('zh-TW')) await loadTraditionalToSimplified();
  if (langIds.includes('ko')) await loadMmsKorean(ctx);
}

async function piperPlusSynthesize(text, langId, ctx) {
  if (langId === 'ko') {
    ctx.status('Piper Plus：合成韓文語音中…');
    return synthesizeMmsKorean(text, ctx);
  }
  ctx.status('Piper Plus：載入引擎…');
  const piper = await loadPiperPlus(ctx);
  const input = langId === 'zh-TW' ? (await loadTraditionalToSimplified())(text) : text;
  ctx.status('Piper Plus：合成語音中…');
  const audio = await piper.synthesize(input, { language: PIPERPLUS_LANGS[langId] });
  return audio.toBlob();
}
