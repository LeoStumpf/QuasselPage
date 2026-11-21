"""PDF → sentences with page rectangles (PyMuPDF)."""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf

from .segment import normalize, split_sentences

MARGIN = 0.08          # top/bottom fraction of the page treated as header/footer zone
_END_PUNCT = re.compile(r"[.!?:;\"”’)\]]$")


@dataclass
class Word:
    page: int
    key: tuple          # (page, block, line) – rects are merged per line
    rect: tuple
    text: str


@dataclass
class Block:
    page: int
    lines: list[list[Word]] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(w.text for line in self.lines for w in line)


def _line_signature(text: str) -> str:
    return re.sub(r"\d+", "#", text.strip().lower())


def _read_blocks(doc: pymupdf.Document) -> tuple[list[Block], list[dict]]:
    pages_info = []
    raw: list[tuple[int, int, list[list[Word]], float, float]] = []  # page, block, lines, y0, y1
    for pno, page in enumerate(doc):
        w, h = page.rect.width, page.rect.height
        pages_info.append({"w": round(w, 2), "h": round(h, 2)})
        lines: dict[tuple, list[Word]] = {}
        order: list[tuple] = []
        for x0, y0, x1, y1, txt, bno, lno, _wno in page.get_text("words", sort=False):
            txt = normalize(txt)
            if not txt:
                continue
            key = (pno, bno, lno)
            if key not in lines:
                lines[key] = []
                order.append(key)
            lines[key].append(Word(pno, key, (x0, y0, x1, y1), txt))
        blocks: dict[int, list[list[Word]]] = defaultdict(list)
        border: list[int] = []
        for key in order:
            if key[1] not in blocks:
                border.append(key[1])
            blocks[key[1]].append(lines[key])
        for bno in border:
            ys = [wd.rect[1] for ln in blocks[bno] for wd in ln] + [wd.rect[3] for ln in blocks[bno] for wd in ln]
            raw.append((pno, bno, blocks[bno], min(ys) / h, max(ys) / h))

    # header/footer: lines in the margin zones whose (digit-normalised) text repeats on many pages,
    # plus bare page numbers there
    npages = len(doc)
    sig_pages: dict[str, set[int]] = defaultdict(set)
    for pno, _b, lines, y0, y1 in raw:
        if y1 < MARGIN or y0 > 1 - MARGIN:
            for ln in lines:
                sig_pages[_line_signature(" ".join(w.text for w in ln))].add(pno)
    repeated = {s for s, p in sig_pages.items() if npages >= 3 and len(p) >= max(3, npages * 0.4)}

    result: list[Block] = []
    for pno, _b, lines, y0, y1 in raw:
        if y1 < MARGIN or y0 > 1 - MARGIN:
            keep = []
            for ln in lines:
                t = " ".join(w.text for w in ln)
                if _line_signature(t) in repeated or re.fullmatch(r"(page\s*)?[\divxlc]+(\s*(/|of)\s*\d+)?", t.strip(), re.I):
                    continue
                keep.append(ln)
            lines = keep
        if lines:
            result.append(Block(pno, lines))
    return result, pages_info


def _paragraphs(blocks: list[Block]) -> list[list[Block]]:
    """Merge blocks that continue a sentence (column / page break in mid-sentence)."""
    paras: list[list[Block]] = []
    for b in blocks:
        if paras:
            prev = paras[-1][-1].text
            first = b.text[:1]
            if prev and not _END_PUNCT.search(prev) and (first.islower() or prev.endswith((",", "-"))):
                paras[-1].append(b)
                continue
        paras.append([b])
    return paras


def _para_text(blocks: list[Block]) -> tuple[str, list[tuple[int, int, Word]]]:
    """Concatenate words; join end-of-line hyphenation. Returns text + (start, end, word) spans."""
    words = [w for b in blocks for ln in b.lines for w in ln]
    parts: list[str] = []
    spans: list[tuple[int, int, Word]] = []
    pos = 0
    for i, w in enumerate(words):
        t = w.text
        nxt = words[i + 1] if i + 1 < len(words) else None
        line_end = nxt is not None and nxt.key != w.key
        joined = line_end and t.endswith("-") and len(t) > 2 and t[-2].isalpha() and nxt.text[:1].islower()
        if joined:
            t = t[:-1]
        parts.append(t)
        spans.append((pos, pos + len(t), w))
        pos += len(t)
        if nxt is not None and not joined:
            parts.append(" ")
            pos += 1
    return "".join(parts), spans


def _rects(words: list[Word]) -> list[list[float]]:
    by_line: dict[tuple, list[float]] = {}
    order = []
    for w in words:
        r = by_line.get(w.key)
        if r is None:
            by_line[w.key] = list(w.rect)
            order.append(w.key)
        else:
            r[0] = min(r[0], w.rect[0]); r[1] = min(r[1], w.rect[1])
            r[2] = max(r[2], w.rect[2]); r[3] = max(r[3], w.rect[3])
    return [[k[0]] + [round(v, 1) for v in by_line[k]] for k in order]


def extract_pdf(path: Path, lang: str = "en") -> dict:
    doc = pymupdf.open(path)
    blocks, pages = _read_blocks(doc)
    sentences = []
    for para in _paragraphs(blocks):
        text, spans = _para_text(para)
        sent_spans = split_sentences(text, lang)
        for si, (s, e) in enumerate(sent_spans):
            ws = [w for (a, b, w) in spans if a < e and b > s]
            if not ws:
                continue
            sentences.append({
                "id": len(sentences),
                "text": text[s:e],
                "page": ws[0].page,
                "rects": _rects(ws),
                "para_end": si == len(sent_spans) - 1,
            })
    title = (doc.metadata or {}).get("title") or ""
    if len(title.strip()) < 3 or title.lower().startswith(("microsoft word", "untitled")):
        title = Path(path).stem
    chars = sum(len(s["text"]) for s in sentences)
    return {
        "kind": "pdf",
        "title": title.strip(),
        "lang": lang,
        "pages": pages,
        "sentences": sentences,
        "scanned": chars < 50 * max(1, len(pages)),
    }
