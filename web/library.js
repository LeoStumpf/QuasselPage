const $ = (s) => document.querySelector(s);
const msg = $("#msg");

function say(text, err = false) {
  msg.textContent = text;
  msg.classList.toggle("err", err);
}

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const body = r.headers.get("content-type")?.includes("json") ? await r.json() : null;
  if (!r.ok) throw new Error(body?.detail || r.statusText);
  return body;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------- covers
// [background, shape, ink] – colourful but calm; ink is the tag/initial colour (≥ 4.5:1 on white / bg)
const PALETTE = [
  ["#E0447A", "#FFC1D6", "#8A1340"],
  ["#2FB36B", "#BFF0D2", "#11603A"],
  ["#FFC83D", "#E07A4F", "#6B4A00"],
  ["#3B8BEB", "#CFE3FF", "#1A4E8F"],
  ["#0E6B55", "#A8E6CF", "#0A4D3D"],
  ["#E07A4F", "#E8B04B", "#6A2A0C"],
  ["#8C6BD9", "#E2D9FF", "#47308F"],
  ["#A8D672", "#4E8A2A", "#355E18"],
];

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function coverHtml(d, tag = true) {
  const h = hash(d.id);
  const [bg, shape, ink] = PALETTE[h % PALETTE.length];
  const shapes = [
    `<b style="right:-24%;top:-18%;width:95%;aspect-ratio:1;border-radius:50%;background:${shape}"></b>`,
    `<b style="left:-10%;bottom:22%;width:130%;height:14%;background:${shape};transform:rotate(-12deg)"></b>`,
    `<b style="left:18%;top:24%;width:52%;aspect-ratio:1;border-radius:50%;border:8px solid ${shape}"></b>`,
    `<b style="left:-20%;bottom:-24%;width:110%;aspect-ratio:1;border-radius:50%;background:${shape}"></b>`,
    `<b style="left:10%;top:42%;right:10%;height:22%;border-radius:6px;background:${shape}"></b>`,
  ][(h >>> 8) % 5];
  const kind = d.kind === "pdf" ? "PDF" : d.url ? "WEB" : "TEXT";
  const ini = esc((d.title || "?").trim().charAt(0).toUpperCase());
  return `<span class="ini" style="color:${ink}">${ini}</span>${shapes}${tag ? `<span class="tag" style="color:${ink}">${kind}</span>` : ""}`;
}

// ---------------------------------------------------------------- library
let docs = [];
let filter = store.get("quasselpage.filter", "all");
let lastSig = "";

const isCont = (d) => d.position > 0 && d.position < d.n - 1;
const FILTERS = {
  all: () => true,
  cont: isCont,
  pdf: (d) => d.kind === "pdf",
  web: (d) => d.kind !== "pdf",
};

function kindLine(d) {
  if (d.kind === "pdf") return `PDF · ${d.pages} ${d.pages === 1 ? "Seite" : "Seiten"}`;
  if (d.url) { try { return new URL(d.url).hostname.replace(/^www\./, ""); } catch { return "Webseite"; } }
  return "Text";
}

function audioLine(d) {
  const pct = d.n ? Math.round((100 * d.rendered) / d.n) : 0;
  return pct >= 100 ? "Audio fertig" : `Audio ${pct} %`;
}

