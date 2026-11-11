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

  deepl: {
    id: 'deepl',
    name: 'DeepL',
    isConfigured: (cfg) => !!cfg.deeplKey,
    async translate(text, fromId, toId, cfg) {
      const to = providerLangCode('deepl', toId);
      if (!to) throw new UnsupportedLangError('DeepL 不支援此語言');
      const host = resolveDeepLHost(cfg);
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

  // 回傳 { text, provider }；失敗時拋出 Error
  async translate(text, fromId, toId, cfg) {
    if (cfg.useProxy) {
      const data = await this._proxyRequest(
        '/api/translate',
        {
          text,
          fromId,
          toId,
          runtimeConfig: {
            azureKey: cfg.azureKey,
            azureRegion: cfg.azureRegion,
            googleKey: cfg.googleKey,
            deeplKey: cfg.deeplKey,
            deeplPlan: cfg.deeplPlan,
            providerOrder: cfg.providerOrder,
          },
        },
        cfg
      );
      if (data.provider && this.lastUsed !== data.provider) {
        this.lastUsed = data.provider;
        this._notify();
      }
      return { text: data.text, provider: data.provider || null };
    }

    let sawConfigured = false;
    let sawExhaustedConfigured = false;
    const failures = [];
    for (const pid of cfg.providerOrder) {
      const provider = PROVIDERS[pid];
      if (!provider || !provider.isConfigured(cfg)) continue;
      if (this.exhausted.has(pid)) {
        sawExhaustedConfigured = true;
        continue;
      }
      sawConfigured = true;
      try {
        const out = await provider.translate(text, fromId, toId, cfg);
        if (this.lastUsed !== pid) {
          this.lastUsed = pid;
          this._notify();
        }
        return { text: out, provider: pid };
      } catch (err) {
        if (err instanceof QuotaError) {
          this.exhausted.add(pid);
          failures.push(err.message);
          this._notify();
          continue;
        }
        if (err instanceof UnsupportedLangError) {
          failures.push(err.message);
          continue;
        }
        throw err; // 網路等非預期錯誤直接上拋
      }
    }
    if (!sawConfigured && sawExhaustedConfigured) {
      throw new Error('已設定的翻譯服務額度都已用盡，請於「設定」加入其他服務的 API Key。');
    }
    if (!sawConfigured) throw new Error('尚未設定任何翻譯 API Key，請開啟「設定」輸入。');
    throw new Error(`所有翻譯服務都失敗或額度已用盡（${failures.join('；') || '無可用服務'}）。`);
  }

  // 回傳 { langId, provider }；若無法判定語言回傳 null，不中斷主流程
  async detectLanguage(text, cfg) {
    if (cfg.useProxy) {
      const data = await this._proxyRequest(
        '/api/detect',
        {
          text,
          runtimeConfig: {
            azureKey: cfg.azureKey,
            azureRegion: cfg.azureRegion,
            googleKey: cfg.googleKey,
            deeplKey: cfg.deeplKey,
            deeplPlan: cfg.deeplPlan,
            providerOrder: cfg.providerOrder,
          },
        },
        cfg
      );
      if (!data?.langId) return null;
      if (data.provider && this.lastUsed !== data.provider) {
        this.lastUsed = data.provider;
        this._notify();
      }
      return { langId: data.langId, provider: data.provider || null };
    }

    const failures = [];
    for (const pid of cfg.providerOrder) {
      const provider = PROVIDERS[pid];
      if (!provider || !provider.isConfigured(cfg) || !provider.detectLanguage) continue;
      if (this.exhausted.has(pid)) continue;
      try {
        const providerCode = await provider.detectLanguage(text, cfg);
        const lang = findLanguageByProviderCode(pid, providerCode);
        if (lang) return { langId: lang.id, provider: pid };
        failures.push(`${provider.name} 無對應語言碼 (${providerCode || 'unknown'})`);
      } catch (err) {
        if (err instanceof QuotaError) {
          this.exhausted.add(pid);
          failures.push(err.message);
          this._notify();
          continue;
        }
        failures.push(err.message || String(err));
      }
    }
    if (failures.length) {
      console.warn('語言偵測失敗，改用目前說話者設定語言：', failures.join('；'));
    }
    return null;
  }

  statusList(cfg) {
    if (cfg.useProxy) {
      return cfg.providerOrder.map((pid) => ({
        id: pid,
        name: PROVIDERS[pid].name,
        configured: true,
        exhausted: false,
        active: this.lastUsed === pid,
      }));
    }
    return cfg.providerOrder.map((pid) => ({
      id: pid,
      name: PROVIDERS[pid].name,
      configured: PROVIDERS[pid].isConfigured(cfg),
      exhausted: this.exhausted.has(pid),
      active: this.lastUsed === pid,
    }));
  }

  // 測試單一 provider：用固定短句試譯
  async testProvider(pid, cfg) {
    if (cfg.useProxy) {
      const data = await this._proxyRequest(
        '/api/test',
        {
          provider: pid,
          runtimeConfig: {
            azureKey: cfg.azureKey,
            azureRegion: cfg.azureRegion,
            googleKey: cfg.googleKey,
            deeplKey: cfg.deeplKey,
            deeplPlan: cfg.deeplPlan,
            providerOrder: cfg.providerOrder,
          },
        },
        cfg
      );
      return data.text;
    }
    const provider = PROVIDERS[pid];
    if (!provider.isConfigured(cfg)) throw new Error('尚未輸入 API Key');
    return provider.translate('Hello', 'en', 'zh-TW', cfg);
  }
}
