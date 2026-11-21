"""Background TTS renderer: one sentence → one Opus file, with priority for what is being played."""
from __future__ import annotations

import contextlib
import io
import logging
import os
import shutil
import subprocess
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np

from .segment import chunk_for_tts, speakable

log = logging.getLogger("quasselpage.tts")

MODEL = os.environ.get("QUASSELPAGE_MODEL", "KittenML/kitten-tts-2-nano")
SAMPLE_RATE = 24000
VOICES = {
    "en": ["Danny", "Eleanor", "Martha", "Serena", "Iris", "Grace", "Edith", "Otis", "Vincent", "Max"],
    "de": ["Anna", "Mia", "Lukas", "Paul"],
}
DEFAULT_VOICE = "danny"
PAUSE_SENTENCE = 0.22
PAUSE_PARAGRAPH = 0.55


def ffmpeg_bin() -> str:
    return os.environ.get("QUASSELPAGE_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"


def _set_hf_offline(offline: bool) -> None:
    """Toggle huggingface_hub offline mode for the whole process (env + already-imported constant)."""
    os.environ["HF_HUB_OFFLINE"] = "1" if offline else "0"
    try:
        import huggingface_hub.constants as c
        c.HF_HUB_OFFLINE = offline
    except ImportError:
        pass


class Engine:
    """Lazily loaded KittenTTS model that unloads itself after idling."""

    def __init__(self, threads: int | None = None):
        self.model = None
        self.threads = threads or max(1, (os.cpu_count() or 4) // 2)
        self.last_used = 0.0

    def load(self):
        if self.model is None:
            os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
            t = time.time()
            import torch
            torch.set_num_threads(self.threads)
            from kittenml import KittenTTS
            # Use only the local HF cache (no network at all); download once if the model is missing.
            _set_hf_offline(True)
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    self.model = KittenTTS(MODEL)
                    self.model.generate("Ready.", voice=DEFAULT_VOICE)   # loads G2P + voice files
            except Exception:
                log.info("model not cached yet – downloading %s", MODEL)
                _set_hf_offline(False)
                with contextlib.redirect_stdout(io.StringIO()):
                    self.model = KittenTTS(MODEL)
                    self.model.generate("Ready.", voice=DEFAULT_VOICE)
                _set_hf_offline(True)
            log.info("TTS model %s loaded in %.1fs (%d threads)", MODEL, time.time() - t, self.threads)
        self.last_used = time.time()
        return self.model

    def unload(self):
        if self.model is not None:
            self.model = None
            import gc
            gc.collect()
            log.info("TTS model unloaded (idle)")

    def synth(self, text: str, voice: str) -> np.ndarray:
        model = self.load()
        pieces = []
        for chunk in chunk_for_tts(speakable(text)):
            if not any(c.isalnum() for c in chunk):
                continue
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    audio = model.generate(chunk, voice=voice)
            except OSError:
                # e.g. the voice file of another language is not cached yet → fetch it once
                log.info("fetching missing model files for voice %s", voice)
                _set_hf_offline(False)
                try:
                    with contextlib.redirect_stdout(io.StringIO()):
                        audio = model.generate(chunk, voice=voice)
                finally:
                    _set_hf_offline(True)
            pieces.append(np.asarray(audio, dtype=np.float32).reshape(-1))
            pieces.append(np.zeros(int(0.08 * SAMPLE_RATE), dtype=np.float32))
        self.last_used = time.time()
        return np.concatenate(pieces) if pieces else np.zeros(int(0.1 * SAMPLE_RATE), dtype=np.float32)


def encode_opus(samples: np.ndarray, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.stem + ".part.opus")
    proc = subprocess.run(
        [ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y",
         "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
         "-c:a", "libopus", "-b:a", "40k", "-application", "voip", str(tmp)],
        input=np.clip(samples, -1, 1).astype("<f4").tobytes(), capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg: " + proc.stderr.decode(errors="replace")[-400:])
    os.replace(tmp, out)


class Renderer(threading.Thread):
    """Single worker thread. Order of work:
    1. explicit urgent requests (audio requested by the player but missing),
    2. focused documents, most recently focused first: from the cursor to the end, then from the start.
    """

    def __init__(self, library, idle_unload: float = 600.0):
        super().__init__(daemon=True, name="tts-renderer")
        self.lib = library
        self.engine = Engine()
        self.cond = threading.Condition()
        self.urgent: list[tuple[str, str, int]] = []
        self.focus: OrderedDict[tuple[str, str], int] = OrderedDict()   # (doc, voice) -> cursor
        self.done: dict[tuple[str, str], set[int]] = {}
        self.failed: dict[tuple[str, str], set[int]] = {}
        self.busy: tuple[str, str, int] | None = None
        self.idle_unload = idle_unload
        self.paused = False

    # ---- bookkeeping -------------------------------------------------
    def _done_set(self, doc_id: str, voice: str) -> set[int]:
        key = (doc_id, voice)
        if key not in self.done:
            d = self.lib.audio_dir(doc_id, voice)
            ids = set()
            if d.exists():
                for p in d.glob("*.opus"):
                    if p.stem.isdigit():
                        ids.add(int(p.stem))
            self.done[key] = ids
        return self.done[key]

    def progress(self, doc_id: str, voice: str) -> int:
        with self.cond:
            return len(self._done_set(doc_id, voice))

    def forget(self, doc_id: str) -> None:
        with self.cond:
            for k in [k for k in self.done if k[0] == doc_id]:
                self.done.pop(k, None)
            for k in [k for k in self.focus if k[0] == doc_id]:
                self.focus.pop(k, None)
            self.urgent = [u for u in self.urgent if u[0] != doc_id]

    # ---- public API --------------------------------------------------
    def set_focus(self, doc_id: str, voice: str, cursor: int = 0, front: bool = True) -> None:
        with self.cond:
            key = (doc_id, voice)
            self.focus[key] = cursor
            if front:
                self.focus.move_to_end(key, last=False)
            self.cond.notify_all()

    def request(self, doc_id: str, voice: str, sid: int, timeout: float = 180.0) -> Path | None:
        path = self.lib.audio_path(doc_id, voice, sid)
        deadline = time.time() + timeout
        with self.cond:
            if sid in self._done_set(doc_id, voice) and path.exists():
                return path
            job = (doc_id, voice, sid)
            if job in self.urgent:
                self.urgent.remove(job)
            self.urgent.insert(0, job)
            self.cond.notify_all()
            while time.time() < deadline:
                if sid in self._done_set(doc_id, voice):
                    return path
                if sid in self.failed.get((doc_id, voice), ()):
                    return None
                self.cond.wait(timeout=1.0)
        return None

    def status(self) -> dict:
        with self.cond:
            return {"busy": self.busy, "loaded": self.engine.model is not None,
                    "queue": len(self.urgent), "paused": self.paused,
                    "focus": [list(k) for k in self.focus]}

    # ---- worker ------------------------------------------------------
    def _next_job(self) -> tuple[str, str, int] | None:
        while self.urgent:
            job = self.urgent.pop(0)
            if job[2] not in self._done_set(job[0], job[1]):
                return job
        if self.paused:
            return None
        for key, cursor in list(self.focus.items()):
            doc_id, voice = key
            n = self.lib.sentence_count(doc_id)
            if n is None:
                self.focus.pop(key, None)
                continue
            done = self._done_set(doc_id, voice) | self.failed.get(key, set())
            for sid in list(range(cursor, n)) + list(range(0, cursor)):
                if sid not in done:
                    return (doc_id, voice, sid)
            self.focus.pop(key, None)   # document complete
        return None

    def run(self) -> None:
        if hasattr(os, "nice"):
            with contextlib.suppress(OSError):
                os.nice(5)
        while True:
            with self.cond:
                job = self._next_job()
                while job is None:
                    self.cond.wait(timeout=30)
                    if self.engine.model is not None and time.time() - self.engine.last_used > self.idle_unload:
                        self.engine.unload()
                    job = self._next_job()
                self.busy = job
            doc_id, voice, sid = job
            ok = False
            try:
                sent = self.lib.sentence(doc_id, sid)
                if sent is not None:
                    t = time.time()
                    audio = self.engine.synth(sent["text"], voice)
                    pause = PAUSE_PARAGRAPH if sent.get("para_end") else PAUSE_SENTENCE
                    audio = np.concatenate([audio, np.zeros(int(pause * SAMPLE_RATE), dtype=np.float32)])
                    encode_opus(audio, self.lib.audio_path(doc_id, voice, sid))
                    ok = True
                    log.debug("rendered %s/%s #%d (%.1fs audio in %.1fs)", doc_id, voice, sid,
                              len(audio) / SAMPLE_RATE, time.time() - t)
            except Exception:
                log.exception("rendering %s #%d failed", doc_id, sid)
            with self.cond:
                self.busy = None
                if ok:
                    self._done_set(doc_id, voice).add(sid)
                else:
                    self.failed.setdefault((doc_id, voice), set()).add(sid)
                self.cond.notify_all()
