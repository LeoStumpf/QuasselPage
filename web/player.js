// Sentence-wise player: one audio file per sentence, two <audio> elements alternate so the
// next sentence is already buffered (= near-gapless). Fires "sentence" and "state" events.

const CHARS_PER_SEC = 14; // rough estimate for sentences whose duration is not known yet

export class Player extends EventTarget {
  constructor(docId, sentences, { voice, rate = 1 }) {
    super();
    this.docId = docId;
    this.sentences = sentences;
    this.voice = voice;
    this.rate = rate;
    this.sid = 0;
    this.playing = false;
    this.k = 0;
    this.durations = new Map();
    this.state = "paused";
    this.a = [this._mk(), this._mk()];
  }

  get cur() { return this.a[this.k]; }
  get nxt() { return this.a[1 - this.k]; }
  get n() { return this.sentences.length; }

  _mk() {
    const el = new Audio();
    el.preload = "auto";
    el.preservesPitch = true;
    el.addEventListener("ended", () => this._ended(el));
    el.addEventListener("playing", () => el === this.cur && this._setState("playing"));
    el.addEventListener("waiting", () => el === this.cur && this.playing && this._setState("waiting"));
    el.addEventListener("loadedmetadata", () => {
      if (isFinite(el.duration)) this.durations.set(el._sid, el.duration);
    });
    el.addEventListener("error", () => this._error(el));
    return el;
  }

  _url(sid) {
    return `/api/docs/${this.docId}/audio/${sid}?voice=${encodeURIComponent(this.voice)}`;
  }

  _load(el, sid) {
    if (el._sid === sid && el._voice === this.voice && !el.error) return;
    el._sid = sid;
    el._voice = this.voice;
    el.src = this._url(sid);
    el.defaultPlaybackRate = this.rate;
    el.playbackRate = this.rate;
    el.load();
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new CustomEvent("state", { detail: s }));
  }

  _emitSentence() {
    this.dispatchEvent(new CustomEvent("sentence", { detail: this.sid }));
  }

  _preloadNext() {
    if (this.sid + 1 < this.n) this._load(this.nxt, this.sid + 1);
  }

  _start(el, offset = 0) {
    el.playbackRate = this.rate;
    try { el.currentTime = offset; } catch { /* not seekable yet */ }
    this.playing = true;
    this._setState(el.readyState >= 3 ? "playing" : "waiting");
    el.play().catch((e) => {
      if (e.name === "NotAllowedError") { this.playing = false; this._setState("paused"); }
    });
  }

  playFrom(sid, offset = 0) {
    sid = Math.max(0, Math.min(this.n - 1, sid));
    this.nxt.pause();
    this.cur.pause();
    this.sid = sid;
    if (this.nxt._sid === sid && !this.nxt.error) this.k = 1 - this.k;
    this._load(this.cur, sid);
    this._start(this.cur, offset);
    this._emitSentence();
    this._preloadNext();
  }

  /** Select a sentence without starting playback. */
  select(sid) {
    this.pause();
    this.sid = Math.max(0, Math.min(this.n - 1, sid));
    this._emitSentence();
  }

  pause() {
    this.playing = false;
    this.cur.pause();
    this._setState("paused");
  }

  toggle() {
    if (this.playing) return this.pause();
    if (this.cur._sid === this.sid && this.cur._voice === this.voice && !this.cur.error && !this.cur.ended) {
      this._start(this.cur, this.cur.currentTime);
    } else {
      this.playFrom(this.sid);
    }
  }

  next() { if (this.sid + 1 < this.n) this._go(this.sid + 1); }
  prev() {
    if (this.cur.currentTime > 2 && this.cur._sid === this.sid) return this._go(this.sid);
    this._go(Math.max(0, this.sid - 1));
  }
  _go(sid) { this.playing ? this.playFrom(sid) : this.select(sid); }

  _dur(sid) {
    return this.durations.get(sid) ?? Math.max(1.5, this.sentences[sid].text.length / CHARS_PER_SEC);
  }

  seek(delta) {
    const el = this.cur;
    let sid = this.sid;
    let t = (el._sid === sid ? el.currentTime : 0) + delta;
    if (t >= 0 && t < this._dur(sid) - 0.05) {
      if (el._sid === sid) { el.currentTime = t; return; }
    }
    while (t < 0 && sid > 0) { sid--; t += this._dur(sid); }
    while (t >= this._dur(sid) && sid < this.n - 1) { t -= this._dur(sid); sid++; }
    t = Math.max(0, t);
    if (this.playing) this.playFrom(sid, sid === this.sid ? t : (this.durations.has(sid) ? t : 0));
    else this.select(sid);
  }

  setRate(rate) {
    this.rate = rate;
    for (const el of this.a) { el.defaultPlaybackRate = rate; el.playbackRate = rate; }
  }

  setVoice(voice) {
    if (voice === this.voice) return;
    this.voice = voice;
    this.durations.clear();
    const wasPlaying = this.playing;
    this.pause();
    for (const el of this.a) { el.removeAttribute("src"); el._sid = undefined; el.load(); }
    if (wasPlaying) this.playFrom(this.sid);
  }

  _ended(el) {
    if (el !== this.cur) return;
    if (this.sid + 1 >= this.n) {
      this.playing = false;
      this._setState("ended");
      return;
    }
    this.k = 1 - this.k;
    this.sid += 1;
    this._load(this.cur, this.sid);
    this._start(this.cur, 0);
    this._emitSentence();
    this._preloadNext();
  }

  _error(el) {
    if (el !== this.cur || !this.playing) return;
    this._setState("error");
    // skip a sentence that could not be rendered instead of getting stuck
    setTimeout(() => { if (this.playing && el === this.cur && el.error) this._ended(el); }, 1200);
  }
}
