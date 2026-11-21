import { Player } from "./player.js";

const $ = (s) => document.querySelector(s);
const docId = location.pathname.split("/").filter(Boolean).pop();
const view = $("#view");

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
const post = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const CHARS_PER_SEC = 14;
const ICON_PLAY = '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4v16l13-8z"/></svg>';
const ICON_PAUSE = '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/></svg>';

let player, mode, sentences, meta, settings;
let follow = true;
let suffixChars = [];
let toc = [];            // [{title, depth, sid, page}]

// ----------------------------------------------------------------- player position (right / bottom)
const narrow = matchMedia("(max-width: 960px)");
let playerPos = store.get("quasselpage.playerpos", "right") === "bottom" ? "bottom" : "right";

function placePlayer() {
  const pos = narrow.matches ? "bottom" : playerPos;
  const pl = $("#pl");
  if (pos === "bottom") $("#dock").appendChild(pl); else $("#slot").appendChild(pl);
  document.querySelectorAll(".playerpos button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.pos === playerPos)));
}
document.querySelectorAll(".playerpos button").forEach((b) => b.addEventListener("click", () => {
  playerPos = b.dataset.pos;
  store.set("quasselpage.playerpos", playerPos);
  placePlayer();
}));
narrow.addEventListener("change", placePlayer);
placePlayer();

$("#sidetoggle").addEventListener("click", () => {
  const open = !$("#side").classList.contains("open");
  $("#side").classList.toggle("open", open);
  $("#sidetoggle").setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => {
  if (!narrow.matches || !$("#side").classList.contains("open")) return;
  if (!e.target.closest("#side, #sidetoggle")) {
    $("#side").classList.remove("open");
    $("#sidetoggle").setAttribute("aria-expanded", "false");
  }
});

// ----------------------------------------------------------------- PDF view
const pdfView = {
  pages: [], scale: 1, zoom: parseFloat(store.get("quasselpage.zoom", "1")) || 1,
  fit: store.get("quasselpage.fit", "width") === "page" ? "page" : "width",
  pageRects: new Map(), curEls: [], hovEls: [], hovSid: -1, pdf: null, observer: null,
  thumbs: [], visPage: -1, curPage: -1,

  async init(doc) {
    const pdfjs = await import("/static/vendor/pdfjs/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/static/vendor/pdfjs/pdf.worker.min.mjs";
    this.pdf = await pdfjs.getDocument({
      url: `/api/docs/${docId}/source.pdf`,
      cMapUrl: "/static/vendor/pdfjs/cmaps/", cMapPacked: true,
      standardFontDataUrl: "/static/vendor/pdfjs/standard_fonts/",
      wasmUrl: "/static/vendor/pdfjs/wasm/",
      isEvalSupported: false,
    }).promise;
    this.sizes = doc.pages;
    for (const s of sentences) {
      for (const [p, x0, y0, x1, y1] of s.rects) {
        if (!this.pageRects.has(p)) this.pageRects.set(p, []);
        this.pageRects.get(p).push({ sid: s.id, r: [x0, y0, x1, y1] });
      }
    }
    const wrap = document.createElement("div");
    wrap.className = "pages";
    view.appendChild(wrap);
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const pg = this.pages[e.target.dataset.p];
        pg.visible = e.isIntersecting;
        if (e.isIntersecting) this.render(pg); else this.unrender(pg);
      }
    }, { root: view, rootMargin: "1200px 0px" });
    this.sizes.forEach((sz, i) => {
      const div = document.createElement("div");
      div.className = "page";
      div.dataset.p = i;
      div.setAttribute("aria-label", `Seite ${i + 1}`);
      div.innerHTML = `<canvas></canvas><div class="hl"></div><span class="pno">${i + 1}</span>`;
      wrap.appendChild(div);
      const pg = { i, div, canvas: div.firstChild, hl: div.children[1], rendered: 0, task: null, visible: false };
      this.pages.push(pg);
      div.addEventListener("click", (e) => this.click(pg, e));
      div.addEventListener("mousemove", (e) => this.hover(pg, e));
      div.addEventListener("mouseleave", () => this.clearHover());
      this.observer.observe(div);
    });
    this.initThumbs();
    this.layout();
    new ResizeObserver(() => this.layout()).observe(view);
    $("#zin").onclick = () => this.setZoom(this.zoom * 1.15);
    $("#zout").onclick = () => this.setZoom(this.zoom / 1.15);
    $("#fitw").onclick = () => this.setFit("width");
    $("#fitp").onclick = () => this.setFit("page");
    let raf = 0;
    view.addEventListener("scroll", () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.onScroll(); });
    }, { passive: true });
    this.loadOutline();   // async, fills the table of contents when ready
  },

  // ---- thumbnails
  initThumbs() {
    const rail = $("#thumbs");
    rail.hidden = false;
    const tobs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const t = this.thumbs[e.target.dataset.p];
        if (e.isIntersecting) this.renderThumb(t); else if (t.done) { t.canvas.width = 0; t.done = false; }
      }
    }, { root: rail, rootMargin: "600px 0px" });
    this.sizes.forEach((sz, i) => {
      const b = document.createElement("button");
      b.className = "thumb";
      b.dataset.p = i;
      b.setAttribute("aria-label", `Zu Seite ${i + 1}`);
      b.innerHTML = `<span class="tp" style="height:${Math.round((62 * sz.h) / sz.w)}px"><canvas></canvas></span>${i + 1}`;
      b.onclick = () => { stopFollowing(true); view.scrollTo({ top: this.pages[i].div.offsetTop - 40, behavior: "smooth" }); };
      rail.appendChild(b);
      this.thumbs.push({ i, b, canvas: b.querySelector("canvas"), done: false, busy: false });
      tobs.observe(b);
    });
  },

  async renderThumb(t) {
    if (t.done || t.busy) return;
    t.busy = true;
    try {
      const page = await this.pdf.getPage(t.i + 1);
      const sz = this.sizes[t.i];
      const vp = page.getViewport({ scale: (62 * Math.min(window.devicePixelRatio || 1, 2)) / sz.w });
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await page.render({ canvas: c, canvasContext: c.getContext("2d"), viewport: vp }).promise;
      t.canvas.replaceWith(c);
      t.canvas = c;
      t.done = true;
    } catch { /* ignore */ }
    t.busy = false;
  },

  markCurrentPage(p) {
    if (p === this.curPage) return;
    this.thumbs[this.curPage]?.b.classList.remove("cur");
    this.curPage = p;
    const t = this.thumbs[p];
    if (!t) return;
    t.b.classList.add("cur");
    const rail = $("#thumbs");
    const top = t.b.offsetTop - rail.offsetTop;
    if (top < rail.scrollTop || top + t.b.offsetHeight > rail.scrollTop + rail.clientHeight) {
      rail.scrollTo({ top: top - rail.clientHeight / 3, behavior: "smooth" });
    }
  },

  onScroll() {
    const a = this.anchor();
    if (!a) return;
    const p = a.page.i;
    if (p !== this.visPage) {
      this.thumbs[this.visPage]?.b.classList.remove("vis");
      this.visPage = p;
      this.thumbs[p]?.b.classList.add("vis");
    }
    const chip = $("#pagechip");
    chip.hidden = false;
    chip.textContent = `Seite ${p + 1} / ${this.sizes.length}`;
  },

  // ---- outline → table of contents
  async loadOutline() {
    let outline;
    try { outline = await this.pdf.getOutline(); } catch { return; }
    if (!outline?.length) return;
    const items = [];
    const walk = async (nodes, depth) => {
      for (const n of nodes) {
        if (items.length > 400) return;
        const pos = await this.resolveDest(n.dest).catch(() => null);
        if (pos) items.push({ title: (n.title || "").trim() || "…", depth, ...pos });
        if (n.items?.length && depth < 2) await walk(n.items, depth + 1);
      }
    };
    await walk(outline, 0);
    for (const it of items) it.sid = this.firstSentenceAt(it.page, it.y);
    setToc(items.filter((it) => it.sid != null));
  },

  async resolveDest(dest) {
    if (!dest) return null;
    const explicit = typeof dest === "string" ? await this.pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return null;
    const ref = explicit[0];
    const page = typeof ref === "number" ? ref : await this.pdf.getPageIndex(ref);
    const sz = this.sizes[page];
    if (!sz) return null;
    // XYZ / FitH / FitBH carry a top coordinate (PDF space, origin bottom-left)
    let top = null;
    const kind = explicit[1]?.name;
    if (kind === "XYZ") top = explicit[3];
    else if (kind === "FitH" || kind === "FitBH") top = explicit[2];
    const y = typeof top === "number" ? Math.max(0, sz.h - top) : 0;
    return { page, y };
  },

  firstSentenceAt(page, y) {
    for (const s of sentences) {
      const r = s.rects[0];
      if (!r) continue;
      if (r[0] > page || (r[0] === page && r[4] >= y - 2)) return s.id;
    }
    return null;
  },

  // ---- zoom
  setZoom(z) {
    const anchor = this.anchor();
    this.zoom = Math.max(0.3, Math.min(4, z));
    store.set("quasselpage.zoom", String(this.zoom));
    this.layout();
    if (anchor) view.scrollTop = anchor.page.div.offsetTop + anchor.frac * anchor.page.div.offsetHeight - 16;
  },

  setFit(fit) {
    this.fit = fit;
    store.set("quasselpage.fit", fit);
    this.setZoom(1);
  },

  anchor() {
    const top = view.scrollTop;
    const pg = this.pages.find((p) => p.div.offsetTop + p.div.offsetHeight > top);
    return pg ? { page: pg, frac: (top - pg.div.offsetTop + 16) / pg.div.offsetHeight } : null;
  },

  layout() {
    const maxW = Math.max(...this.sizes.map((s) => s.w));
    const maxH = Math.max(...this.sizes.map((s) => s.h));
    const availW = Math.min(view.clientWidth - 40, 1100);
    const base = this.fit === "page" ? Math.min(availW / maxW, (view.clientHeight - 72) / maxH) : availW / maxW;
    const scale = Math.max(0.1, base * this.zoom);
    $("#zval").textContent = `${Math.round(this.zoom * 100)} %`;
    $("#fitw").setAttribute("aria-pressed", String(this.fit === "width" && Math.abs(this.zoom - 1) < 0.001));
    $("#fitp").setAttribute("aria-pressed", String(this.fit === "page" && Math.abs(this.zoom - 1) < 0.001));
    if (Math.abs(scale - this.scale) < 0.001 && this.pages[0]?.div.style.width) return;
    this.scale = scale;
    for (const pg of this.pages) {
      const sz = this.sizes[pg.i];
      pg.div.style.width = `${sz.w * scale}px`;
      pg.div.style.height = `${sz.h * scale}px`;
      if (pg.visible) this.render(pg); else this.unrender(pg);
    }
    this.onScroll();
  },

  async render(pg) {
    const target = this.scale * Math.min(window.devicePixelRatio || 1, 2);
    if (pg.rendered === target || pg.task) return;
    const page = await this.pdf.getPage(pg.i + 1);
    const vp = page.getViewport({ scale: target });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    pg.task = page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport: vp });
    try {
      await pg.task.promise;
      pg.canvas.replaceWith(canvas);
      pg.canvas = canvas;
      pg.rendered = target;
    } catch { /* cancelled */ }
    pg.task = null;
    if (pg.rendered !== this.scale * Math.min(window.devicePixelRatio || 1, 2) && pg.visible) this.render(pg);
  },

  unrender(pg) {
    if (pg.task) { pg.task.cancel(); pg.task = null; }
    if (pg.rendered) { pg.canvas.width = 0; pg.canvas.height = 0; pg.rendered = 0; }
  },

  pt(pg, e) {
    const sz = this.sizes[pg.i];
    const r = pg.div.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * sz.w, ((e.clientY - r.top) / r.height) * sz.h];
  },

  hit(p, x, y) {
    const list = this.pageRects.get(p) || [];
    let best = null, bestArea = Infinity, near = null, nearD = 18;
    for (const { sid, r } of list) {
      const pad = 2;
      if (x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad) {
        const a = (r[2] - r[0]) * (r[3] - r[1]);
        if (a < bestArea) { best = sid; bestArea = a; }
      } else {
        const dx = Math.max(r[0] - x, 0, x - r[2]), dy = Math.max(r[1] - y, 0, y - r[3]);
        const d = Math.hypot(dx, dy);
        if (d < nearD) { near = sid; nearD = d; }
      }
    }
    return best ?? near;
  },

  click(pg, e) {
    const [x, y] = this.pt(pg, e);
    const sid = this.hit(pg.i, x, y);
    if (sid != null) { follow = true; updateFollow(); player.playFrom(sid); }
  },

  hover(pg, e) {
    const [x, y] = this.pt(pg, e);
    const sid = this.hit(pg.i, x, y);
    if (sid === this.hovSid) return;
    this.clearHover();
    this.hovSid = sid ?? -1;
    if (sid != null && sid !== player.sid) this.hovEls = this.draw(sid, "hov");
  },

  clearHover() {
    this.hovEls.forEach((el) => el.remove());
    this.hovEls = [];
    this.hovSid = -1;
  },

  draw(sid, cls = "") {
    const els = [];
    for (const [p, x0, y0, x1, y1] of sentences[sid].rects) {
      const sz = this.sizes[p];
      const el = document.createElement("i");
      if (cls) el.className = cls;
      el.style.left = `${((x0 - 1.5) / sz.w) * 100}%`;
      el.style.top = `${((y0 - 1) / sz.h) * 100}%`;
      el.style.width = `${((x1 - x0 + 3) / sz.w) * 100}%`;
      el.style.height = `${((y1 - y0 + 2) / sz.h) * 100}%`;
      this.pages[p].hl.appendChild(el);
      els.push(el);
    }
    return els;
  },

  show(sid) {
    this.curEls.forEach((el) => el.remove());
    this.clearHover();
    this.curEls = this.draw(sid);
    this.markCurrentPage(this.pageOf(sid));
  },

  pageOf(sid) { return sentences[sid]?.rects[0]?.[0] ?? sentences[sid]?.page ?? 0; },

  // y position (in view scroll coordinates) of the sentence start
  offsetOf(sid) {
    const [p, , y0] = sentences[sid].rects[0];
    const pg = this.pages[p];
    return pg.div.offsetTop + (y0 / this.sizes[p].h) * pg.div.offsetHeight;
  },
};

