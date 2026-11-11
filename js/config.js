// 設定存取：所有設定存於 localStorage
const CONFIG_STORAGE_KEY = 'overseas-trans-config';

// 在 localhost / 區網（自架 proxy）執行時預設啟用後端功能；
// 部署在 GitHub Pages 等純靜態環境時，預設改用瀏覽器直連 API 與不需後端的語音引擎。
const HAS_BACKEND = /^(localhost|127\.0\.0\.1|\[::1\]|(10|192\.168)\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+)$/.test(location.hostname);

const DEFAULT_CONFIG = {
  azureKey: '',
  azureRegion: 'southeastasia',
  googleKey: '',
  deeplKey: '',
  deeplPlan: 'free', // 'free' | 'pro'
  providerOrder: ['azure', 'google', 'deepl'],
  useProxy: HAS_BACKEND,
  proxyBaseUrl: 'http://localhost:8787',
  ttsEngine: HAS_BACKEND ? 'edge' : 'webspeech', // 'webspeech' | 'edge' | 'piper' | 'kokoro'
  langA: 'zh-TW',
  langB: 'en',
  autoSpeaker: HAS_BACKEND, // 以 pyannote.audio 聲紋自動分辨甲/乙方
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