function render() {
  for (const [k, fn] of Object.entries(FILTERS)) {
    const el = document.querySelector(`[data-c="${k}"]`);
    if (el) el.textContent = docs.filter(fn).length;
  }
  document.querySelectorAll("#filters button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.f === filter)));

  // "Weiterhören": most recently opened document that is started but not finished
  const cont = docs.find(isCont);
  $("#contsec").hidden = !cont;
  if (cont) {
    $("#hero").innerHTML = `<a class="hero" href="/reader/${cont.id}">
      <span class="cover" style="background:${PALETTE[hash(cont.id) % PALETTE.length][0]}">${coverHtml(cont, false)}</span>
      <span class="txt">
        <span class="kind">${esc(kindLine(cont))}</span>
        <strong>${esc(cont.title)}</strong>
        <span class="where">weiter bei Satz ${cont.position + 1} von ${cont.n} · ${esc(audioLine(cont))}</span>
      </span>
      <span class="go" aria-label="Weiterhören"><svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg></span>
    </a>`;
  }

  const box = $("#docs");
  const list = docs.filter(FILTERS[filter] || FILTERS.all);
  if (!list.length) {
    box.innerHTML = `<p class="empty">${docs.length ? "Keine Dokumente in dieser Ansicht." : "Noch nichts importiert – zieh eine PDF hierher oder füge oben eine Webseiten-Adresse ein."}</p>`;
    return;
  }
  box.innerHTML = list.map((d) => {
    const [bg, , ink] = PALETTE[hash(d.id) % PALETTE.length];
    const heard = d.n > 1 ? Math.round((100 * d.position) / (d.n - 1)) : 0;
    const where = d.position > 0 ? (heard >= 100 ? " · fertig gehört" : ` · ${heard} % gehört`) : " · neu";
    return `<div class="tile">
      <a class="cover" href="/reader/${d.id}" style="background:${bg}" aria-hidden="true" tabindex="-1">${coverHtml(d)}</a>
      <a class="ttl" href="/reader/${d.id}">${esc(d.title)}</a>
      <div class="info">${esc(kindLine(d))}${where} · ${esc(audioLine(d))}</div>
      <div class="prog" style="background:${bg}33"><i style="width:${heard}%;background:${bg}"></i></div>
      <button class="del" data-del="${d.id}" title="Löschen" aria-label="„${esc(d.title)}“ löschen" style="color:${ink}">✕</button>
    </div>`;
  }).join("");
}

async function refresh(force = false) {
  try { docs = await api("/api/docs"); } catch { return; }
  const sig = JSON.stringify([docs, filter]);
  if (force || sig !== lastSig) { lastSig = sig; render(); }
  status();
}

async function status() {
  let s;
  try { s = await api("/api/status"); } catch { return; }
  const led = $("#led");
  led.className = "led" + (s.busy ? " busy" : s.loaded ? " on" : "");
  $("#tts").textContent = s.busy ? "rendert gerade …"
    : s.paused ? "Vorrendern pausiert"
    : s.loaded ? "Modell geladen · bereit" : "ruht (lädt bei Bedarf)";
  const n = docs.reduce((a, d) => a + d.n, 0), r = docs.reduce((a, d) => a + Math.min(d.rendered, d.n), 0);
  $("#ttsbar").style.width = n ? `${(100 * r) / n}%` : "0";
}

$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  filter = b.dataset.f;
  store.set("quasselpage.filter", filter);
  render();
});

$("#docs").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del]");
  if (!btn) return;
  if (btn.dataset.confirm !== "1") {        // two-step delete instead of a blocking confirm()
    btn.dataset.confirm = "1";
    btn.textContent = "Wirklich löschen?";
    setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ""; btn.textContent = "✕"; } }, 3000);
    return;
  }
  await api(`/api/docs/${btn.dataset.del}`, { method: "DELETE" });
  refresh(true);
});

// ---------------------------------------------------------------- import
async function importFiles(files) {
  for (const f of files) {
    say(`Lese „${f.name}“ …`);
    const fd = new FormData();
    fd.append("file", f);
    try {
      const d = await api("/api/import/pdf", { method: "POST", body: fd });
      say(`„${d.title}“ importiert – ${d.n} Sätze. Audio wird im Hintergrund erzeugt.`);
    } catch (e) { say(e.message, true); }
    refresh(true);
  }
}

$("#file").addEventListener("change", (e) => { importFiles([...e.target.files]); e.target.value = ""; });
const drop = $("#drop");
let dragDepth = 0;
drop.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; drop.classList.add("over"); });
drop.addEventListener("dragover", (e) => e.preventDefault());
drop.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove("over"); } });
drop.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; drop.classList.remove("over");
  const pdfs = [...e.dataTransfer.files].filter((f) => f.name.toLowerCase().endsWith(".pdf"));
  if (pdfs.length) importFiles(pdfs); else say("Bitte eine PDF-Datei ablegen.", true);
});

$("#urlform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("#url").value.trim();
  say("Lade Seite …");
  try {
    const d = await api("/api/import/url", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
    });
    say(`„${d.title}“ importiert – ${d.n} Sätze.`);
    $("#url").value = "";
  } catch (e) { say(e.message, true); }
  refresh(true);
});

function showTextbox(on) {
  $("#textbox").hidden = !on;
  $("#texttoggle").setAttribute("aria-expanded", String(on));
  if (on) $("#text").focus();
}
$("#texttoggle").addEventListener("click", () => showTextbox($("#textbox").hidden));
$("#textcancel").addEventListener("click", () => showTextbox(false));
$("#textbtn").addEventListener("click", async () => {
  try {
    const d = await api("/api/import/text", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: $("#text").value, title: $("#ttitle").value }),
    });
    say(`„${d.title}“ übernommen – ${d.n} Sätze.`);
    $("#text").value = ""; $("#ttitle").value = "";
    showTextbox(false);
  } catch (e) { say(e.message, true); }
  refresh(true);
});

// ---------------------------------------------------------------- settings / quit
api("/api/settings").then((s) => { $("#bg").checked = s.background; });
$("#bg").addEventListener("change", async (e) => {
  await api("/api/settings", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ background: e.target.checked }),
  });
  status();
});

$("#quit").addEventListener("click", async () => {
  clearInterval(timer);
  await fetch("/api/quit", { method: "POST" }).catch(() => {});
  document.body.innerHTML = '<main class="byebye"><img src="/static/icon.svg" alt="" width="72" height="72"><h1>QuasselPage beendet</h1><p class="muted">Dieses Fenster kann geschlossen werden.</p></main>';
});

refresh(true);
const timer = setInterval(refresh, 4000);