// ----------------------------------------------------------------- web view
const webView = {
  spans: [],
  async init() {
    const html = await (await fetch(`/api/docs/${docId}/page.html`)).text();
    const art = document.createElement("article");
    art.className = "article";
    art.innerHTML = html;
    view.appendChild(art);
    this.spans = [];
    art.querySelectorAll(".s").forEach((el) => { this.spans[+el.dataset.s] = el; });
    art.addEventListener("click", (e) => {
      const el = e.target.closest(".s");
      if (el) { follow = true; updateFollow(); player.playFrom(+el.dataset.s); }
    });
    $("#zoomgrp").hidden = true;
    $("#pdfdark").hidden = true;
    // headings → table of contents
    const spans = [...art.querySelectorAll(".s")];
    const items = [];
    for (const h of art.querySelectorAll("h1, h2, h3")) {
      const inside = h.querySelector(".s");
      const next = inside || spans.find((el) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (!next) continue;
      items.push({ title: h.textContent.trim(), depth: Math.max(0, +h.tagName[1] - 1), sid: +next.dataset.s, page: null });
    }
    const minDepth = Math.min(...items.map((i) => i.depth));
    items.forEach((i) => { i.depth -= minDepth; });
    if (items.length > 1) setToc(items);
  },
  cur: null,
  show(sid) {
    this.cur?.classList.remove("cur");
    this.cur = this.spans[sid];
    this.cur?.classList.add("cur");
  },
  offsetOf(sid) {
    const el = this.spans[sid];
    return el ? el.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop : 0;
  },
};

// ----------------------------------------------------------------- original web page view
// Shows the stored original page in a sandboxed iframe (no scripts) and maps the extracted
// sentences onto its text nodes, so highlighting and click-to-play work on the real layout.
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SELECT", "OPTION", "SVG", "MATH"]);
const IGNORABLE = /[\s­​-‍⁠﻿]/;

const origView = {
  frame: null, doc: null, win: null, segs: [], order: [], coverage: 0, hovSid: -1,

  async init() {
    const url = `/api/docs/${docId}/original.html`;
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    view.classList.add("framed");
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-same-origin");
    f.title = "Originalseite";
    const loaded = new Promise((res) => { f.onload = res; setTimeout(res, 15000); });
    f.src = url;
    view.appendChild(f);
    await loaded;
    this.frame = f; this.doc = f.contentDocument; this.win = f.contentWindow;
    if (!this.doc?.body) throw new Error("Seite nicht lesbar");
    if (!this.win.CSS?.highlights || !this.win.Highlight) throw new Error("Browser kann keine Text-Markierungen");
    this.align();
    if (this.coverage < 0.5) throw new Error(`nur ${Math.round(this.coverage * 100)} % der Sätze im Original gefunden`);

    const st = this.doc.createElement("style");
    st.textContent = "::highlight(qp-cur){background-color:rgba(232,176,75,.55);color:inherit}"
      + "::highlight(qp-hov){background-color:rgba(14,107,85,.16)}";
    this.doc.head.appendChild(st);

    const d = this.doc;
    d.addEventListener("click", (e) => this.click(e), true);
    d.addEventListener("auxclick", (e) => {
      const a = e.target.closest?.("a[href]");
      if (a && e.button === 1) { e.preventDefault(); openExternal(a.href); }
    }, true);
    let raf = 0, last = null;
    d.addEventListener("mousemove", (e) => {
      last = e;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.hover(last); });
    });
    d.addEventListener("mouseleave", () => this.clearHover());
    ["wheel", "touchmove"].forEach((ev) => d.addEventListener(ev, () => stopFollowing(), { passive: true }));
    d.addEventListener("keydown", onKey);
    $("#zoomgrp").hidden = true;
    $("#pdfdark").hidden = true;
    this.buildToc();
  },

  // ---- text stream of the page: non-whitespace characters, each mapped back to (node, offset)
  stream(root) {
    const nodes = [], nodeIdx = new Map();
    let chars = "";
    const nOf = [], oOf = [];
    const walker = this.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        for (let el = n.parentElement; el && el !== root.parentElement; el = el.parentElement) {
          if (SKIP.has(el.tagName.toUpperCase()) || el.hidden || el.getAttribute("aria-hidden") === "true") return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const parts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = nodes.length;
      nodes.push(n); nodeIdx.set(n, i);
      const t = n.data;
      for (let k = 0; k < t.length; k++) {
        const c = t[k];
        if (IGNORABLE.test(c)) continue;
        const norm = c.charCodeAt(0) < 128 ? c : c.normalize("NFKC");
        for (const ch of norm) {
          if (IGNORABLE.test(ch)) continue;
          parts.push(ch); nOf.push(i); oOf.push(k);
        }
      }
    }
    chars = parts.join("");
    return { root, nodes, nodeIdx, chars, nOf, oOf };
  },

  align() {
    const key = (t) => t.normalize("NFKC").replace(/[\s­​-‍⁠﻿]/g, "");
    const keys = sentences.map((s) => key(s.text));
    // find the element holding the article: common ancestor of the first and last long sentence
    let S = this.stream(this.doc.body);
    const longs = keys.map((k, i) => [k, i]).filter(([k]) => k.length >= 40);
    if (longs.length) {
      const a = S.chars.indexOf(longs[0][0]);
      const b = S.chars.lastIndexOf(longs[longs.length - 1][0]);
      if (a >= 0 && b >= a) {
        const r = this.doc.createRange();
        r.setStart(S.nodes[S.nOf[a]], 0);
        r.setEnd(S.nodes[S.nOf[b]], 0);
        let root = r.commonAncestorContainer;
        if (root.nodeType !== 1) root = root.parentElement;
        // include a heading/title directly above the article container
        if (root.parentElement && root !== this.doc.body && root.parentElement.children.length <= 4) root = root.parentElement;
        S = this.stream(root);
      }
    }
    this.S = S;
    const WINDOW = 40000;
    let cur = 0, found = 0;
    this.segs = new Array(sentences.length).fill(null);
    for (let sid = 0; sid < keys.length; sid++) {
      const k = keys[sid];
      if (!k) continue;
      let a = S.chars.indexOf(k, cur), b = a + k.length;
      if (a < 0 || a - cur > WINDOW) {
        // tolerate small differences: anchor on the beginning and the end of the sentence
        const n = Math.min(16, k.length);
        a = S.chars.indexOf(k.slice(0, n), cur);
        if (a < 0 || a - cur > WINDOW) continue;
        const tail = k.slice(-n);
        const e = S.chars.indexOf(tail, a + Math.max(0, k.length - n - 40));
        b = e >= 0 && e - a < k.length * 1.5 + 40 ? e + n : a + k.length;
      }
      const range = this.doc.createRange();
      range.setStart(S.nodes[S.nOf[a]], S.oOf[a]);
      range.setEnd(S.nodes[S.nOf[b - 1]], S.oOf[b - 1] + 1);
      this.segs[sid] = { a, b, range };
      cur = b;
      found++;
    }
    this.coverage = keys.length ? found / keys.length : 0;
    this.order = this.segs.map((g, sid) => g && { sid, a: g.a, b: g.b }).filter(Boolean);
  },

  // stream index of a DOM position (node + offset); -1 if outside the article
  posOf(node, offset) {
    const S = this.S;
    const i = S.nodeIdx.get(node);
    if (i == null) return -1;
    let lo = 0, hi = S.nOf.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (S.nOf[m] < i || (S.nOf[m] === i && S.oOf[m] < offset)) lo = m + 1; else hi = m;
    }
    return lo;
  },

  sidAtPos(p) {
    if (p < 0) return null;
    let lo = 0, hi = this.order.length - 1, best = null;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (this.order[m].a <= p) { best = this.order[m]; lo = m + 1; } else hi = m - 1;
    }
    return best && p < best.b + 1 ? best.sid : null;
  },

  sidAtPoint(x, y) {
    const d = this.doc;
    let node, off;
    if (d.caretPositionFromPoint) {
      const c = d.caretPositionFromPoint(x, y);
      node = c?.offsetNode; off = c?.offset;
    } else if (d.caretRangeFromPoint) {
      const c = d.caretRangeFromPoint(x, y);
      node = c?.startContainer; off = c?.startOffset;
    }
    if (!node || node.nodeType !== 3) return null;
    const sid = this.sidAtPos(this.posOf(node, off));
    if (sid == null) return null;
    // caret APIs snap to the nearest text; make sure the pointer is really over the sentence
    for (const r of this.segs[sid].range.getClientRects()) {
      if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 3 && y <= r.bottom + 3) return sid;
    }
    return null;
  },

  click(e) {
    if (e.button !== 0) return;
    const a = e.target.closest?.("a[href]");
    if (a && (e.ctrlKey || e.metaKey || e.shiftKey)) { e.preventDefault(); openExternal(a.href); return; }
    const sid = this.sidAtPoint(e.clientX, e.clientY);
    if (sid != null) {
      e.preventDefault();
      if (this.doc.getSelection()?.toString()) return;   // allow selecting text
      follow = true; updateFollow(); player.playFrom(sid);
      return;
    }
    if (a) {
      e.preventDefault();
      const href = a.getAttribute("href") || "";
      if (href.startsWith("#")) {
        const t = this.doc.getElementById(decodeURIComponent(href.slice(1))) || this.doc.getElementsByName(href.slice(1))[0];
        if (t) { stopFollowing(true); t.scrollIntoView({ behavior: "smooth", block: "start" }); }
      } else {
        openExternal(a.href);
      }
    }
  },

  hover(e) {
    const sid = this.sidAtPoint(e.clientX, e.clientY);
    this.doc.documentElement.style.cursor = sid != null ? "pointer" : "";
    if (sid === this.hovSid) return;
    this.hovSid = sid ?? -1;
    if (sid != null && sid !== player.sid) this.win.CSS.highlights.set("qp-hov", new this.win.Highlight(this.segs[sid].range));
    else this.win.CSS.highlights.delete("qp-hov");
  },

  clearHover() {
    this.hovSid = -1;
    this.win?.CSS.highlights.delete("qp-hov");
    if (this.doc) this.doc.documentElement.style.cursor = "";
  },

  show(sid) {
    this.clearHover();
    const g = this.segs[sid];
    if (g) this.win.CSS.highlights.set("qp-cur", new this.win.Highlight(g.range));
    else this.win.CSS.highlights.delete("qp-cur");
  },

  ensureVisible(sid, smooth = true) {
    const g = this.segs[sid];
    if (!g) return;
    const rect = g.range.getBoundingClientRect();
    const h = this.win.innerHeight;
    if (rect.top >= h * 0.12 && rect.top <= h * 0.72) return;
    const se = this.doc.scrollingElement;
    if (se && se.scrollHeight > se.clientHeight + 1) {
      this.win.scrollBy({ top: rect.top - h * 0.3, behavior: smooth ? "smooth" : "auto" });
    } else {
      g.range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
    }
  },

  buildToc() {
    const items = [];
    for (const h of this.S.root.querySelectorAll("h1, h2, h3")) {
      const w = this.doc.createTreeWalker(h, NodeFilter.SHOW_TEXT);
      const first = w.nextNode();
      if (!first) continue;
      const p = this.posOf(first, 0);
      const next = this.order.find((o) => o.b > p);
      if (!next) continue;
      const title = h.textContent.replace(/[¶#🔗]\s*$/u, "").trim();
      if (title) items.push({ title, depth: Math.max(0, +h.tagName[1] - 1), sid: next.sid, page: null });
    }
    if (items.length > 1) {
      const minDepth = Math.min(...items.map((i) => i.depth));
      items.forEach((i) => { i.depth -= minDepth; });
      setToc(items);
    }
  },
};

function openExternal(href) {
  if (/^https?:/i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
}

// ----------------------------------------------------------------- table of contents
function setToc(items) {
  toc = items;
  const box = $("#toc");
  box.innerHTML = "";
  items.forEach((it, i) => {
    const b = document.createElement("button");
    b.className = `d${Math.min(it.depth, 2)}`;
    b.dataset.i = i;
    const t = document.createElement("span");
    t.textContent = it.title;
    b.appendChild(t);
    if (it.page != null) {
      const pg = document.createElement("span");
      pg.className = "pg";
      pg.textContent = it.page + 1;
      b.appendChild(pg);
    }
    b.onclick = () => jumpTo(it.sid);
    box.appendChild(b);
  });
  $("#tocsec").hidden = !items.length;
  updateChapter();
}

function chapterOf(sid) {
  let cur = -1;
  for (let i = 0; i < toc.length; i++) if (toc[i].sid <= sid) cur = i;
  return cur;
}

let curChapter = -2;
function updateChapter() {
  if (!player) return;
  const c = chapterOf(player.sid);
  const sub = $("#sub");
  const parts = [];
  if (c >= 0) parts.push(toc[c].title);
  if (mode === "pdf") parts.push(`Seite ${pdfView.pageOf(player.sid) + 1} von ${meta.pages}`);
  else {
    let host = "Text";
    try { if (meta.url) host = new URL(meta.url).hostname.replace(/^www\./, ""); } catch { host = "Webseite"; }
    parts.push(host);
  }
  sub.textContent = parts.join(" · ");
  $("#nowchap").textContent = c >= 0 ? `Jetzt · ${toc[c].title}` : "Jetzt";
  if (c === curChapter) return;
  curChapter = c;
  document.querySelectorAll("#toc button").forEach((b) => {
    if (+b.dataset.i === c) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
  });
}

function jumpTo(sid) {
  sid = Math.max(0, Math.min(sentences.length - 1, sid));
  follow = true;
  if (player.playing) player.playFrom(sid); else player.select(sid);
  scrollToSentence(sid);
  updateFollow();
}

// ----------------------------------------------------------------- shared
let view_;

function scrollToSentence(sid, smooth = true) {
  if (view_.ensureVisible) return view_.ensureVisible(sid, smooth);
  const y = view_.offsetOf(sid);
  const top = view.scrollTop, h = view.clientHeight;
  if (y < top + h * 0.12 || y > top + h * 0.72) {
    view.scrollTo({ top: Math.max(0, y - h * 0.3), behavior: smooth ? "smooth" : "auto" });
  }
}

function updateFollow() {
  $("#follow").classList.toggle("show", !follow && !!player?.playing);
}

function stopFollowing(force = false) {
  if (player?.playing && follow && (settings.autoscroll || force)) { follow = false; updateFollow(); }
}
["wheel", "touchmove"].forEach((ev) => view.addEventListener(ev, () => stopFollowing(), { passive: true }));
view.addEventListener("mousedown", (e) => { if (e.target === view) stopFollowing(); }); // scrollbar drag
$("#follow").onclick = () => { follow = true; updateFollow(); scrollToSentence(player.sid); };

function onKey(e) {
  if (!player || e.target.closest?.("input, select, textarea, [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === " ") { e.preventDefault(); follow = true; player.toggle(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); player.next(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); player.prev(); }
  else if ((e.key === "+" || e.key === "=") && mode === "pdf") pdfView.setZoom(pdfView.zoom * 1.15);
  else if (e.key === "-" && mode === "pdf") pdfView.setZoom(pdfView.zoom / 1.15);
  else if (["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) stopFollowing();
}

let posTimer = null;
function savePosition(sid) {
  clearTimeout(posTimer);
  posTimer = setTimeout(() => post(`/api/docs/${docId}/position`,
    { sid, voice: player.voice, playing: player.playing }).catch(() => {}), 600);
}

function fmtRemain(sid) {
  const sec = (suffixChars[sid] || 0) / CHARS_PER_SEC / (player.rate || 1);
  if (sec < 60) return sec > 0 ? "noch < 1 min" : "";
  const m = Math.round(sec / 60);
  return m < 60 ? `noch ca. ${m} min` : `noch ca. ${Math.floor(m / 60)} h ${m % 60} min`;
}

let rendered = 0;
function showState(s = player.state) {
  const n = sentences.length;
  const st = $("#state");
  const pos = `Satz ${player.sid + 1} / ${n}`;
  if (s === "waiting") st.innerHTML = '<span class="spinner"></span> Audio wird erzeugt …';
  else if (s === "error") st.textContent = "Satz konnte nicht erzeugt werden – übersprungen";
  else if (s === "ended") st.textContent = "Ende erreicht";
  else st.textContent = pos;
  $("#remain").textContent = fmtRemain(player.sid);
  const play = $("#play");
  play.innerHTML = player.playing ? ICON_PAUSE : ICON_PLAY;
  play.setAttribute("aria-label", player.playing ? "Pause" : "Abspielen");
  $("#ph").style.width = `${n > 1 ? (100 * player.sid) / (n - 1) : 0}%`;
  $("#pr").style.width = `${(100 * Math.min(rendered, n)) / n}%`;
  $("#pbar").title = `gehört bis Satz ${player.sid + 1} · Audio ${Math.round((100 * Math.min(rendered, n)) / n)} % vorgerendert – klicken zum Springen`;
  $("#nowtext").textContent = sentences[player.sid]?.text || "";
  updateChapter();
  updateFollow();
}

async function pollProgress() {
  try {
    const d = (await api("/api/docs")).find((x) => x.id === docId);
    if (d) { rendered = d.rendered; showState(); }
  } catch { /* server gone */ }
}

function setupRates(current) {
  const box = $("#rates");
  box.innerHTML = "";
  for (const r of RATES) {
    const b = document.createElement("button");
    b.textContent = `${String(r).replace(".", ",")}×`;
    b.dataset.r = r;
    b.setAttribute("aria-pressed", String(r === current));
    b.onclick = () => {
      player.setRate(r);
      box.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(+x.dataset.r === r)));
      post("/api/settings", { rate: r }).catch(() => {});
      showState();
    };
    box.appendChild(b);
  }
}

async function main() {
  const [{ meta: m, doc }, s] = await Promise.all([api(`/api/docs/${docId}`), api("/api/settings")]);
  meta = m; settings = s; sentences = doc.sentences; mode = doc.kind;
  document.title = `${meta.title} – QuasselPage`;
  $("#title").textContent = meta.title;
  $("#title").title = meta.title;
  rendered = meta.rendered;
  if (meta.scanned) {
    const b = $("#banner");
    b.hidden = false;
    b.textContent = "Diese PDF enthält kaum Text (vermutlich gescannt) – nur der erkannte Text wird vorgelesen.";
  }
  suffixChars = new Array(sentences.length + 1).fill(0);
  for (let i = sentences.length - 1; i >= 0; i--) suffixChars[i] = suffixChars[i + 1] + sentences[i].text.length;

  // voices
  const vs = $("#voice");
  for (const [lang, names] of Object.entries(settings.voices)) {
    const g = document.createElement("optgroup");
    g.label = { en: "Englisch", de: "Deutsch" }[lang] || lang;
    for (const n of names) g.appendChild(new Option(n, n.toLowerCase()));
    vs.appendChild(g);
  }
  vs.value = settings.voice;
  setupRates(settings.rate);
  $("#autoscroll").checked = settings.autoscroll;
  const dark = store.get("quasselpage.pdfdark", "0") === "1";
  document.documentElement.dataset.pdfdark = dark ? "1" : "0";

  player = new Player(docId, sentences, { voice: settings.voice, rate: settings.rate });
  const canOriginal = mode !== "pdf" && !!meta.url;
  const wantOriginal = canOriginal && store.get("quasselpage.webview", "original") === "original";
  if (canOriginal) {
    $("#viewmode").hidden = false;
    document.querySelectorAll("#viewmode button").forEach((b) => {
      b.setAttribute("aria-pressed", String((b.dataset.v === "original") === wantOriginal));
      b.onclick = () => { store.set("quasselpage.webview", b.dataset.v); location.reload(); };
    });
  }
  view_ = mode === "pdf" ? pdfView : wantOriginal ? origView : webView;
  try {
    await view_.init(doc);
  } catch (e) {
    if (view_ !== origView) throw e;
    console.warn("Originalansicht nicht möglich:", e);
    const b = $("#banner");
    b.hidden = false;
    b.textContent = `Originalansicht nicht möglich (${e.message}) – es wird die Lesefassung gezeigt.`;
    view.classList.remove("framed");
    view.innerHTML = "";
    view_ = webView;
    await view_.init(doc);
  }

  player.addEventListener("sentence", (e) => {
    const sid = e.detail;
    view_.show(sid);
    if (follow && settings.autoscroll) scrollToSentence(sid);
    savePosition(sid);
    showState();
  });
  player.addEventListener("state", (e) => showState(e.detail));

  const start = Math.min(meta.position || 0, sentences.length - 1);
  player.select(start);
  requestAnimationFrame(() => scrollToSentence(start, false));
  if (mode === "pdf") setTimeout(() => scrollToSentence(start, false), 300);

  $("#play").onclick = () => { follow = true; player.toggle(); };
  $("#prev").onclick = () => player.prev();
  $("#next").onclick = () => player.next();
  $("#back15").onclick = () => player.seek(-15);
  $("#fwd15").onclick = () => player.seek(15);
  $("#pbar").onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    jumpTo(Math.round(((e.clientX - r.left) / r.width) * (sentences.length - 1)));
  };
  vs.onchange = async (e) => {
    settings = await post("/api/settings", { voice: e.target.value });
    player.setVoice(settings.voice);
    post(`/api/docs/${docId}/position`, { sid: player.sid, voice: player.voice, playing: true });
    pollProgress();
  };
  $("#autoscroll").onchange = async (e) => {
    settings = await post("/api/settings", { autoscroll: e.target.checked });
    follow = true;
    updateFollow();
  };
  $("#pdfdark").onclick = () => {
    const on = document.documentElement.dataset.pdfdark !== "1";
    document.documentElement.dataset.pdfdark = on ? "1" : "0";
    store.set("quasselpage.pdfdark", on ? "1" : "0");
  };

  document.addEventListener("keydown", onKey);

  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: meta.title, artist: "QuasselPage" });
    navigator.mediaSession.setActionHandler("play", () => player.toggle());
    navigator.mediaSession.setActionHandler("pause", () => player.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
    navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
    navigator.mediaSession.setActionHandler("seekforward", () => player.seek(15));
    navigator.mediaSession.setActionHandler("seekbackward", () => player.seek(-15));
  }

  showState();
  setInterval(pollProgress, 5000);
}

main().catch((e) => {
  view.innerHTML = `<p style="padding:20px">Fehler beim Laden: ${String(e.message).replace(/</g, "&lt;")}</p>`;
});
