"""FastAPI app: library, import, audio delivery. Binds to localhost only."""
from __future__ import annotations

import logging
import tempfile
import time
from pathlib import Path

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import extract_web
from .extract_pdf import extract_pdf
from .library import Library
from .tts import DEFAULT_VOICE, VOICES, Renderer

log = logging.getLogger("quasselpage")
WEB = Path(__file__).resolve().parent.parent / "web"


def create_app(library: Library | None = None, start_renderer: bool = True) -> FastAPI:
    lib = library or Library()
    renderer = Renderer(lib)
    app = FastAPI(title="QuasselPage", docs_url=None, redoc_url=None)
    app.state.lib = lib
    app.state.renderer = renderer

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        # Protect against DNS rebinding and cross-site requests from other web pages.
        host = (request.headers.get("host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost", "testserver"):
            return JSONResponse({"detail": "forbidden host"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and request.method != "GET":
            o = origin.split("://", 1)[-1].split(":")[0]
            if o not in ("127.0.0.1", "localhost", "testserver"):
                return JSONResponse({"detail": "forbidden origin"}, status_code=403)
        return await call_next(request)

    @app.on_event("startup")
    def _start():
        if not start_renderer:
            return
        s = lib.settings()
        renderer.paused = not s.get("background", True)
        renderer.start()
        if s.get("background", True):
            for m in reversed(lib.list()):          # most recently opened ends up in front
                if renderer.progress(m["id"], s["voice"]) < m.get("n", 0):
                    renderer.set_focus(m["id"], s["voice"], m.get("position", 0))

    def voice_of(voice: str | None) -> str:
        v = (voice or lib.settings().get("voice") or DEFAULT_VOICE).lower()
        if not any(v == x.lower() for xs in VOICES.values() for x in xs):
            raise HTTPException(400, "unknown voice")
        return v

    def need(doc_id: str) -> dict:
        try:
            meta = lib.meta(doc_id)
        except KeyError:
            meta = None
        if meta is None:
            raise HTTPException(404, "document not found")
        return meta

    def with_progress(meta: dict) -> dict:
        v = lib.settings()["voice"]
        return {**meta, "rendered": renderer.progress(meta["id"], v)}

    # ---- pages -------------------------------------------------------
    @app.get("/")
    def index():
        return FileResponse(WEB / "index.html")

    @app.get("/reader/{doc_id}")
    def reader(doc_id: str):
        need(doc_id)
        return FileResponse(WEB / "reader.html")

    # ---- settings / status -------------------------------------------
    @app.get("/api/settings")
    def get_settings():
        return {**lib.settings(), "voices": VOICES}

    @app.post("/api/settings")
    def set_settings(changes: dict = Body(...)):
        if "voice" in changes:
            changes["voice"] = voice_of(changes["voice"])
        s = lib.save_settings(changes)
        renderer.paused = not s.get("background", True)
        with renderer.cond:
            renderer.cond.notify_all()
        return {**s, "voices": VOICES}

    @app.get("/api/status")
    def status():
        return renderer.status()

    # ---- library -----------------------------------------------------
    @app.get("/api/docs")
    def list_docs():
        return [with_progress(m) for m in lib.list()]

    @app.get("/api/docs/{doc_id}")
    def get_doc(doc_id: str):
        meta = need(doc_id)
        doc = lib.doc(doc_id)
        lib.update_meta(doc_id, opened=time.time())
        return {"meta": with_progress(meta), "doc": doc}

    @app.delete("/api/docs/{doc_id}")
    def delete_doc(doc_id: str):
        need(doc_id)
        renderer.forget(doc_id)
        lib.delete(doc_id)
        return {"ok": True}

    @app.get("/api/docs/{doc_id}/source.pdf")
    def source_pdf(doc_id: str):
        need(doc_id)
        p = lib.dir(doc_id) / "source.pdf"
        if not p.exists():
            raise HTTPException(404)
        return FileResponse(p, media_type="application/pdf")

    @app.get("/api/docs/{doc_id}/page.html")
    def page_html(doc_id: str):
        need(doc_id)
        p = lib.dir(doc_id) / "page.html"
        if not p.exists():
            raise HTTPException(404)
        return FileResponse(p, media_type="text/html; charset=utf-8")

    @app.get("/api/docs/{doc_id}/original.html")
    def original_html(doc_id: str):
        """The original web page (stylesheets inlined, scripts removed) for the sandboxed viewer.
        Documents imported before this existed fetch it once on first use."""
        meta = need(doc_id)
        p = lib.dir(doc_id) / "original.html"
        if not p.exists():
            if not meta.get("url"):
                raise HTTPException(404, "kein Original vorhanden")
            try:
                p.write_text(extract_web.fetch_original(meta["url"]), encoding="utf-8")
            except Exception as e:
                raise HTTPException(502, f"Original konnte nicht geladen werden: {e}")
        html = extract_web.prepare_original(p.read_text(encoding="utf-8"), meta.get("url"))
        return Response(html, media_type="text/html; charset=utf-8", headers={
            "Content-Security-Policy": "script-src 'none'; object-src 'none'; frame-src 'none'; "
                                       "form-action 'none'; worker-src 'none'",
            "Cache-Control": "no-store",
        })

    @app.get("/api/docs/{doc_id}/rendered")
    def rendered(doc_id: str, voice: str | None = None):
        need(doc_id)
        v = voice_of(voice)
        with renderer.cond:
            return sorted(renderer._done_set(doc_id, v))

    @app.post("/api/docs/{doc_id}/position")
    def position(doc_id: str, body: dict = Body(...)):
        meta = need(doc_id)
        sid = max(0, min(int(body.get("sid", 0)), meta["n"] - 1))
        lib.update_meta(doc_id, position=sid)
        if body.get("playing", True):
            renderer.set_focus(doc_id, voice_of(body.get("voice")), sid)
        return {"ok": True}

    @app.get("/api/docs/{doc_id}/audio/{sid}")
    def audio(doc_id: str, sid: int, voice: str | None = None):
        meta = need(doc_id)
        if not 0 <= sid < meta["n"]:
            raise HTTPException(404)
        v = voice_of(voice)
        path = renderer.request(doc_id, v, sid)
        if path is None or not path.exists():
            raise HTTPException(503, "rendering failed")
        return FileResponse(path, media_type="audio/ogg",
                            headers={"Cache-Control": "private, max-age=86400"})

    # ---- import ------------------------------------------------------
    def _import_pdf_bytes(data: bytes, name: str) -> dict:
        if not data.startswith(b"%PDF"):
            raise HTTPException(400, "Das ist keine PDF-Datei.")
        with tempfile.TemporaryDirectory(dir=lib.root.parent) as td:
            p = Path(td) / (Path(name).name or "document.pdf")
            p.write_bytes(data)
            try:
                extracted = extract_pdf(p)
            except Exception as e:
                raise HTTPException(400, f"PDF konnte nicht gelesen werden: {e}")
        if not extracted["sentences"]:
            raise HTTPException(400, "Die PDF enthält keinen Text (gescannt?). OCR wird noch nicht unterstützt.")
        doc_id = lib.create(extracted, source=data)
        _queue(doc_id)
        return with_progress(lib.meta(doc_id))

    def _queue(doc_id: str):
        s = lib.settings()
        renderer.set_focus(doc_id, s["voice"], lib.meta(doc_id).get("position", 0))

    @app.post("/api/import/pdf")
    def import_pdf(file: UploadFile = File(...)):
        data = file.file.read()
        return _import_pdf_bytes(data, file.filename or "document.pdf")

    @app.post("/api/import/url")
    def import_url(body: dict = Body(...)):
        url = (body.get("url") or "").strip()
        if not url:
            raise HTTPException(400, "URL fehlt.")
        try:
            extracted = extract_web.from_url(url)
        except extract_web.IsPdf as pdf:
            return _import_pdf_bytes(pdf.data, url.rstrip("/").rsplit("/", 1)[-1] + ".pdf")
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(400, f"Seite konnte nicht geladen werden: {e}")
        doc_id = lib.create(extracted)
        _queue(doc_id)
        return with_progress(lib.meta(doc_id))

    @app.post("/api/import/text")
    def import_text(body: dict = Body(...)):
        text = body.get("text") or ""
        title = (body.get("title") or "").strip() or text.strip().split("\n", 1)[0][:60] or "Text"
        try:
            extracted = extract_web.from_text(text, title)
        except ValueError as e:
            raise HTTPException(400, str(e))
        doc_id = lib.create(extracted)
        _queue(doc_id)
        return with_progress(lib.meta(doc_id))

    @app.post("/api/quit")
    def quit_app():
        import os
        import threading
        threading.Timer(0.3, lambda: os._exit(0)).start()
        return {"ok": True}

    @app.get("/favicon.ico")
    def favicon():
        return Response(status_code=204)

    app.mount("/static", StaticFiles(directory=WEB), name="static")
    return app
