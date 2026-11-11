"""說話者辨識服務（pyannote.audio）。

以 pyannote 的 speaker embedding 模型為每一句語音取得聲紋，並在線上（online）
分群成「甲方 / 乙方」兩位說話者。前端經由 proxy 呼叫 /api/speaker/*。

POST /identify?session=<id>&enroll=1|0   body: 16 kHz mono 16-bit WAV
POST /reset?session=<id>
GET  /health
"""
import io
import json
import os
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
import torch
from pyannote.audio import Inference, Model

HOST = os.environ.get("DIARIZE_HOST", "127.0.0.1")
PORT = int(os.environ.get("DIARIZE_PORT", "8788"))
MODEL_ID = os.environ.get("DIARIZE_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")
HF_TOKEN = os.environ.get("HF_TOKEN") or None
# 餘弦相似度 >= 此值視為同一人；越高越容易判成兩個人
SAME_SPEAKER_THRESHOLD = float(os.environ.get("DIARIZE_THRESHOLD", "0.5"))
MIN_SECONDS = float(os.environ.get("DIARIZE_MIN_SECONDS", "1.0"))
MAX_SPEAKERS = 2
MAX_BODY = 8_000_000
SAMPLE_RATE = 16000

device = torch.device("mps" if False else "cpu")
print(f"[diarize] loading {MODEL_ID} ...", flush=True)
_model = Model.from_pretrained(MODEL_ID, use_auth_token=HF_TOKEN)
_inference = Inference(_model, window="whole", device=device)
_infer_lock = threading.Lock()
print("[diarize] model ready", flush=True)


class Session:
    def __init__(self):
        self.centroids = []  # list[np.ndarray]，已正規化
        self.weights = []    # 各說話者累積秒數

    def identify(self, emb, seconds, enroll):
        emb = emb / (np.linalg.norm(emb) + 1e-9)
        sims = [float(np.dot(emb, c)) for c in self.centroids]

        if not self.centroids:
            if not enroll:
                return None, sims, False
            return self._add(emb, seconds), sims, True

        best = int(np.argmax(sims))
        if sims[best] >= SAME_SPEAKER_THRESHOLD:
            speaker, created = best, False
        elif len(self.centroids) < MAX_SPEAKERS:
            if not enroll:
                return None, sims, False
            return self._add(emb, seconds), sims, True
        else:
            speaker, created = best, False

        if enroll and sims[speaker] >= SAME_SPEAKER_THRESHOLD:
            self._update(speaker, emb, seconds)
        return speaker, sims, created

    def _add(self, emb, seconds):
        self.centroids.append(emb)
        self.weights.append(seconds)
        return len(self.centroids) - 1

    def _update(self, idx, emb, seconds):
        w = self.weights[idx]
        merged = self.centroids[idx] * w + emb * seconds
        self.centroids[idx] = merged / (np.linalg.norm(merged) + 1e-9)
        self.weights[idx] = w + seconds


sessions = {}
sessions_lock = threading.Lock()


def get_session(sid):
    with sessions_lock:
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
    pcm = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    return pcm, rate


def embed(pcm, rate):
    wave_t = torch.from_numpy(pcm).unsqueeze(0)
    with _infer_lock:
        return np.asarray(_inference({"waveform": wave_t, "sample_rate": rate})).reshape(-1)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            return self._send(200, {"ok": True, "model": MODEL_ID, "threshold": SAME_SPEAKER_THRESHOLD})
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

            if url.path == "/identify":
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > MAX_BODY:
                    return self._send(400, {"error": "音訊大小無效"})
                pcm, rate = read_wav(self.rfile.read(length))
                seconds = len(pcm) / rate
                enroll = (query.get("enroll") or ["1"])[0] != "0"
                if seconds < MIN_SECONDS:
                    return self._send(200, {"speaker": None, "reason": "too_short", "seconds": seconds})
                speaker, sims, created = get_session(sid).identify(embed(pcm, rate), seconds, enroll)
                return self._send(200, {
                    "speaker": speaker,
                    "similarities": sims,
                    "created": created,
                    "seconds": seconds,
                })

            self._send(404, {"error": "Not found"})
        except Exception as err:  # noqa: BLE001
            self._send(500, {"error": str(err)})


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[diarize] listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
