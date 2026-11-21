"""`python -m quasselpage` – start the local server and open the browser."""
from __future__ import annotations

import argparse
import logging
import os
import threading
import webbrowser


def main() -> None:
    ap = argparse.ArgumentParser(prog="quasselpage", description="QuasselPage – PDFs und Webseiten lokal vorlesen lassen")
    ap.add_argument("--port", type=int, default=int(os.environ.get("QUASSELPAGE_PORT", "8743")))
    ap.add_argument("--no-browser", action="store_true", help="Browser nicht automatisch öffnen")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("quasselpage").setLevel(logging.DEBUG if args.verbose else logging.INFO)
    import uvicorn
    from .server import create_app

    url = f"http://127.0.0.1:{args.port}/"
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print(f"QuasselPage läuft auf {url}  (Strg+C beendet)")
    uvicorn.run(create_app(), host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
