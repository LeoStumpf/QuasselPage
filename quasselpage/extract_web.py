"""Web page / plain text → readable HTML with sentence spans."""
from __future__ import annotations

import html as htmlmod
import re
from urllib.parse import urljoin

import httpx
import trafilatura
from lxml import html as lhtml

from .segment import normalize, split_sentences

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
BLOCKS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "dd", "dt", "figcaption", "td", "th", "div"}


class _Builder:
    def __init__(self, lang: str):
        self.lang = lang
        self.sentences: list[dict] = []
        self.out: list[str] = []

    def block(self, tag: str, text: str, cls: str = "") -> None:
        text = normalize(text)
        if not text:
            return
        spans = split_sentences(text, self.lang)
        parts = []
        for i, (s, e) in enumerate(spans):
            sid = len(self.sentences)
            self.sentences.append({"id": sid, "text": text[s:e], "para_end": i == len(spans) - 1})
            parts.append(f'<span class="s" data-s="{sid}">{htmlmod.escape(text[s:e])}</span>')
        c = f' class="{cls}"' if cls else ""
        self.out.append(f"<{tag}{c}>{' '.join(parts)}</{tag}>")

    def image(self, src: str, alt: str) -> None:
        self.out.append(
            f'<figure><img src="{htmlmod.escape(src)}" alt="{htmlmod.escape(alt)}" loading="lazy" '
            f'referrerpolicy="no-referrer"></figure>'
        )


def _walk(el, b: _Builder, base_url: str | None) -> None:
    tag = el.tag if isinstance(el.tag, str) else ""
    if tag == "img":
        src = el.get("src") or ""
        if src and base_url:
            src = urljoin(base_url, src)
        if src.startswith(("http://", "https://")) and not re.search(r"/(\d{1,2})px-", src):
            b.image(src, el.get("alt") or "")
        return
    if tag in BLOCKS:
        has_block_child = any(isinstance(c.tag, str) and (c.tag in BLOCKS or c.tag in ("ul", "ol", "img", "table")) for c in el)
        if not has_block_child:
            out_tag = tag if tag in {"h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre"} else "p"
            cls = "li" if tag == "li" else ""
            b.block(out_tag, el.text_content(), cls)
            return
        if el.text and el.text.strip():
            b.block("p", el.text)
    for child in el:
        _walk(child, b, base_url)
        if child.tail and child.tail.strip() and tag in BLOCKS:
            b.block("p", child.tail)


def from_html(raw_html: str, url: str | None = None, lang: str = "en") -> dict:
    extracted = trafilatura.extract(
        raw_html, output_format="html", include_images=True, include_links=False,
        include_tables=True, include_comments=False, url=url, favor_recall=True,
    )
    meta = trafilatura.extract_metadata(raw_html, default_url=url)
    title = (meta.title if meta and meta.title else None) or url or "Webseite"
    b = _Builder(lang)
    if extracted:
        root = lhtml.fromstring(extracted)
        body = root.find("body") if root.find("body") is not None else root
        for child in body:
            _walk(child, b, url)
    if not b.sentences:
        raise ValueError("Kein lesbarer Text auf der Seite gefunden.")
    return {"kind": "web", "title": title, "lang": lang, "url": url,
            "html": "\n".join(b.out), "sentences": b.sentences}


def _get(url: str, timeout: float = 30) -> httpx.Response:
    r = httpx.get(url, headers={"User-Agent": UA, "Accept-Language": "en,de;q=0.8"},
                  follow_redirects=True, timeout=timeout)
    r.raise_for_status()
    return r


def from_url(url: str, lang: str = "en") -> dict:
    if not re.match(r"https?://", url):
        url = "https://" + url
    r = _get(url)
    ctype = r.headers.get("content-type", "")
    if "pdf" in ctype:
        raise IsPdf(r.content)
    d = from_html(r.text, str(r.url), lang)
    try:
        d["original"] = snapshot(r.text, str(r.url))
    except Exception:       # the readable version still works without the original view
        d["original"] = r.text
    return d


# ---------------------------------------------------------------- original page view
_CSS_URL = re.compile(r"""url\(\s*(['"]?)([^'")]+)\1\s*\)""")
_CSS_IMPORT = re.compile(r"""@import\s+(['"])([^'"]+)\1""")
MAX_CSS = 3_000_000


