import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const PORT = Number(process.env.PORT || 8787);
const DIARIZE_URL = process.env.DIARIZE_URL || 'http://127.0.0.1:8788';
const SPEAKER_MAX_BYTES = 8_000_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EDGE_VOICE_PATTERN = /^[a-z]{2,3}-[A-Z]{2,4}-[A-Za-z]+Neural$/;
const EDGE_TTS_MAX_CHARS = 1500;

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Microsoft Edge Read Aloud：只能在後端呼叫（瀏覽器端不被允許），回傳 MP3 Buffer
async function synthesizeEdge(text, voice) {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeXml(text));
    const chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on('data', (d) => chunks.push(d));
      audioStream.on('close', resolve);
      audioStream.on('error', reject);
    });
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error('Edge TTS 未回傳音訊');
    return buf;
  } finally {
    tts.close?.();
  }
}

const LANGUAGES = [
  { id: 'zh-TW', azure: 'zh-Hant', google: 'zh-TW', deepl: 'ZH-HANT' },
  { id: 'zh-CN', azure: 'zh-Hans', google: 'zh-CN', deepl: 'ZH' },
  { id: 'en', azure: 'en', google: 'en', deepl: 'EN-US' },
  { id: 'ja', azure: 'ja', google: 'ja', deepl: 'JA' },
  { id: 'ko', azure: 'ko', google: 'ko', deepl: 'KO' },
  { id: 'es', azure: 'es', google: 'es', deepl: 'ES' },
  { id: 'fr', azure: 'fr', google: 'fr', deepl: 'FR' },
  { id: 'de', azure: 'de', google: 'de', deepl: 'DE' },
  { id: 'pt', azure: 'pt', google: 'pt', deepl: 'PT-PT' },
  { id: 'id', azure: 'id', google: 'id', deepl: 'ID' },
  { id: 'vi', azure: 'vi', google: 'vi', deepl: null },
  { id: 'th', azure: 'th', google: 'th', deepl: null },
];

const exhausted = new Set();

class QuotaError extends Error {}
class UnsupportedLangError extends Error {}

function loadDotEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnvFile();

function env(name) {
  return String(process.env[name] || '').trim();
}

function cfgValue(name, runtimeConfig = {}) {
  const v = env(name);
  if (v) return v;
  if (name === 'AZURE_KEY') return String(runtimeConfig.azureKey || '').trim();
  if (name === 'AZURE_REGION') return String(runtimeConfig.azureRegion || '').trim();
  if (name === 'GOOGLE_KEY') return String(runtimeConfig.googleKey || '').trim();
  if (name === 'DEEPL_KEY') return String(runtimeConfig.deeplKey || '').trim();
  if (name === 'DEEPL_PLAN') return String(runtimeConfig.deeplPlan || '').trim();
  if (name === 'PROVIDER_ORDER') {
    return Array.isArray(runtimeConfig.providerOrder) ? runtimeConfig.providerOrder.join(',') : '';
  }
  return '';
}

function providerLangCode(providerId, langId) {
  const lang = LANGUAGES.find((l) => l.id === langId);
  return lang ? lang[providerId] : null;
}

function findLanguageByProviderCode(providerId, code) {
  if (!code) return null;
  const normalized = String(code).toLowerCase();
  return LANGUAGES.find((l) => l[providerId] && String(l[providerId]).toLowerCase() === normalized)?.id || null;
}

function providerOrder(runtimeConfig) {
  const raw = cfgValue('PROVIDER_ORDER', runtimeConfig);
  const all = ['azure', 'google', 'deepl'];
  if (!raw) return all;
  const picked = raw.split(',').map((s) => s.trim()).filter((s) => all.includes(s));
  return [...picked, ...all.filter((p) => !picked.includes(p))];
}

function deeplHost(runtimeConfig) {
  const key = cfgValue('DEEPL_KEY', runtimeConfig);
  if (key.toLowerCase().endsWith(':fx')) return 'https://api-free.deepl.com';
  return cfgValue('DEEPL_PLAN', runtimeConfig).toLowerCase() === 'pro' ? 'https://api.deepl.com' : 'https://api-free.deepl.com';
}

