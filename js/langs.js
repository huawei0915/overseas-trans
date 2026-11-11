// 語言清單：id 供 Web Speech 辨識與 UI 使用；各 provider 欄位為其語言碼（null 表示該家不支援）。
// stt：Web Speech API 辨識用 BCP-47 locale；tts：speechSynthesis 用 locale。
const LANGUAGES = [
  { id: 'zh-TW', label: '繁體中文', stt: 'zh-TW', tts: 'zh-TW', azure: 'zh-Hant', google: 'zh-TW', deepl: 'ZH-HANT' },
  { id: 'zh-CN', label: '简体中文', stt: 'zh-CN', tts: 'zh-CN', azure: 'zh-Hans', google: 'zh-CN', deepl: 'ZH' },
  { id: 'en',    label: 'English',  stt: 'en-US', tts: 'en-US', azure: 'en',      google: 'en',    deepl: 'EN-US' },
  { id: 'ja',    label: '日本語',   stt: 'ja-JP', tts: 'ja-JP', azure: 'ja',      google: 'ja',    deepl: 'JA' },
  { id: 'ko',    label: '한국어',   stt: 'ko-KR', tts: 'ko-KR', azure: 'ko',      google: 'ko',    deepl: 'KO' },
  { id: 'es',    label: 'Español',  stt: 'es-ES', tts: 'es-ES', azure: 'es',      google: 'es',    deepl: 'ES' },
  { id: 'fr',    label: 'Français', stt: 'fr-FR', tts: 'fr-FR', azure: 'fr',      google: 'fr',    deepl: 'FR' },
  { id: 'de',    label: 'Deutsch',  stt: 'de-DE', tts: 'de-DE', azure: 'de',      google: 'de',    deepl: 'DE' },
  { id: 'pt',    label: 'Português', stt: 'pt-PT', tts: 'pt-PT', azure: 'pt',     google: 'pt',    deepl: 'PT-PT' },
  { id: 'id',    label: 'Bahasa Indonesia', stt: 'id-ID', tts: 'id-ID', azure: 'id', google: 'id', deepl: 'ID' },
  { id: 'vi',    label: 'Tiếng Việt', stt: 'vi-VN', tts: 'vi-VN', azure: 'vi',    google: 'vi',    deepl: null },
  { id: 'th',    label: 'ไทย',      stt: 'th-TH', tts: 'th-TH', azure: 'th',      google: 'th',    deepl: null },
];

function findLanguage(id) {
  return LANGUAGES.find((l) => l.id === id) || null;
}

// 取得某 provider 對應的語言碼；不支援時回傳 null
function providerLangCode(providerId, langId) {
  const lang = findLanguage(langId);
  return lang ? (lang[providerId] ?? null) : null;
}

function findLanguageByProviderCode(providerId, code) {
  if (!code) return null;
  const normalized = String(code).toLowerCase();
  return (
    LANGUAGES.find((l) => {
      const providerCode = l[providerId];
      return providerCode && String(providerCode).toLowerCase() === normalized;
    }) || null
  );
}
