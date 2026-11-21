"""On-disk document library (platform-neutral paths via platformdirs)."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
from pathlib import Path

from platformdirs import user_data_dir


def data_root() -> Path:
    root = os.environ.get("QUASSELPAGE_DATA")
    return Path(root) if root else Path(user_data_dir("QuasselPage", appauthor=False))


def _write_json(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


class Library:
    def __init__(self, root: Path | None = None):
        self.root = (root or data_root()) / "library"
        self.root.mkdir(parents=True, exist_ok=True)
        self.settings_path = self.root.parent / "settings.json"
        self._lock = threading.Lock()
        self._cache: dict[str, dict] = {}

    # ---- settings ----------------------------------------------------
    def settings(self) -> dict:
        base = {"voice": "danny", "rate": 1.0, "autoscroll": True, "background": True}
        try:
            base.update(json.loads(self.settings_path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
        return base

    def save_settings(self, changes: dict) -> dict:
        s = self.settings()
        s.update({k: v for k, v in changes.items() if k in s})
        _write_json(self.settings_path, s)
        return s

    # ---- documents ---------------------------------------------------
    def dir(self, doc_id: str) -> Path:
        if not doc_id.isalnum():
            raise KeyError(doc_id)
        return self.root / doc_id

    def audio_dir(self, doc_id: str, voice: str) -> Path:
        return self.dir(doc_id) / "audio" / voice.lower()

    def audio_path(self, doc_id: str, voice: str, sid: int) -> Path:
        return self.audio_dir(doc_id, voice) / f"{sid}.opus"

    def create(self, extracted: dict, source: bytes | None = None, source_name: str = "source.pdf") -> str:
        h = hashlib.sha1()
        h.update(source if source is not None else json.dumps(extracted["sentences"]).encode())
        doc_id = h.hexdigest()[:12]
        d = self.dir(doc_id)
        d.mkdir(parents=True, exist_ok=True)
        if source is not None:
            (d / source_name).write_bytes(source)
        html = extracted.pop("html", None)
        if html is not None:
            (d / "page.html").write_text(html, encoding="utf-8")
        original = extracted.pop("original", None)
        if original is not None:
            (d / "original.html").write_text(original, encoding="utf-8")
        _write_json(d / "doc.json", extracted)
        meta = self.meta(doc_id) or {}
        now = time.time()
        meta.update({
            "id": doc_id, "title": extracted["title"], "kind": extracted["kind"],
            "url": extracted.get("url"), "n": len(extracted["sentences"]),
            "pages": len(extracted.get("pages", [])), "scanned": extracted.get("scanned", False),
        })
        meta.setdefault("created", now)
        meta.setdefault("position", 0)
        meta["opened"] = now
        _write_json(d / "meta.json", meta)
        self._cache.pop(doc_id, None)
        return doc_id

    def meta(self, doc_id: str) -> dict | None:
        try:
            return json.loads((self.dir(doc_id) / "meta.json").read_text(encoding="utf-8"))
        except (OSError, ValueError, KeyError):
            return None

    def update_meta(self, doc_id: str, **changes) -> dict | None:
        with self._lock:
            meta = self.meta(doc_id)
            if meta is None:
                return None
            meta.update(changes)
            _write_json(self.dir(doc_id) / "meta.json", meta)
            return meta

    def list(self) -> list[dict]:
        out = []
        for d in self.root.iterdir():
            if d.is_dir():
                m = self.meta(d.name)
                if m:
                    out.append(m)
        out.sort(key=lambda m: m.get("opened", 0), reverse=True)
        return out

    def doc(self, doc_id: str) -> dict | None:
        if doc_id not in self._cache:
            try:
                self._cache[doc_id] = json.loads((self.dir(doc_id) / "doc.json").read_text(encoding="utf-8"))
            except (OSError, ValueError, KeyError):
                return None
        return self._cache[doc_id]

    def sentence(self, doc_id: str, sid: int) -> dict | None:
        d = self.doc(doc_id)
        if d is None or not 0 <= sid < len(d["sentences"]):
            return None
        return d["sentences"][sid]

    def sentence_count(self, doc_id: str) -> int | None:
        d = self.doc(doc_id)
        return None if d is None else len(d["sentences"])

    def delete(self, doc_id: str) -> None:
        self._cache.pop(doc_id, None)
        shutil.rmtree(self.dir(doc_id), ignore_errors=True)