function providerConfigured(pid, runtimeConfig) {
  if (pid === 'azure') return !!cfgValue('AZURE_KEY', runtimeConfig);
  if (pid === 'google') return !!cfgValue('GOOGLE_KEY', runtimeConfig);
  if (pid === 'deepl') return !!cfgValue('DEEPL_KEY', runtimeConfig);
  return false;
}

const providers = {
  azure: {
    name: 'Azure Translator',
    async translate(text, fromId, toId, runtimeConfig) {
      const from = providerLangCode('azure', fromId);
      const to = providerLangCode('azure', toId);
      if (!from || !to) throw new UnsupportedLangError('Azure 不支援此語言');
      const res = await fetch(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': cfgValue('AZURE_KEY', runtimeConfig),
          'Ocp-Apim-Subscription-Region': cfgValue('AZURE_REGION', runtimeConfig) || 'southeastasia',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ Text: text }]),
      });
      if ([401, 403, 429, 456].includes(res.status)) throw new QuotaError(`Azure 錯誤 ${res.status}`);
      if (!res.ok) throw new Error(`Azure 錯誤 ${res.status}`);
      const data = await res.json();
      return data[0].translations[0].text;
    },
    async detectLanguage(text, runtimeConfig) {
      const res = await fetch('https://api.cognitive.microsofttranslator.com/detect?api-version=3.0', {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': cfgValue('AZURE_KEY', runtimeConfig),
          'Ocp-Apim-Subscription-Region': cfgValue('AZURE_REGION', runtimeConfig) || 'southeastasia',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ Text: text }]),
      });
      if ([401, 403, 429, 456].includes(res.status)) throw new QuotaError(`Azure 偵測錯誤 ${res.status}`);
      if (!res.ok) throw new Error(`Azure 偵測錯誤 ${res.status}`);
      const data = await res.json();
      return data?.[0]?.language || null;
    },
  },
  google: {
    name: 'Google Cloud Translation',
    async translate(text, fromId, toId, runtimeConfig) {
      const from = providerLangCode('google', fromId);
      const to = providerLangCode('google', toId);
      if (!from || !to) throw new UnsupportedLangError('Google 不支援此語言');
      const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(cfgValue('GOOGLE_KEY', runtimeConfig))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source: from, target: to, format: 'text' }),
      });
      if ([401, 403, 429].includes(res.status)) throw new QuotaError(`Google 錯誤 ${res.status}`);
      if (!res.ok) throw new Error(`Google 錯誤 ${res.status}`);
      const data = await res.json();
      return data.data.translations[0].translatedText;
    },
    async detectLanguage(text, runtimeConfig) {
      const res = await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${encodeURIComponent(cfgValue('GOOGLE_KEY', runtimeConfig))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text }),
      });
      if ([401, 403, 429].includes(res.status)) throw new QuotaError(`Google 偵測錯誤 ${res.status}`);
      if (!res.ok) throw new Error(`Google 偵測錯誤 ${res.status}`);
      const data = await res.json();
      return data?.data?.detections?.[0]?.[0]?.language || null;
    },
  },
  deepl: {
    name: 'DeepL',
    async translate(text, fromId, toId, runtimeConfig) {
      const to = providerLangCode('deepl', toId);
      if (!to) throw new UnsupportedLangError('DeepL 不支援此語言');
      const res = await fetch(`${deeplHost(runtimeConfig)}/v2/translate`, {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${cfgValue('DEEPL_KEY', runtimeConfig)}`,
          'Content-Type': 'application/json',
        },
        // 交由 DeepL 自動偵測來源語言，避免 source_lang 語言碼不相容造成 400
        body: JSON.stringify({ text: [text], target_lang: to }),
      });
      if ([403, 429, 456].includes(res.status)) throw new QuotaError(`DeepL 錯誤 ${res.status}`);
      if (!res.ok) throw new Error(`DeepL 錯誤 ${res.status}`);
      const data = await res.json();
      return data.translations[0].text;
    },
  },
};

async function translateWithFallback(text, fromId, toId, runtimeConfig) {
  const failures = [];
  for (const pid of providerOrder(runtimeConfig)) {
    if (!providerConfigured(pid, runtimeConfig) || exhausted.has(pid)) continue;
    try {
      const translated = await providers[pid].translate(text, fromId, toId, runtimeConfig);
      return { text: translated, provider: pid };
    } catch (err) {
      if (err instanceof QuotaError) {
        exhausted.add(pid);
        failures.push(err.message);
        continue;
      }
      if (err instanceof UnsupportedLangError) {
        failures.push(err.message);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`所有翻譯服務都失敗或額度已用盡（${failures.join('；') || '無可用服務'}）。`);
}

async function detectWithFallback(text, runtimeConfig) {
  for (const pid of providerOrder(runtimeConfig)) {
    const provider = providers[pid];
    if (!provider?.detectLanguage || !providerConfigured(pid, runtimeConfig) || exhausted.has(pid)) continue;
    try {
      const providerCode = await provider.detectLanguage(text, runtimeConfig);
      const langId = findLanguageByProviderCode(pid, providerCode);
      if (langId) return { langId, provider: pid };
    } catch (err) {
      if (err instanceof QuotaError) {
        exhausted.add(pid);
      }
    }
  }
  return { langId: null, provider: null };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1_000_000) throw new Error('Request body too large');
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function readRawBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 轉發到 pyannote 說話者辨識服務（diarize/server.py）
async function forwardSpeaker(req, res) {
  const { pathname, search } = new URL(req.url, 'http://localhost');
  const target = pathname.replace(/^\/api\/speaker/, '');
  if (!['/health', '/identify', '/reset'].includes(target)) return sendJson(res, 404, { error: 'Not found' });
  try {
    const init = { method: req.method };
    if (req.method === 'POST') {
      init.body = await readRawBody(req, SPEAKER_MAX_BYTES);
      init.headers = { 'Content-Type': req.headers['content-type'] || 'application/octet-stream' };
    }
    const upstream = await fetch(`${DIARIZE_URL}${target}${search}`, init);
    return sendJson(res, upstream.status, await upstream.json());
  } catch (err) {
    return sendJson(res, 503, { error: `說話者辨識服務無法使用：${err?.cause?.code || err.message}` });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }
  if (req.url.startsWith('/api/speaker/')) return forwardSpeaker(req, res);
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, exhausted: [...exhausted] });
  }
  if (req.method !== 'POST') {
    return sendJson(res, 404, { error: 'Not found' });
  }

  try {
    if (req.url === '/api/tts/edge') {
      const { text, voice } = await readBody(req);
      const cleanText = String(text || '').trim();
      const voiceName = String(voice || '');
      if (!cleanText) return sendJson(res, 400, { error: 'text 必填' });
      if (cleanText.length > EDGE_TTS_MAX_CHARS) return sendJson(res, 400, { error: `text 過長（上限 ${EDGE_TTS_MAX_CHARS} 字）` });
      if (!EDGE_VOICE_PATTERN.test(voiceName)) return sendJson(res, 400, { error: 'voice 格式無效' });
      const audio = await synthesizeEdge(cleanText, voiceName);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audio.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      return res.end(audio);
    }

    if (req.url === '/api/translate') {
      const { text, fromId, toId, runtimeConfig } = await readBody(req);
      if (!text || !fromId || !toId) return sendJson(res, 400, { error: 'text, fromId, toId 必填' });
      const out = await translateWithFallback(String(text), String(fromId), String(toId), runtimeConfig || {});
      return sendJson(res, 200, out);
    }

    if (req.url === '/api/detect') {
      const { text, runtimeConfig } = await readBody(req);
      if (!text) return sendJson(res, 400, { error: 'text 必填' });
      const out = await detectWithFallback(String(text), runtimeConfig || {});
      return sendJson(res, 200, out);
    }

    if (req.url === '/api/test') {
      const { provider, runtimeConfig } = await readBody(req);
      const pid = String(provider || '');
      if (!providers[pid]) return sendJson(res, 400, { error: 'provider 無效' });
      if (!providerConfigured(pid, runtimeConfig || {})) return sendJson(res, 400, { error: `${pid} 尚未設定環境變數或前端 key` });
      exhausted.delete(pid);
      const text = await providers[pid].translate('Hello', 'en', 'zh-TW', runtimeConfig || {});
      return sendJson(res, 200, { text, provider: pid });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    const message = err?.message || String(err);
    return sendJson(res, 502, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`[proxy] listening on http://localhost:${PORT}`);
});
