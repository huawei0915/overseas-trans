"""語音辨識 + 說話者辨識服務（faster-whisper + wespeaker ONNX）。

手機只負責錄音與切句，每一句語音傳到這裡，由伺服器一次完成：
  1. 語音轉文字（faster-whisper；語言限定在甲/乙雙方語言內擇一）
  2. 聲紋擷取（wespeaker ResNet34-LM，ONNX）並線上分群成甲/乙兩位說話者
前端經由 proxy 呼叫 /api/speaker/*，完全不需要使用者自己的電腦。

POST /transcribe?session=<id>&langs=<甲方語言>,<乙方語言>&mode=voice|language&prior=a|b&enroll=1|0
                                                          body: 16 kHz mono 16-bit WAV
POST /identify?session=<id>&enroll=1|0&prior=a|b          body: 同上（只做聲紋，不轉文字）
回傳 speaker：0 = 甲方、1 = 乙方。
POST /reset?session=<id>
GET  /health
"""
import io
import json
import os
import threading
import time
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import kaldi_native_fbank as knf
import numpy as np
import onnxruntime as ort
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions, collect_chunks, get_speech_timestamps

HOST = os.environ.get("DIARIZE_HOST", "127.0.0.1")
PORT = int(os.environ.get("DIARIZE_PORT", "8788"))
ROOT = Path(__file__).resolve().parent.parent
SPEAKER_MODEL_PATH = Path(os.environ.get("SPEAKER_MODEL_PATH", ROOT / "models/wespeaker/voxceleb_resnet34_LM.onnx"))
SPEAKER_MODEL_URL = os.environ.get(
    "SPEAKER_MODEL_URL",
    "https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/main/voxceleb_resnet34_LM.onnx",
)
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")  # tiny / base / small / medium / large-v3
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
WHISPER_THREADS = int(os.environ.get("WHISPER_THREADS", "0"))  # 0 = 自動
# 餘弦相似度 >= 此值視為同一人；越高越容易判成兩個人
SAME_SPEAKER_THRESHOLD = float(os.environ.get("DIARIZE_THRESHOLD", "0.5"))
MIN_SECONDS = float(os.environ.get("DIARIZE_MIN_SECONDS", "1.0"))  # 有人聲的部分至少要這麼長才取聲紋
LANG_CONFIDENT = float(os.environ.get("DIARIZE_LANG_CONFIDENCE", "0.8"))
MAX_SECONDS = 30
MAX_BODY = 8_000_000
SAMPLE_RATE = 16000
SESSION_TTL = 6 * 3600

state = {"ready": False, "error": None}
_speaker_session = None
_whisper = None
_speaker_lock = threading.Lock()
_whisper_lock = threading.Lock()


def log(msg):
    print(f"[diarize] {msg}", flush=True)


def ensure_speaker_model():
    if SPEAKER_MODEL_PATH.exists() and SPEAKER_MODEL_PATH.stat().st_size > 0:
        return
    log(f"downloading speaker model -> {SPEAKER_MODEL_PATH}")
    SPEAKER_MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = SPEAKER_MODEL_PATH.with_suffix(".part")
    urllib.request.urlretrieve(SPEAKER_MODEL_URL, tmp)
    tmp.replace(SPEAKER_MODEL_PATH)


def load_models():
    global _speaker_session, _whisper
    try:
        ensure_speaker_model()
        _speaker_session = ort.InferenceSession(str(SPEAKER_MODEL_PATH), providers=["CPUExecutionProvider"])
        log(f"speaker model ready; loading whisper '{WHISPER_MODEL}' ({WHISPER_COMPUTE}) ...")
        _whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type=WHISPER_COMPUTE, cpu_threads=WHISPER_THREADS)
        # 暖機：第一次推論會比較慢，先跑掉
        segments, _ = _whisper.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language="en")
        list(segments)
        state["ready"] = True
        log("models ready")
    except Exception as err:  # noqa: BLE001
        state["error"] = str(err)
        log(f"model loading failed: {err}")


