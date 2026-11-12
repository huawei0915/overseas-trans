// 設定存取：所有設定存於 localStorage
const CONFIG_STORAGE_KEY = 'overseas-trans-config';

// 在 localhost / 區網（自架 proxy）執行時預設啟用後端功能；
// 部署在 GitHub Pages 等純靜態環境時，預設改用瀏覽器直連 API 與不需後端的語音引擎。
const HAS_BACKEND = /^(localhost|127\.0\.0\.1|\[::1\]|(10|192\.168)\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+)$/.test(location.hostname);

// 由 .env 的 PUBLIC_* 變數經 npm run env:config / build:pages 產生（js/env-config.js），缺檔時為空
const APP_ENV = window.APP_ENV || {};
const ENV_PROXY_URL = String(APP_ENV.proxyBaseUrl || '').replace(/\/+$/, '');
const HAS_PROXY = HAS_BACKEND || !!ENV_PROXY_URL;
// 手機瀏覽器的麥克風通常不能同時給 Web Speech 辨識與錄音使用，同時開啟會讓語音轉文字失效
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isLoopbackHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

const DEFAULT_CONFIG = {
  azureKey: '',
  azureRegion: 'southeastasia',
  googleKey: '',
  deeplKey: '',
  deeplPlan: 'free', // 'free' | 'pro'
  deeplRelayUrl: APP_ENV.deeplRelayUrl || '', // 純靜態部署時，DeepL 需經由此中繼 URL（見 cloudflare-worker/）
  providerOrder: ['azure', 'google', 'deepl'],
  useProxy: APP_ENV.useProxy ?? HAS_PROXY,
  proxyBaseUrl: ENV_PROXY_URL || (HAS_BACKEND ? `http://${location.hostname}:8787` : 'http://localhost:8787'),
  ttsEngine: HAS_PROXY ? 'edge' : 'webspeech', // 'webspeech' | 'edge' | 'piper' | 'kokoro'
  langA: 'zh-TW',
  langB: 'en',
  autoSpeaker: APP_ENV.autoSpeaker ?? !IS_MOBILE, // 以 wespeaker 聲紋（瀏覽器內執行）自動分辨甲/乙方
};

// 存在設定裡的 localhost 在手機等其他裝置上會指向裝置自己：
// 有 .env 指定的後端網址就改用它，否則（區網使用）改指向提供頁面的主機
function applyEnvFixes(cfg) {
  // 手機上先前自動存下的「開啟聲紋」會讓語音辨識失效；使用者沒有自己勾選過就改回關閉
  if (IS_MOBILE && !cfg.autoSpeakerChosen) cfg.autoSpeaker = false;
  if (!cfg.deeplRelayUrl && APP_ENV.deeplRelayUrl) cfg.deeplRelayUrl = APP_ENV.deeplRelayUrl;
  try {
    const u = new URL(cfg.proxyBaseUrl);
    if (!isLoopbackHost(u.hostname) || isLoopbackHost(location.hostname)) return cfg;
    if (ENV_PROXY_URL) {
      cfg.proxyBaseUrl = ENV_PROXY_URL;
    } else if (HAS_BACKEND) {
      u.hostname = location.hostname;
      cfg.proxyBaseUrl = u.origin;
    }
  } catch {
    // 網址格式無效時維持原值
  }
  return cfg;
}

const AppConfig = {
  load() {
    try {
      const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (!raw) return applyEnvFixes({ ...DEFAULT_CONFIG });
      const parsed = JSON.parse(raw);
      const cfg = { ...DEFAULT_CONFIG, ...parsed };
      // 確保 providerOrder 合法且包含全部 provider
      const all = ['azure', 'google', 'deepl'];
      cfg.providerOrder = Array.isArray(cfg.providerOrder)
        ? [...cfg.providerOrder.filter((p) => all.includes(p)), ...all.filter((p) => !cfg.providerOrder.includes(p))]
        : [...all];
      return applyEnvFixes(cfg);
    } catch {
      return applyEnvFixes({ ...DEFAULT_CONFIG });
    }
  },

  save(cfg) {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cfg));
  },
};
