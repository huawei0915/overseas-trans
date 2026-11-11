// 文字轉語音：speechSynthesis 播放佇列，避免多句重疊
class TTSPlayer {
  constructor() {
    this.supported = 'speechSynthesis' in window;
    this.queue = [];
    this.speaking = false;
    this.onStateChange = null; // (speaking: boolean)
    if (this.supported) {
      // 部分瀏覽器需先觸發 getVoices 才會載入清單
      speechSynthesis.getVoices();
      speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
    }
  }

  speak(text, lang) {
    if (!this.supported || !text) return;
    this.queue.push({ text, lang });
    this._next();
  }

  stopAll() {
    this.queue = [];
    if (this.supported) speechSynthesis.cancel();
    this.speaking = false;
    this.onStateChange?.(false);
  }

  _next() {
    if (this.speaking || this.queue.length === 0) return;
    const { text, lang } = this.queue.shift();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    const voice = this._pickVoice(lang);
    if (voice) utterance.voice = voice;

    this.speaking = true;
    this.onStateChange?.(true);
    const done = () => {
      this.speaking = false;
      this.onStateChange?.(false);
      this._next();
    };
    utterance.onend = done;
    utterance.onerror = done;
    speechSynthesis.speak(utterance);
  }

  _pickVoice(lang) {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return null;
    const normalized = (lang || '').replace('_', '-').toLowerCase();
    const prefix = normalized.split('-')[0];
    return (
      voices.find((v) => v.lang && v.lang.replace('_', '-').toLowerCase() === normalized) ||
      voices.find((v) => v.lang && v.lang.replace('_', '-').toLowerCase().startsWith(prefix)) ||
      null
    );
  }
}