def fbank(pcm):
    """與 wespeaker 的 kaldi fbank（80 bins、25/10 ms、hamming、整段去平均）一致。"""
    opts = knf.FbankOptions()
    opts.frame_opts.samp_freq = SAMPLE_RATE
    opts.frame_opts.dither = 0.0
    opts.frame_opts.window_type = "hamming"
    opts.mel_opts.num_bins = 80
    opts.mel_opts.low_freq = 20
    opts.energy_floor = 0.0
    extractor = knf.OnlineFbank(opts)
    extractor.accept_waveform(SAMPLE_RATE, (pcm * 32768).tolist())
    extractor.input_finished()
    frames = [extractor.get_frame(i) for i in range(extractor.num_frames_ready)]
    if not frames:
        return None
    feats = np.stack(frames).astype(np.float32)
    return feats - feats.mean(axis=0, keepdims=True)


def speech_only(pcm):
    """只留有人聲的片段：切掉前後靜音與雜音，聲紋才不會被稀釋。"""
    try:
        chunks = get_speech_timestamps(pcm, VadOptions())
        if chunks:
            parts, _ = collect_chunks(pcm, chunks)
            return np.concatenate(parts) if parts else pcm
    except Exception as err:  # noqa: BLE001
        log(f"vad failed, using full audio: {err}")
    return pcm


def embed(pcm):
    pcm = speech_only(pcm)
    if len(pcm) < MIN_SECONDS * SAMPLE_RATE:
        return None
    feats = fbank(pcm)
    if feats is None:
        return None
    with _speaker_lock:
        out = _speaker_session.run(None, {"feats": feats[None]})[0]
    return np.asarray(out).reshape(-1)


class Session:
    """兩個說話者欄位：0 = 甲方、1 = 乙方，各自累積一個聲紋中心（centroid）。"""

    def __init__(self):
        self.centroids = [None, None]
        self.weights = [0.0, 0.0]
        self.touched = time.time()

    def identify(self, emb, seconds, enroll, label=None, prior=0):
        """回傳 (欄位, 與兩欄的相似度[None 表示該欄尚無聲紋])。

        label：已知是誰（語言優先模式下由語言決定）→ 直接登錄到該欄。
        prior：完全沒有聲紋可比對時，第一位說話者歸給哪一欄。
        """
        self.touched = time.time()
        emb = emb / (np.linalg.norm(emb) + 1e-9)
        sims = [None if c is None else float(np.dot(emb, c)) for c in self.centroids]
        filled = [i for i, c in enumerate(self.centroids) if c is not None]

        if label is not None:
            speaker = label
        elif not filled:
            speaker = prior
        elif len(filled) == 1:
            # 只認識一個人：像他就是他，不像就是另一位（對話只有兩個人）
            speaker = filled[0] if sims[filled[0]] >= SAME_SPEAKER_THRESHOLD else 1 - filled[0]
        else:
            speaker = 0 if sims[0] >= sims[1] else 1

        if enroll:
            if label is not None or sims[speaker] is None or sims[speaker] >= SAME_SPEAKER_THRESHOLD or len(filled) < 2:
                self._update(speaker, emb, seconds)
        return speaker, sims

    def _update(self, idx, emb, seconds):
        if self.centroids[idx] is None:
            self.centroids[idx] = emb
            self.weights[idx] = seconds
            return
        w = self.weights[idx]
        merged = self.centroids[idx] * w + emb * seconds
        self.centroids[idx] = merged / (np.linalg.norm(merged) + 1e-9)
        self.weights[idx] = w + seconds


sessions = {}
sessions_lock = threading.Lock()


def get_session(sid):
    now = time.time()
    with sessions_lock:
        for key in [k for k, s in sessions.items() if now - s.touched > SESSION_TTL]:
            del sessions[key]
        if sid not in sessions:
            sessions[sid] = Session()
        return sessions[sid]


def read_wav(data):
    with wave.open(io.BytesIO(data), "rb") as wf:
        if wf.getsampwidth() != 2:
            raise ValueError("僅支援 16-bit PCM WAV")
        channels = wf.getnchannels()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    if rate != SAMPLE_RATE:
        raise ValueError("僅支援 16 kHz WAV")
    pcm = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    return pcm[-MAX_SECONDS * SAMPLE_RATE:]


def parse_langs(raw):
    """'zh-TW,en' → [('zh-TW', 'zh'), ('en', 'en')]：依序為甲、乙方的前端語言代碼與 whisper 語言碼。"""
    out = []
    for tag in (raw or "").split(",")[:2]:
        tag = tag.strip()
        if tag:
            out.append((tag, tag.split("-")[0].lower()))
    return out


