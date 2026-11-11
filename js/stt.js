// 語音辨識：Web Speech API + 5 秒靜音自動結句
// callbacks: { onInterim(text), onSpeechStart(startMs), onUtterance(text, { startMs, endMs }), onError(code), onStateChange(listening) }

const SILENCE_MS = 5000;

class SpeechEngine {
  constructor() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.SR = SR || null;
    this.supported = !!SR;
    this.active = false;
    this.paused = false;
    this.lang = null;
    this.rec = null;
    this.timer = null;
    this.finalText = '';
    this.interimText = '';
    this.startMs = 0;   // 本句第一次收到辨識結果的時間
    this.lastMs = 0;    // 本句最後一次收到辨識結果的時間
    this.callbacks = {};
  }

  // 丟棄尚未結句的文字（例如發現說話者／語言切換，原本以錯誤語言辨識出的內容）
  discardPending() {
    this._clearTimer();
    this.finalText = '';
    this.interimText = '';
    this.startMs = 0;
  }

  start(lang, callbacks) {
    if (!this.supported) return;
    this._teardown();
    this.lang = lang;
    this.callbacks = callbacks || {};
    this.finalText = '';
    this.interimText = '';
    this.active = true;
    this._spawn();
    this.callbacks.onStateChange?.(true);
  }

  stop() {
    this.active = false;
    this.paused = false;
    this._clearTimer();
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      try { rec.stop(); } catch { /* 已停止 */ }
    }
    this._flush();
    this.callbacks.onStateChange?.(false);
  }

  // 暫停辨識（例如播放譯文語音時），丟棄暫存避免把喇叭聲音辨識進來
  pause() {
    if (!this.active || this.paused) return;
    this.paused = true;
    this._clearTimer();
    this.finalText = '';
    this.interimText = '';
    this.startMs = 0;
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      try { rec.stop(); } catch { /* 已停止 */ }
    }
  }

  // 恢復辨識（接續同一個聆聽 session）
  resume() {
    if (!this.active || !this.paused) return;
    this.paused = false;
    this._spawn();
  }

  _teardown() {
    this.active = false;
    this.paused = false;
    this._clearTimer();
    if (this.rec) {
      const rec = this.rec;
      this.rec = null;
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      try { rec.stop(); } catch { /* 已停止 */ }
    }
  }

  _spawn() {
    const rec = new this.SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (event) => {
      const now = Date.now();
      if (!this.startMs) {
        this.startMs = now;
        this.callbacks.onSpeechStart?.(now);
      }
      this.lastMs = now;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) this.finalText += event.results[i][0].transcript;
        else interim += event.results[i][0].transcript;
      }
      this.interimText = interim;
      this.callbacks.onInterim?.((this.finalText + interim).trim());
      this._resetTimer();
    };

    rec.onerror = (event) => {
      this.callbacks.onError?.(event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.active = false;
        this._clearTimer();
        this.callbacks.onStateChange?.(false);
      }
      // 'no-speech'、'audio-capture' 等交由 onend 自動重啟處理
    };

    rec.onend = () => {
      // 瀏覽器會在靜音後自動停止；仍處於聆聽狀態時自動重啟以維持連續辨識
      if (this.active && !this.paused) {
        this._spawn();
      } else if (!this.active) {
        this.rec = null;
      }
    };

    this.rec = rec;
    try {
      rec.start();
    } catch {
      // 極少數情況 start 拋錯（例如短時間內重複啟動），稍後重試
      setTimeout(() => {
        if (this.active && this.rec === rec) {
          try { rec.start(); } catch { /* 放棄本次 */ }
        }
      }, 200);
    }
  }

  _resetTimer() {
    this._clearTimer();
    this.timer = setTimeout(() => this._flush(), SILENCE_MS);
  }

  _clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // 靜音 5 秒（或手動停止）→ 結束這一句，進入翻譯
  _flush() {
    this._clearTimer();
    const text = (this.finalText + this.interimText).trim();
    this.finalText = '';
    this.interimText = '';
    const meta = { startMs: this.startMs, endMs: this.lastMs };
    this.startMs = 0;
    if (text) this.callbacks.onUtterance?.(text, meta);
  }
}
