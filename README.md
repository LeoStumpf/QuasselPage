# QuasselPage

Lässt dir **PDFs und Webseiten** vorlesen – lokal auf dem eigenen Rechner, ohne Cloud, FOSS (AGPL-3.0).
Du siehst beim Zuhören immer, wo im Dokument die Stimme gerade ist, und kannst per Klick an jede Stelle springen.

- PDF öffnen, **in einen Satz klicken → ab dort vorlesen**
- beim Hören wird der **aktuelle Satz im PDF markiert**, die Ansicht scrollt mit
  (bei manuellem Scrollen pausiert das Mitscrollen, „Zur aktuellen Stelle“ holt es zurück)
- Webseiten (URL) und eingefügter Text werden als lesbarer Artikel angezeigt, gleiches Prinzip
- Audio wird **im Hintergrund vorgerendert**; was noch fehlt, wird beim Abspielen sofort mit Vorrang erzeugt
- Tempo 0,75–2×, ±15 s, Satz vor/zurück, Tastatur (Leertaste, ←/→, +/−), Medientasten
- merkt sich pro Dokument die letzte Stelle („Weiterhören“)
- Reader für Querformat-Bildschirme: Seitenvorschauen links, PDF in der Mitte, rechts Player, Tempo, Stimme
  und Inhaltsverzeichnis (aus der PDF-Gliederung bzw. den Überschriften); Player wahlweise **rechts oder unten**

Alles läuft auf dem eigenen Rechner: Sprachausgabe mit **[KittenTTS 2 nano](https://huggingface.co/KittenML/kitten-tts-2-nano)**
(17 M Parameter, Apache-2.0, nur CPU, Standardstimme „Danny“; auf einem i7-8550U ca. 3–4× schneller als Echtzeit), PDF-Anzeige mit lokal mitgeliefertem **pdf.js**. Nach dem ersten Modell-Download macht
die App keine Netzanfragen mehr (außer beim Laden einer Webseite und deren Bildern).

## Einrichtung (Linux)

Voraussetzungen: Python 3.12 (z. B. `uv python install 3.12`), `ffmpeg`.

```bash
./scripts/setup-linux.sh        # .venv, torch (CPU), kittenml, spaCy-Modell, Modell-Download
./scripts/install-desktop.sh    # optional: Eintrag im Startmenü
./scripts/quasselpage           # startet den Server und öffnet den Browser
```

Die App läuft unter <http://127.0.0.1:8743/> (nur lokal erreichbar). „Beenden“ in der Bibliothek stoppt den Server.
Das TTS-Modell (~700 MB RAM) wird nach 10 min ohne Arbeit automatisch entladen.

Optionen/Umgebungsvariablen: `--port` / `QUASSELPAGE_PORT`, `--no-browser`, `-v` (Debug-Log),
`QUASSELPAGE_DATA` (Datenordner), `QUASSELPAGE_FFMPEG` (Pfad zu ffmpeg), `QUASSELPAGE_MODEL`.

## Wie es funktioniert

```
PDF ──PyMuPDF──► Wörter + Boxen ──► Kopf/Fußzeilen raus, Silbentrennung zusammenführen
                                   ──► Sätze (pysbd) mit Zeilen-Rechtecken pro Seite ──► doc.json
URL ──trafilatura──► Hauptinhalt ──► Sätze als <span data-s> ──► page.html + doc.json

Renderer-Thread (KittenTTS) ──► pro Satz eine Opus-Datei  audio/<stimme>/<satz>.opus
   Reihenfolge: angefragte Sätze > ab aktueller Position > Rest > andere Dokumente

Browser: pdf.js rendert Seiten, Highlight-Ebene aus den Rechtecken; zwei <audio>-Elemente
spielen Satz für Satz (nächster ist vorgeladen) ⇒ Sync ist exakt, kein Whisper nötig.
```

Daten liegen unter `~/.local/share/QuasselPage/` (Windows: `%LOCALAPPDATA%\QuasselPage`): je Dokument ein Ordner
mit Original, `doc.json`, `meta.json` und dem Audio-Cache.

Oberfläche: helles „Atelier Smaragd“-Design, Schriften **Inter** und **Space Grotesk** (SIL OFL 1.1, lokal unter
`web/vendor/fonts/`), App-Icon `web/icon.svg`.

## Tests

```bash
.venv/bin/python -m pytest
```

## Später / Ideen

- **Windows**: Code ist plattformneutral (pathlib, platformdirs, kein Unix-Socket, ffmpeg-Pfad konfigurierbar);
  fehlt noch ein `setup-windows.ps1` (Python 3.12 + ffmpeg via winget) und ein Test.
- **Android**: Export eines fertigen Pakets (Audio + Sync-JSON + PDF) und Abspielen im selben HTML-Player als PWA.
- Export als M4B/MP3 mit Kapitelmarken.
- OCR für gescannte PDFs (Tesseract), Wort-genaue Markierung.
- Deutsche Stimmen (Anna, Mia, Lukas, Paul) sind wählbar, aber noch nicht auf Qualität geprüft;
  die Satztrennung ist derzeit auf Englisch eingestellt.