def transcribe(pcm, langs):
    """回傳 (text, 語言欄位 0/1 或 None, 語言信心)。

    語言限定在 langs（甲/乙方語言）內：偵測後取機率較高者，信心為其在候選語言中的占比。
    雙方語言碼相同（例如 zh-TW 與 zh-CN）時無法靠語言分辨，語言欄位為 None。
    """
    codes = list(dict.fromkeys(code for _, code in langs))
    index, confidence = None, 1.0
    with _whisper_lock:
        if len(codes) == 1:
            language = codes[0]
        elif len(codes) > 1:
            _, _, probs = _whisper.detect_language(pcm)
            scores = dict(probs)
            language = max(codes, key=lambda c: scores.get(c, 0.0))
            total = sum(scores.get(c, 0.0) for c in codes)
            confidence = scores.get(language, 0.0) / total if total > 0 else 0.5
            index = next(i for i, (_, code) in enumerate(langs) if code == language)
        else:
            language = None
        prompt = None
        if language == "zh":
            tag = next(t for t, code in langs if code == "zh")
            prompt = "以下是繁體中文的句子。" if tag == "zh-TW" else "以下是简体中文的句子。"
        segments, _ = _whisper.transcribe(
            pcm,
            language=language,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
            initial_prompt=prompt,
        )
        kept = [s.text.strip() for s in segments if s.no_speech_prob < 0.6]
    return " ".join(t for t in kept if t).strip(), index, confidence


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            return self._send(200, {
                "ok": state["error"] is None,
                "ready": state["ready"],
                "error": state["error"],
                "whisper": WHISPER_MODEL,
                "threshold": SAME_SPEAKER_THRESHOLD,
            })
        self._send(404, {"error": "Not found"})

    def do_POST(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        sid = (query.get("session") or ["default"])[0]
        try:
            if url.path == "/reset":
                with sessions_lock:
                    sessions.pop(sid, None)
                return self._send(200, {"ok": True})

            if url.path in ("/identify", "/transcribe"):
                if not state["ready"]:
                    return self._send(503, {"error": state["error"] or "模型載入中，請稍候", "loading": state["error"] is None})
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > MAX_BODY:
                    return self._send(400, {"error": "音訊大小無效"})
                pcm = read_wav(self.rfile.read(length))
                seconds = len(pcm) / SAMPLE_RATE
                enroll = (query.get("enroll") or ["1"])[0] != "0"

                result = {"seconds": seconds, "speaker": None}
                lang_party = None
                if url.path == "/transcribe":
                    langs = parse_langs((query.get("langs") or [""])[0])
                    text, lang_index, confidence = transcribe(pcm, langs)
                    result.update(text=text, language_party=lang_index, language_confidence=confidence)
                    if not text:
                        return self._send(200, result)
                    if lang_index is not None and confidence >= LANG_CONFIDENT:
                        lang_party = lang_index

                # mode=language：語言夠有把握時直接以語言決定；mode=voice：以聲紋為主，語言只用來確認「某一方第一次出現」
                mode = (query.get("mode") or ["voice"])[0]
                prior = 1 if (query.get("prior") or ["a"])[0] == "b" else 0
                session = get_session(sid)
                label = None
                if lang_party is not None:
                    prior = lang_party
                    # 語言有把握、且該方還沒有聲紋（第一次聽到他的語言）→ 可確定他在場，直接登錄，避免被誤併入另一人
                    if mode == "language" or session.centroids[lang_party] is None:
                        label = lang_party

                emb = embed(pcm) if seconds >= MIN_SECONDS else None
                if emb is None:
                    # 音訊太短取不到聲紋：只能靠語言（若有把握）
                    result.update(reason="too_short", speaker=lang_party, source="language" if lang_party is not None else None)
                    return self._send(200, result)
                speaker, sims = session.identify(emb, seconds, enroll, label, prior)
                source = "language" if label is not None else "voice"
                result.update(speaker=speaker, similarities=sims, source=source)
                return self._send(200, result)

            self._send(404, {"error": "Not found"})
        except Exception as err:  # noqa: BLE001
            self._send(500, {"error": str(err)})


if __name__ == "__main__":
    threading.Thread(target=load_models, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log(f"listening on http://{HOST}:{PORT}")
    server.serve_forever()
