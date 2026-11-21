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

async function refresh() {
  let docs;
  try { docs = await api("/api/docs"); } catch { return; }
  const box = $("#docs");
  if (!docs.length) {
    box.innerHTML = '<p class="muted">Noch nichts importiert.</p>';
    return;
  }
  box.innerHTML = docs.map((d) => {
    const pct = d.n ? Math.round((100 * d.rendered) / d.n) : 0;
    const kind = d.kind === "pdf" ? `PDF · ${d.pages} Seiten` : (d.url ? new URL(d.url).hostname : "Text");
    const where = d.position > 0 ? ` · bei Satz ${d.position + 1}` : "";
    return `<div class="doc">
      <a class="title" href="/reader/${d.id}">${esc(d.title)}</a>
      <div class="actions">
        <a href="/reader/${d.id}"><button class="primary">${d.position > 0 ? "Weiterhören" : "Öffnen"}</button></a>
        <button class="icon" data-del="${d.id}" title="Löschen">✕</button>
      </div>
      <div class="info">${esc(kind)} · ${d.n} Sätze${where} · Audio ${pct === 100 ? "fertig" : pct + " %"}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join("");
}

$("#docs").addEventListener("click", async (e) => {
  const id = e.target.closest("[data-del]")?.dataset.del;
  if (!id) return;
  const btn = e.target.closest("button");
  if (btn.dataset.confirm !== "1") {        // two-step delete instead of a blocking confirm()
    btn.dataset.confirm = "1";
    btn.textContent = "Wirklich löschen?";
    setTimeout(() => { btn.dataset.confirm = ""; btn.textContent = "✕"; }, 3000);
    return;
  }
  await api(`/api/docs/${id}`, { method: "DELETE" });
  refresh();
});

async function importFiles(files) {
  for (const f of files) {
    say(`Lese „${f.name}“ …`);
    const fd = new FormData();
    fd.append("file", f);
    try {
      const d = await api("/api/import/pdf", { method: "POST", body: fd });
      say(`„${d.title}“ importiert – ${d.n} Sätze. Audio wird im Hintergrund erzeugt.`);
    } catch (e) { say(e.message, true); }
    refresh();
  }
}

const drop = $("#drop");
$("#file").addEventListener("change", (e) => importFiles(e.target.files));
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault(); drop.classList.remove("over");
  importFiles([...e.dataTransfer.files].filter((f) => f.name.toLowerCase().endsWith(".pdf")));
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
  refresh();
});

$("#textbtn").addEventListener("click", async () => {
  try {
    const d = await api("/api/import/text", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: $("#text").value, title: $("#ttitle").value }),
    });
    say(`„${d.title}“ übernommen – ${d.n} Sätze.`);
    $("#text").value = ""; $("#ttitle").value = "";
  } catch (e) { say(e.message, true); }
  refresh();
});

api("/api/settings").then((s) => { $("#bg").checked = s.background; });
$("#bg").addEventListener("change", (e) => api("/api/settings", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ background: e.target.checked }),
}));

$("#quit").addEventListener("click", async () => {
  await fetch("/api/quit", { method: "POST" }).catch(() => {});
  document.body.innerHTML = '<main class="lib"><h1>QuasselPage beendet</h1><p class="muted">Dieses Fenster kann geschlossen werden.</p></main>';
});

refresh();
setInterval(refresh, 4000);
