// DeepL CORS 中繼（Cloudflare Worker）。DeepL API 不提供 CORS 標頭，瀏覽器無法直連。
// 本 Worker 不儲存任何 Key：Authorization 標頭由瀏覽器帶入，原樣轉給 DeepL。
// 只允許下方 ALLOWED_ORIGINS 的網頁呼叫，且只轉發 /v2/translate。
const ALLOWED_ORIGINS = ['https://huawei0915.github.io', 'http://localhost:8000'];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response('Forbidden', { status: 403 });
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v2/translate') {
      return new Response('Not found', { status: 404, headers: cors });
    }

    const auth = request.headers.get('Authorization') || '';
    const free = auth.trim().toLowerCase().endsWith(':fx');
    const upstream = await fetch(`https://${free ? 'api-free' : 'api'}.deepl.com/v2/translate`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: request.body,
    });

    const headers = new Headers(cors);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