def absolutize_css(css: str, css_url: str) -> str:
    """Make url(...) and @import "..." references absolute so inlined CSS keeps working."""
    def fix(u: str) -> str:
        u = u.strip()
        if u.startswith(("data:", "#", "http://", "https://")):
            return u
        return urljoin(css_url, u)
    css = _CSS_URL.sub(lambda m: f'url("{fix(m.group(2))}")', css)
    return _CSS_IMPORT.sub(lambda m: f'@import "{fix(m.group(2))}"', css)


def _base_url(doc, url: str) -> str:
    base = doc.find(".//base[@href]")
    return urljoin(url, base.get("href")) if base is not None else url


def snapshot(raw_html: str, url: str, max_sheets: int = 25) -> str:
    """Original page with its stylesheets inlined (so the look survives later site changes)."""
    doc = lhtml.document_fromstring(raw_html)
    base = _base_url(doc, url)
    n = 0
    for link in doc.xpath("//link[@href]"):
        rel = (link.get("rel") or "").lower().split()
        if "stylesheet" not in rel or "alternate" in rel or n >= max_sheets:
            continue
        href = urljoin(base, link.get("href"))
        if not href.startswith(("http://", "https://")):
            continue
        n += 1
        try:
            r = _get(href, timeout=15)
        except Exception:
            link.set("href", href)
            continue
        if len(r.content) > MAX_CSS:
            link.set("href", href)
            continue
        style = lhtml.Element("style")
        style.text = absolutize_css(r.text, str(r.url))
        style.set("data-qp-href", href)
        if link.get("media"):
            style.set("media", link.get("media"))
        link.getparent().replace(link, style)
    for style in doc.xpath("//style[not(@data-qp-href)]"):
        if style.text:
            style.text = absolutize_css(style.text, base)
    doctype = doc.getroottree().docinfo.doctype or "<!DOCTYPE html>"
    return doctype + "\n" + lhtml.tostring(doc, encoding="unicode")


_DROP = ("script", "iframe", "frame", "frameset", "object", "embed", "applet", "portal")


def prepare_original(raw_html: str, url: str | None) -> str:
    """Make a stored original page safe and self-contained for display in the sandboxed viewer:
    no scripts or embedded frames, links/resources resolve against the original URL, no referrer."""
    doc = lhtml.document_fromstring(raw_html)
    base = _base_url(doc, url or "")
    for el in doc.xpath("|".join(f"//{t}" for t in _DROP)):
        el.drop_tree()
    for el in doc.xpath("//base | //meta[@charset] | //meta[@http-equiv]"):
        el.drop_tree()
    for el in doc.iter():
        if not isinstance(el.tag, str):
            continue
        for a in list(el.attrib):
            if a.lower().startswith("on"):
                del el.attrib[a]
        for a in ("href", "src", "action", "formaction"):
            if el.get(a, "").strip().lower().startswith("javascript:"):
                del el.attrib[a]
    head = doc.find("head")
    if head is None:
        head = lhtml.Element("head")
        doc.insert(0, head)
    extra = [lhtml.Element("meta", charset="utf-8"),
             lhtml.Element("meta", name="referrer", content="no-referrer")]
    if base:
        extra.insert(1, lhtml.Element("base", href=base))
    for i, el in enumerate(extra):
        head.insert(i, el)
    return "<!DOCTYPE html>\n" + lhtml.tostring(doc, encoding="unicode")


def fetch_original(url: str) -> str:
    r = _get(url)
    if "html" not in r.headers.get("content-type", "html"):
        raise ValueError("keine HTML-Seite")
    return snapshot(r.text, str(r.url))


def from_text(text: str, title: str = "Text", lang: str = "en") -> dict:
    b = _Builder(lang)
    for para in re.split(r"\n\s*\n", text):
        b.block("p", para.replace("\n", " "))
    if not b.sentences:
        raise ValueError("Leerer Text.")
    return {"kind": "web", "title": title, "lang": lang, "url": None,
            "html": "\n".join(b.out), "sentences": b.sentences}


class IsPdf(Exception):
    """Raised when a URL points to a PDF; carries the bytes."""

    def __init__(self, data: bytes):
        super().__init__("pdf")
        self.data = data
