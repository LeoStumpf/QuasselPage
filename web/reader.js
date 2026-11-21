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

let player, mode, sentences, meta, settings;
let follow = true;

// ----------------------------------------------------------------- PDF view
const pdfView = {
  pages: [], scale: 1, zoom: parseFloat(store.get("quasselpage.zoom", "1")) || 1,
  pageRects: new Map(), curEls: [], hovEls: [], hovSid: -1, pdf: null, observer: null,

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
      div.innerHTML = `<canvas></canvas><div class="hl"></div><span class="pno">${i + 1}</span>`;
      wrap.appendChild(div);
      const pg = { i, div, canvas: div.firstChild, hl: div.children[1], rendered: 0, task: null, visible: false };
      this.pages.push(pg);
      div.addEventListener("click", (e) => this.click(pg, e));
      div.addEventListener("mousemove", (e) => this.hover(pg, e));
      div.addEventListener("mouseleave", () => this.clearHover());
      this.observer.observe(div);
    });
    this.layout();
    new ResizeObserver(() => this.layout()).observe(view);
    $("#zin").onclick = () => this.setZoom(this.zoom * 1.15);
    $("#zout").onclick = () => this.setZoom(this.zoom / 1.15);
  },

  setZoom(z) {
    const anchor = this.anchor();
    this.zoom = Math.max(0.4, Math.min(4, z));
    store.set("quasselpage.zoom", String(this.zoom));
    this.layout();
    if (anchor) view.scrollTop = anchor.page.div.offsetTop + anchor.frac * anchor.page.div.offsetHeight - 16;
  },

  anchor() {
    const top = view.scrollTop;
    const pg = this.pages.find((p) => p.div.offsetTop + p.div.offsetHeight > top);
    return pg ? { page: pg, frac: (top - pg.div.offsetTop + 16) / pg.div.offsetHeight } : null;
  },

  layout() {
    const maxW = Math.max(...this.sizes.map((s) => s.w));
    const avail = Math.min(view.clientWidth - 24, 980);
    const scale = (avail / maxW) * this.zoom;
    if (Math.abs(scale - this.scale) < 0.001 && this.pages[0]?.div.style.width) return;
    this.scale = scale;
    for (const pg of this.pages) {
      const sz = this.sizes[pg.i];
      pg.div.style.width = `${sz.w * scale}px`;
      pg.div.style.height = `${sz.h * scale}px`;
      if (pg.visible) this.render(pg); else this.unrender(pg);
    }
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
  },

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

// ----------------------------------------------------------------- shared
let view_;

function scrollToSentence(sid, smooth = true) {
  const y = view_.offsetOf(sid);
  const top = view.scrollTop, h = view.clientHeight;
  if (y < top + h * 0.12 || y > top + h * 0.72) {
    view.scrollTo({ top: Math.max(0, y - h * 0.3), behavior: smooth ? "smooth" : "auto" });
  }
}

function updateFollow() {
  $("#follow").classList.toggle("show", !follow && player?.playing);
}

function stopFollowing() {
  if (player?.playing && follow && settings.autoscroll) { follow = false; updateFollow(); }
}
["wheel", "touchmove"].forEach((ev) => view.addEventListener(ev, stopFollowing, { passive: true }));
view.addEventListener("mousedown", (e) => { if (e.target === view) stopFollowing(); }); // scrollbar drag
$("#follow").onclick = () => { follow = true; updateFollow(); scrollToSentence(player.sid); };

let posTimer = null;
function savePosition(sid) {
  clearTimeout(posTimer);
  posTimer = setTimeout(() => post(`/api/docs/${docId}/position`,
    { sid, voice: player.voice, playing: player.playing }).catch(() => {}), 600);
}

let rendered = 0;
function showState(s = player.state) {
  const st = $("#state");
  const pos = `Satz ${player.sid + 1} / ${sentences.length}`;
  const prog = rendered < sentences.length ? ` · Audio ${Math.round((100 * rendered) / sentences.length)} %` : "";
  if (s === "waiting") st.innerHTML = `<span class="spinner"></span> Audio wird erzeugt …`;
  else if (s === "error") st.textContent = "Satz konnte nicht erzeugt werden – übersprungen";
  else if (s === "ended") st.textContent = "Ende erreicht";
  else st.textContent = pos + prog;
  $("#play").textContent = player.playing ? "⏸" : "▶";
  updateFollow();
}

async function pollProgress() {
  try {
    const d = (await api("/api/docs")).find((x) => x.id === docId);
    if (d) { rendered = d.rendered; if (!player.playing) showState(); }
  } catch { /* server gone */ }
}

async function main() {
  const [{ meta: m, doc }, s] = await Promise.all([api(`/api/docs/${docId}`), api("/api/settings")]);
  meta = m; settings = s; sentences = doc.sentences; mode = doc.kind;
  document.title = `${meta.title} – QuasselPage`;
  $("#title").textContent = meta.title;
  rendered = meta.rendered;
  if (meta.scanned) {
    const b = $("#banner");
    b.hidden = false;
    b.textContent = "Diese PDF enthält kaum Text (vermutlich gescannt) – nur der erkannte Text wird vorgelesen.";
  }

  // voices
  const vs = $("#voice");
  for (const [lang, names] of Object.entries(settings.voices)) {
    const g = document.createElement("optgroup");
    g.label = { en: "Englisch", de: "Deutsch" }[lang] || lang;
    for (const n of names) g.appendChild(new Option(n, n.toLowerCase()));
    vs.appendChild(g);
  }
  vs.value = settings.voice;
  $("#rate").value = String(settings.rate);
  $("#autoscroll").checked = settings.autoscroll;
  const dark = store.get("quasselpage.pdfdark", "0") === "1";
  document.documentElement.dataset.pdfdark = dark ? "1" : "0";

  player = new Player(docId, sentences, { voice: settings.voice, rate: settings.rate });
  view_ = mode === "pdf" ? pdfView : webView;
  await view_.init(doc);

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
  $("#rate").onchange = (e) => {
    const r = parseFloat(e.target.value);
    player.setRate(r);
    post("/api/settings", { rate: r });
  };
  vs.onchange = async (e) => {
    settings = await post("/api/settings", { voice: e.target.value });
    player.setVoice(settings.voice);
    post(`/api/docs/${docId}/position`, { sid: player.sid, voice: player.voice, playing: true });
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

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === " ") { e.preventDefault(); follow = true; player.toggle(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); player.next(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); player.prev(); }
    else if ((e.key === "+" || e.key === "=") && mode === "pdf") pdfView.setZoom(pdfView.zoom * 1.15);
    else if (e.key === "-" && mode === "pdf") pdfView.setZoom(pdfView.zoom / 1.15);
    else if (["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) stopFollowing();
  });

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
