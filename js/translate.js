// 翻譯 provider 抽象層 + 額度用盡自動容錯
// 依賴 js/langs.js 的 providerLangCode()

class QuotaError extends Error {}          // 額度用盡 / 授權失敗 → 標記耗盡並切換下一家
class UnsupportedLangError extends Error {} // 此 provider 不支援該語言 → 換下一家（不標記耗盡）

function resolveDeepLHost(cfg) {
  const key = String(cfg.deeplKey || '');
  // DeepL Free key 會以 :fx 結尾，必須打 api-free
  if (key.toLowerCase().endsWith(':fx')) return 'https://api-free.deepl.com';
  return cfg.deeplPlan === 'pro' ? 'https://api.deepl.com' : 'https://api-free.deepl.com';
}

function normalizeProxyBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// 免費 Google 翻譯端點（無需 Key、無保證額度）：所有付費 provider 失敗或額度用盡時的最後備援
const FREE_PROVIDER_ID = 'free';
const GOOGLE_FREE_URL = 'https://translate.googleapis.com/translate_a/single';

async function googleFreeRequest(text, from, to) {
  const body = new URLSearchParams({ client: 'gtx', sl: from, tl: to, dt: 't', q: text });
  const res = await fetch(GOOGLE_FREE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`免費翻譯錯誤 ${res.status}${res.status === 429 ? '（請求過於頻繁）' : ''}`);
  const data = await res.json();
  if (!Array.isArray(data?.[0])) throw new Error('免費翻譯回應格式異常');
  return {
    text: data[0].map((seg) => seg?.[0] || '').join(''),
    detected: typeof data[2] === 'string' ? data[2] : null,
  };
}

