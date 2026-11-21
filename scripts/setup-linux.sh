#!/usr/bin/env bash
# Sets up .venv for QuasselPage (Python 3.12 is required by kittenml/misaki).
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3.12 "$HOME"/.local/share/uv/python/cpython-3.12*/bin/python3.12; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then PY="$c"; break; fi
  done
fi
if [ -z "$PY" ]; then
  echo "Python 3.12 nicht gefunden. Installieren z. B. mit: uv python install 3.12  (oder PYTHON=/pfad/python3.12 setzen)" >&2
  exit 1
fi
command -v ffmpeg >/dev/null || { echo "ffmpeg fehlt (sudo apt install ffmpeg)" >&2; exit 1; }

"$PY" -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q torch --index-url https://download.pytorch.org/whl/cpu   # CPU-only, small
.venv/bin/pip install -q -e ".[test]"
.venv/bin/pip uninstall -y -q torchaudio 2>/dev/null || true                    # CUDA build breaks import
.venv/bin/python -m spacy download en_core_web_sm -q
# first model download (afterwards the app runs fully offline)
.venv/bin/python -c "from quasselpage.tts import Engine; Engine().load(); print('TTS-Modell bereit.')"
echo "Fertig. Start: ./scripts/quasselpage   (oder .venv/bin/python -m quasselpage)"
