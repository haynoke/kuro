"""Local speech-to-text for Kuro, using faster-whisper on this PC.

server.js starts this automatically. It listens on 127.0.0.1 only.
  GET  /health      -> {"ready": true/false, "model": "..."}
  POST /transcribe  -> body is the recorded audio (webm/ogg/wav); returns {"text": "...", "seconds": 1.2}
"""
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("WHISPER_PORT", "8792"))
MODEL = os.environ.get("WHISPER_MODEL", "small.en")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")

model = None
load_error = None
lock = threading.Lock()  # one transcription at a time keeps the CPU responsive


def load_model():
    global model, load_error
    try:
        from faster_whisper import WhisperModel
        started = time.time()
        # The first run downloads the model (about 480 MB for small.en) into the Hugging Face cache.
        model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE, cpu_threads=max(2, (os.cpu_count() or 4) // 2))
        print(f"[whisper] {MODEL} ready in {time.time() - started:.1f}s", flush=True)
    except Exception as err:  # keep serving /health so the page can show the problem
        load_error = str(err)
        print(f"[whisper] could not load {MODEL}: {err}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ready": model is not None, "model": MODEL, "error": load_error})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self.reply(404, {"error": "not found"})
        if model is None:
            return self.reply(503, {"error": load_error or "The speech model is still loading. Try again in a moment."})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 25 * 1024 * 1024:
            return self.reply(400, {"error": "No audio, or the recording is too long."})
        audio = self.rfile.read(length)
        suffix = ".webm"
        kind = self.headers.get("Content-Type", "")
        if "ogg" in kind:
            suffix = ".ogg"
        elif "wav" in kind:
            suffix = ".wav"
        elif "mp4" in kind or "m4a" in kind or "aac" in kind:
            suffix = ".m4a"
        fd, path = tempfile.mkstemp(suffix=suffix)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(audio)
            started = time.time()
            with lock:
                segments, _ = model.transcribe(path, language="en", beam_size=5, vad_filter=True,
                                               condition_on_previous_text=False)
                text = " ".join(s.text.strip() for s in segments).strip()
            self.reply(200, {"text": text, "seconds": round(time.time() - started, 2)})
        except Exception as err:
            self.reply(500, {"error": f"Could not transcribe: {err}"})
        finally:
            try:
                os.remove(path)
            except OSError:
                pass


if __name__ == "__main__":
    threading.Thread(target=load_model, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[whisper] listening on 127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