const PROVIDERS = {
  azure: {
    id: 'azure',
    name: 'Azure Translator',
    isConfigured: (cfg) => !!cfg.azureKey,
    async translate(text, fromId, toId, cfg) {
      const from = providerLangCode('azure', fromId);
      const to = providerLangCode('azure', toId);
      if (!from || !to) throw new UnsupportedLangError('Azure 不支援此語言');
      const res = await fetch(
        `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': cfg.azureKey,
            'Ocp-Apim-Subscription-Region': cfg.azureRegion || 'southeastasia',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([{ Text: text }]),
        }
      );
      // 401/403：金鑰無效；429：超過速率；456：超出額度
      if ([401, 403, 429, 456].includes(res.status)) throw new QuotaError(`Azure 錯誤 ${res.status}`);
      if (!res.ok) throw new Error(`Azure 錯誤 ${res.status}`);
      const data = await res.json();
      return data[0].translations[0].text;
    },
    async detectLanguage(text, cfg) {
      const res = await fetch(
        'https://api.cognitive.microsofttranslator.com/detect?api-version=3.0',
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': cfg.azureKey,
            'Ocp-Apim-Subscription-Region': cfg.azureRegion || 'southeastasia',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([{ Text: text }]),
        }
      );
      if ([401, 403, 429, 456].includes(res.status)) throw new QuotaError(`Azure 偵測錯誤 ${res.status}`);
      if (!res.ok) throw new Error(`Azure 偵測錯誤 ${res.status}`);
      const data = await res.json();
      return data?.[0]?.language || null;
    },
  },

  google: {
    id: 'google',
    name: 'Google Cloud Translation',
    isConfigured: (cfg) => !!cfg.googleKey,
    async translate(text, fromId, toId, cfg) {
      const from = providerLangCode('google', fromId);
      const to = providerLangCode('google', toId);
      if (!from || !to) throw new UnsupportedLangError('Google 不支援此語言');
      const res = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(cfg.googleKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: text, source: from, target: to, format: 'text' }),
        }
      );
      if ([401, 403, 429].includes(res.status)) throw new QuotaError(`Google 錯誤 ${res.status}`);
      if (!res.ok) throw new Error(`Google 錯誤 ${res.status}`);
      const data = await res.json();
      return data.data.translations[0].translatedText;
    },
    async detectLanguage(text, cfg) {
      const res = await fetch(
        `https://translation.googleapis.com/language/translate/v2/detect?key=${encodeURIComponent(cfg.googleKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: text }),
        }
      );
      if ([401, 403, 429].includes(res.status)) throw new QuotaError(`Google 偵測錯誤 ${res.status}`);
      if (!res.ok) throw new Error(`Google 偵測錯誤 ${res.status}`);
      const data = await res.json();
      return data?.data?.detections?.[0]?.[0]?.language || null;
    },
  },

  [FREE_PROVIDER_ID]: {
    id: FREE_PROVIDER_ID,
    name: 'Google 免費翻譯',
    isConfigured: () => true,
    async translate(text, fromId, toId) {
      const from = providerLangCode('google', fromId) || 'auto';
      const to = providerLangCode('google', toId);
      if (!to) throw new UnsupportedLangError('免費翻譯不支援此語言');
      return (await googleFreeRequest(text, from, to)).text;
    },
    async detectLanguage(text) {
      return (await googleFreeRequest(text, 'auto', 'en')).detected;
    },
  },

  deepl: {
    id: 'deepl',
    name: 'DeepL',
    isConfigured: (cfg) => !!cfg.deeplKey,
    async translate(text, fromId, toId, cfg) {
      const to = providerLangCode('deepl', toId);
      if (!to) throw new UnsupportedLangError('DeepL 不支援此語言');
      // DeepL 不支援瀏覽器 CORS：有設定中繼（Cloudflare Worker）時改走中繼，由它依 Key 決定 free/pro
      const relay = String(cfg.deeplRelayUrl || '').trim().replace(/\/+$/, '');
      const host = relay || resolveDeepLHost(cfg);
      const res = await fetch(`${host}/v2/translate`, {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${cfg.deeplKey}`,
          'Content-Type': 'application/json',
        },
        // DeepL 讓來源語言自動偵測，可避免部分語言碼在 source_lang 不被接受（400）
        body: JSON.stringify({ text: [text], target_lang: to }),
      });
      // 403：金鑰無效；456：超出額度；429：請求過於頻繁
      if ([403, 429, 456].includes(res.status)) {
        if (res.status === 403) {
          throw new QuotaError('DeepL 403（請確認 Key 正確，且 Free/Pro endpoint 對應正確）');
        }
        throw new QuotaError(`DeepL 錯誤 ${res.status}`);
      }
      if (!res.ok) throw new Error(`DeepL 錯誤 ${res.status}`);
      const data = await res.json();
      return data.translations[0].text;
    },
  },
};

class Translator {
  constructor() {
    this.exhausted = new Set(); // 本次 session 中已耗盡額度的 provider
    this.lastUsed = null;
    this.onStatusChange = null; // 狀態改變時通知 UI
    this.onNotice = null; // (message) 需要提示使用者時（例如額度用盡改用免費服務）
  }

  _noticeExhausted(pid, reason) {
    this.exhausted.add(pid);
    this.onNotice?.(`${PROVIDERS[pid].name} 額度已用盡或授權失敗（${reason}），已自動切換至下一個翻譯服務。`);
    this._notify();
  }

  // 付費 provider 依設定順序，免費服務永遠排在最後當備援
  _order(cfg) {
    return [...cfg.providerOrder.filter((p) => p !== FREE_PROVIDER_ID), FREE_PROVIDER_ID];
  }

  _notify() {
    this.onStatusChange?.();
  }

  async _proxyRequest(path, payload, cfg) {
    const base = normalizeProxyBaseUrl(cfg.proxyBaseUrl);
    if (!base) throw new Error('Proxy Base URL 未設定。');
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Proxy 請求失敗 (${res.status})`);
    }
    return data;
  }

  // 回傳 { text, provider }；全部 provider（含免費備援）都失敗時拋出 Error
  async translate(text, fromId, toId, cfg) {
    const failures = [];
    if (cfg.useProxy) {
      try {
        const data = await this._proxyRequest(
          '/api/translate',
          { text, fromId, toId, runtimeConfig: this._runtimeConfig(cfg) },
          cfg
        );
        if (data.provider && this.lastUsed !== data.provider) {
          if (data.provider === FREE_PROVIDER_ID) {
            this.onNotice?.('付費翻譯服務不可用或額度用盡，已自動切換為 Google 免費翻譯。');
          }
          this.lastUsed = data.provider;
          this._notify();
        }
        return { text: data.text, provider: data.provider || null };
      } catch (err) {
        // proxy 無法使用（未啟動、全部失敗）時，由瀏覽器直連免費翻譯
        failures.push(`Proxy：${err.message}`);
        return this._translateFree(text, fromId, toId, failures);
      }
    }

    for (const pid of this._order(cfg)) {
      const provider = PROVIDERS[pid];
      if (!provider || !provider.isConfigured(cfg) || this.exhausted.has(pid)) continue;
      try {
        const out = await provider.translate(text, fromId, toId, cfg);
        if (this.lastUsed !== pid) {
          this.lastUsed = pid;
          this._notify();
        }
        return { text: out, provider: pid };
      } catch (err) {
        failures.push(`${provider.name}：${err.message}`);
        if (err instanceof QuotaError) this._noticeExhausted(pid, err.message);
      }
    }
    throw new Error(`所有翻譯服務都失敗（${failures.join('；') || '無可用服務'}）。`);
  }

  async _translateFree(text, fromId, toId, failures) {
    try {
      const out = await PROVIDERS[FREE_PROVIDER_ID].translate(text, fromId, toId);
      if (this.lastUsed !== FREE_PROVIDER_ID) {
        this.lastUsed = FREE_PROVIDER_ID;
        this._notify();
      }
      return { text: out, provider: FREE_PROVIDER_ID };
    } catch (err) {
      failures.push(`${PROVIDERS[FREE_PROVIDER_ID].name}：${err.message}`);
      throw new Error(`所有翻譯服務都失敗（${failures.join('；')}）。`);
    }
  }

  _runtimeConfig(cfg) {
    return {
      azureKey: cfg.azureKey,
      azureRegion: cfg.azureRegion,
      googleKey: cfg.googleKey,
      deeplKey: cfg.deeplKey,
      deeplPlan: cfg.deeplPlan,
      providerOrder: cfg.providerOrder,
    };
  }

  // 回傳 { langId, provider }；若無法判定語言回傳 null，不中斷主流程
  async detectLanguage(text, cfg) {
    const failures = [];
    if (cfg.useProxy) {
      try {
        const data = await this._proxyRequest(
          '/api/detect',
          { text, runtimeConfig: this._runtimeConfig(cfg) },
          cfg
        );
        if (data?.langId) {
          if (data.provider && this.lastUsed !== data.provider) {
            this.lastUsed = data.provider;
            this._notify();
          }
          return { langId: data.langId, provider: data.provider || null };
        }
      } catch (err) {
        failures.push(`Proxy：${err.message}`);
      }
      return this._detectFree(text, failures);
    }

    for (const pid of this._order(cfg)) {
      const provider = PROVIDERS[pid];
      if (!provider || !provider.isConfigured(cfg) || !provider.detectLanguage) continue;
      if (this.exhausted.has(pid)) continue;
      try {
        const providerCode = await provider.detectLanguage(text, cfg);
        const lang = findLanguageByProviderCode(pid === FREE_PROVIDER_ID ? 'google' : pid, providerCode);
        if (lang) return { langId: lang.id, provider: pid };
        failures.push(`${provider.name} 無對應語言碼 (${providerCode || 'unknown'})`);
      } catch (err) {
        failures.push(err.message || String(err));
        if (err instanceof QuotaError) this._noticeExhausted(pid, err.message);
      }
    }
    console.warn('語言偵測失敗，改用目前說話者設定語言：', failures.join('；'));
    return null;
  }

  async _detectFree(text, failures) {
    try {
      const code = await PROVIDERS[FREE_PROVIDER_ID].detectLanguage(text);
      const lang = findLanguageByProviderCode('google', code);
      if (lang) return { langId: lang.id, provider: FREE_PROVIDER_ID };
      failures.push(`免費翻譯無對應語言碼 (${code || 'unknown'})`);
    } catch (err) {
      failures.push(err.message || String(err));
    }
    console.warn('語言偵測失敗，改用目前說話者設定語言：', failures.join('；'));
    return null;
  }

  statusList(cfg) {
    const list = cfg.providerOrder.map((pid) => ({
      id: pid,
      name: PROVIDERS[pid].name,
      configured: cfg.useProxy ? true : PROVIDERS[pid].isConfigured(cfg),
      exhausted: cfg.useProxy ? false : this.exhausted.has(pid),
      active: this.lastUsed === pid,
    }));
    list.push({
      id: FREE_PROVIDER_ID,
      name: PROVIDERS[FREE_PROVIDER_ID].name,
      configured: true,
      exhausted: false,
      active: this.lastUsed === FREE_PROVIDER_ID,
    });
    return list;
  }

  // 測試單一 provider：用固定短句試譯
  async testProvider(pid, cfg) {
    if (cfg.useProxy && pid !== FREE_PROVIDER_ID) {
      const data = await this._proxyRequest(
        '/api/test',
        { provider: pid, runtimeConfig: this._runtimeConfig(cfg) },
        cfg
      );
      return data.text;
    }
    const provider = PROVIDERS[pid];
    if (!provider.isConfigured(cfg)) throw new Error('尚未輸入 API Key');
    return provider.translate('Hello', 'en', 'zh-TW', cfg);
  }
}
