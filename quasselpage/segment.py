"""Sentence segmentation and text cleanup shared by the PDF and web importers."""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

import pysbd


@lru_cache(maxsize=8)
def _segmenter(lang: str) -> pysbd.Segmenter:
    try:
        return pysbd.Segmenter(language=lang, clean=False, char_span=True)
    except ValueError:
        return pysbd.Segmenter(language="en", clean=False, char_span=True)


def normalize(text: str) -> str:
    """Unicode cleanup for display text (ligatures, odd spaces)."""
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("­", "")  # soft hyphen
    return re.sub(r"[ \t ]+", " ", text).strip()


def split_sentences(text: str, lang: str = "en") -> list[tuple[int, int]]:
    """Return (start, end) character spans of sentences in `text` (whitespace trimmed)."""
    spans = []
    for seg in _segmenter(lang).segment(text):
        start, end = seg.start, seg.end
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        if end > start:
            spans.append((start, end))
    # pysbd sometimes yields a lone closing quote/bracket; glue it to the previous sentence
    merged: list[tuple[int, int]] = []
    for s, e in spans:
        if merged and not re.search(r"\w", text[s:e]):
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    # leading citation markers ("[2] Next sentence") belong to the previous sentence
    fixed: list[tuple[int, int]] = []
    for s, e in merged:
        m = re.match(r"(?:\[[^\]\s]{1,20}\]|\[citation needed\])\s*", text[s:e], re.I)
        if fixed and m and m.end() < e - s:
            prev_s, _ = fixed[-1]
            fixed[-1] = (prev_s, s + len(m.group(0).rstrip()))
            s += m.end()
        fixed.append((s, e))
    merged = fixed
    # very short fragments ("e.g." splits, "Fig.") are merged into the following sentence
    out: list[tuple[int, int]] = []
    carry = None
    for s, e in merged:
        if carry is not None:
            s = carry
            carry = None
        if len(text[s:e]) < 4 and (s, e) != merged[-1]:
            carry = s
            continue
        out.append((s, e))
    if carry is not None:
        out.append((carry, merged[-1][1]))
    return out


_URL = re.compile(r"\b(?:https?://|www\.)\S+", re.I)
_NUM_CITE = re.compile(r"\s*\[(?:\d+(?:\s*[-–,]\s*\d+)*)\]")
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")


def speakable(text: str) -> str:
    """Text as it should be fed to the TTS (citations and URLs removed)."""
    t = _NUM_CITE.sub("", text)
    t = re.sub(r"\[(citation needed|clarification needed|when\?|who\?|according to whom\?)\]", "", t, flags=re.I)
    t = _URL.sub("link", t)
    t = _EMAIL.sub("email address", t)
    t = t.replace("&", " and ")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def chunk_for_tts(text: str, limit: int = 300) -> list[str]:
    """Split overly long sentences at punctuation so the TTS model stays stable."""
    text = text.strip()
    if len(text) <= limit:
        return [text] if text else []
    mid = len(text) // 2
    best = None
    for m in re.finditer(r"[,;:)\]–—] ", text):
        pos = m.end()
        if best is None or abs(pos - mid) < abs(best - mid):
            best = pos
    if best is None or best < 20 or best > len(text) - 20:
        best = text.rfind(" ", 0, mid + 40)
        if best <= 0:
            best = mid
    return chunk_for_tts(text[:best], limit) + chunk_for_tts(text[best:], limit)
