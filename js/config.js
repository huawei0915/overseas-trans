// 設定存取：所有設定存於 localStorage
const CONFIG_STORAGE_KEY = 'overseas-trans-config';

const DEFAULT_CONFIG = {
  azureKey: '',
  azureRegion: 'southeastasia',
  googleKey: '',
  deeplKey: '',
  deeplPlan: 'free', // 'free' | 'pro'
  providerOrder: ['azure', 'google', 'deepl'],
  useProxy: true,
  proxyBaseUrl: 'http://localhost:8787',
  langA: 'zh-TW',
  langB: 'en',
};

const AppConfig = {
  load() {
    try {
      const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (!raw) return { ...DEFAULT_CONFIG };
      const parsed = JSON.parse(raw);
      const cfg = { ...DEFAULT_CONFIG, ...parsed };
      // 確保 providerOrder 合法且包含全部 provider
      const all = ['azure', 'google', 'deepl'];
      cfg.providerOrder = Array.isArray(cfg.providerOrder)
        ? [...cfg.providerOrder.filter((p) => all.includes(p)), ...all.filter((p) => !cfg.providerOrder.includes(p))]
        : [...all];
      return cfg;
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  },

  save(cfg) {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cfg));
  },
};
