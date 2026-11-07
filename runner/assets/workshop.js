// Pixel Workshop shared runtime for /office and the Lanes dashboard (/).
// window.PixelSprites: atlas sprite player (one scheduler, frame changes only, pauses when hidden).
// window.CAUI: shared status mapping and helpers so both pages label states the same way.
(function () {
  'use strict';
  var BASE = '/assets/';
  var manifest = null, loading = null, images = {};
  var sprites = new Set();
  var motionPref = true; // motion is always on; only the OS reduced-motion setting turns effects off
  var mq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  var listeners = [];
  function motionOn() { return motionPref && !(mq && mq.matches); }
  function notify() { var on = motionOn(); listeners.forEach(function (f) { try { f(on); } catch (e) {} }); sprites.forEach(function (s) { s._render(true); }); }
  if (mq && mq.addEventListener) mq.addEventListener('change', notify);

  function load(base) {
    if (base) BASE = base;
    if (manifest) return Promise.resolve(manifest);
    if (loading) return loading;
    loading = fetch(BASE + 'sprites.json').then(function (r) { if (!r.ok) throw new Error('sprites.json ' + r.status); return r.json(); }).then(function (m) {
      var roles = Object.keys(m.roles);
      return Promise.all(roles.map(function (role) {
        return new Promise(function (res, rej) {
          var img = new Image();
          img.onload = function () { images[role] = { url: BASE + m.roles[role].atlas, w: img.naturalWidth, h: img.naturalHeight }; res(); };
          img.onerror = function () { rej(new Error('atlas ' + role)); };
          img.src = BASE + m.roles[role].atlas;
        });
      })).then(function () { manifest = m; return m; });
    });
    loading.catch(function () { loading = null; });
    return loading;
  }

  // seed (e.g. a lane id) phase-offsets loops so identical roles never move in lockstep.
  function seedOf(s) { s = String(s || ''); var h = 7; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003; return h; }

  // create(role, {scale, seed, clip}) -> sprite. The element is cell*scale square; its foot is at
  // (anchor[0]*scale, anchor[1]*scale) inside it. Unknown roles fall back to 'builder'.
  // Requires load() to have resolved; otherwise returns a sprite whose element has class px-fallback.
  function create(role, opts) {
    opts = opts || {};
    var scale = opts.scale || 2;
    var el = document.createElement('div');
    el.className = 'px-sprite';
    el.setAttribute('aria-hidden', 'true');
    if (!manifest || (!manifest.roles[role] && !manifest.roles.builder)) { el.className += ' px-fallback'; return { el: el, role: role, clip: '', play: function () {}, setClip: function () {}, setScale: function () {}, destroy: function () { el.remove(); }, fallback: true }; }
    if (!manifest.roles[role]) role = 'builder';
    var cell = manifest.cell, img = images[role];
    var s = {
      el: el, role: role, clip: opts.clip || 'idle', once: null, start: 0, frame: -1, scale: scale,
      offset: seedOf(opts.seed) % 4000,
      // Loop clip: plays forever. play(clip) with a non-loop clip plays once then returns to the loop clip.
      setClip: function (c) { if (!this._clip(c)) return; if (this.clip === c && !this.once) return; this.clip = c; this.once = null; this.start = performance.now(); this._render(true); kick(); },
      play: function (c, onEnd) {
        if (!this._clip(c)) return;
        if (!motionOn()) { if (onEnd) onEnd(); return; }
        if (this.once && this.once.prio > prio(c)) return; // completion outranks a step cue
        this.once = { clip: c, start: performance.now(), onEnd: onEnd, prio: prio(c) }; this._render(true); kick();
      },
      setScale: function (k) { this.scale = k; size(); this._render(true); },
      destroy: function () { sprites.delete(this); el.remove(); },
      _clip: function (c) { return manifest.roles[role].clips[c]; },
      _render: function (force) {
        var now = performance.now(), clipName = this.clip, t, clip, fi;
        if (this.once) {
          clip = this._clip(this.once.clip); t = now - this.once.start;
          var total = clip.frames.reduce(function (a, f) { return a + f.durationMs; }, 0);
          if (t >= total || !motionOn()) { var cb = this.once.onEnd; this.once = null; if (cb) try { cb(); } catch (e) {} return this._render(true); }
          clipName = this.once.clip; fi = frameAt(clip, t, false);
        } else {
          clip = this._clip(clipName);
          fi = motionOn() && !document.hidden ? frameAt(clip, now - this.start + this.offset, clip.loop) : (clip.staticFrame || 0);
        }
        var key = clipName + ':' + fi;
        if (!force && key === this.frame) return;
        this.frame = key;
        var r = clip.frames[fi].rect, k = this.scale;
        el.style.backgroundPosition = (-r[0] * k) + 'px ' + (-r[1] * k) + 'px';
        el.dataset.clip = clipName; el.dataset.frame = fi;
      },
    };
    function size() { var k = s.scale; el.style.width = cell[0] * k + 'px'; el.style.height = cell[1] * k + 'px'; el.style.backgroundSize = img.w * k + 'px ' + img.h * k + 'px'; }
    el.style.backgroundImage = 'url("' + img.url + '")';
    size();
    sprites.add(s); s._render(true); kick();
    return s;
  }
  function prio(c) { return c === 'complete' ? 3 : c === 'receive' ? 2 : 1; }
  function frameAt(clip, t, loop) {
    var total = 0, i; for (i = 0; i < clip.frames.length; i++) total += clip.frames[i].durationMs;
    if (loop) t = ((t % total) + total) % total; else if (t >= total) return clip.frames.length - 1;
    for (i = 0; i < clip.frames.length; i++) { t -= clip.frames[i].durationMs; if (t < 0) return i; }
    return clip.frames.length - 1;
  }
  var raf = 0;
  function tick() { raf = 0; if (document.hidden) return; sprites.forEach(function (s) { if (!s.el.isConnected) { sprites.delete(s); return; } s._render(false); }); if (sprites.size && motionOn()) raf = requestAnimationFrame(tick); }
  function kick() { if (!raf && !document.hidden) raf = requestAnimationFrame(tick); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { sprites.forEach(function (s) { s._render(true); }); kick(); } });
  listeners.push(function (on) { if (on) kick(); });

  window.PixelSprites = {
    load: load, create: create,
    get manifest() { return manifest; },
    anchor: function () { return manifest ? manifest.anchor : [32, 57]; },
    motion: function () { return motionOn(); },
    onMotion: function (f) { listeners.push(f); },
    count: function () { return sprites.size; },
  };

  // Shared status vocabulary. key drives colour (run, done, warn, bad, idle); label is the written text.
  function status(health, result) {
    var h = String(health || '').split('(')[0].trim();
    var lower = h.toLowerCase();
    if (!h) h = result || 'planned';
    if (/^running/.test(lower)) return { key: 'run', label: 'Running', raw: h };
    if (lower === 'done') return { key: 'done', label: 'Done', raw: h };
    if (lower === 'thinking' || lower === 'quiet') return { key: 'warn', label: h.charAt(0).toUpperCase() + h.slice(1), raw: h };
    if (lower === 'needs review') return { key: 'warn', label: 'Needs review', raw: h };
    // paused: the lane hit its time limit (a safeguard, resumable); continued: a later lane picked it up.
    if (lower === 'paused') return { key: 'warn', label: 'Paused', raw: h };
    if (lower === 'continued') return { key: 'idle', label: 'Continued', raw: h };
    if (lower === 'stopped' || lower === 'killed' || lower === 'attention' || lower === 'partial') return { key: 'warn', label: h.charAt(0).toUpperCase() + h.slice(1), raw: h };
    if (h === 'STALLED' || h === 'DEAD' || lower === 'failed') return { key: 'bad', label: lower === 'failed' ? 'Failed' : h.charAt(0) + h.slice(1).toLowerCase(), raw: h };
    if (lower === 'planned' || lower === 'waiting') return { key: 'idle', label: lower === 'waiting' ? 'Waiting' : 'Planned', raw: h };
    // Plan states: closed = the lead closed it with work left undone; dropped = a lane the lead decided not to run.
    if (lower === 'closed') return { key: 'done', label: 'Closed', raw: h };
    if (lower === 'dropped') return { key: 'idle', label: 'Dropped', raw: h };
    if (lower === 'verifying') return { key: 'warn', label: 'Verifying', raw: h };
    return { key: 'idle', label: h.charAt(0).toUpperCase() + h.slice(1), raw: h };
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function badge(st) { return '<span class="ca-badge s-' + st.key + '">' + esc(st.label) + '</span>'; }
  // Reload this tab when the dashboard's pages or assets change on disk (checked every 10 s, skipped in demo mode
  // and while the user is typing so a draft is never lost).
  var uiVersion = null;
  function watchUi() {
    if (/[?&]demo=/.test(location.search)) return;
    setInterval(function () {
      fetch('/api/ui', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.version) return;
        if (uiVersion === null) { uiVersion = j.version; return; }
        var a = document.activeElement, typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.value;
        if (j.version !== uiVersion && !typing) location.reload();
      }).catch(function () {});
    }, 10000);
  }
  if (typeof location !== 'undefined' && typeof setInterval === 'function') watchUi();
  // ---------- tokens ----------
  // A token record is { input, output, reasoning, cacheRead, steps, total }. total may be missing on old lanes.
  function tokenTotal(t) {
    if (!t) return 0;
    if (typeof t.total === 'number') return t.total;
    return (+t.input || 0) + (+t.output || 0) + (+t.reasoning || 0) + (+t.cacheRead || 0);
  }
  // 0, 950, 12.3k, 1.24M
  function fmtTokens(n) {
    n = +n || 0;
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n < 1e4 ? (n / 1e3).toFixed(1) : Math.round(n / 1e3)) + 'k';
    return (n < 1e7 ? (n / 1e6).toFixed(2) : (n / 1e6).toFixed(1)) + 'M';
  }
  // "12.3k in / 4.1k out / 900 reasoning / 30k cache"
  function tokenDetail(t) {
    t = t || {};
    var bits = [fmtTokens(t.input) + ' in', fmtTokens(t.output) + ' out'];
    if (+t.reasoning) bits.push(fmtTokens(t.reasoning) + ' reasoning');
    if (+t.cacheRead) bits.push(fmtTokens(t.cacheRead) + ' cache');
    return bits.join(' / ');
  }
  // Per-agent split of a lane or plan: [{ role, label, total }] for build, review and other (hidden CodeArts sessions).
  var ROLE_LABEL = { build: 'Builder', review: 'Reviewer', other: 'Hidden sessions' };
  function tokenSplit(by) {
    by = by || {};
    return ['build', 'review', 'other'].map(function (r) { return { role: r, label: ROLE_LABEL[r], total: tokenTotal(by[r]), t: by[r] || {} }; });
  }

  // ---------- lane controls ----------
  // The server lists the allowed action ids per lane (laneView.actions) and one suggested id (laneView.suggest).
  // Pages render buttons from this table; control() sends them. danger: needs a confirm(). note: optional text box.
  var ACTIONS = {
    'skip-wait': { label: 'Retry now', title: 'Skip the backoff wait and retry the model at once', path: 'kick', body: { mode: 'now' } },
    kick: { label: 'Retry turn', title: 'Abort the current turn and continue in the same session (context kept)', path: 'kick', body: { mode: 'turn' }, note: true },
    fresh: { label: 'Fresh session', title: 'Abort and continue in a new session with a continuation brief (context dropped)', path: 'kick', body: { mode: 'fresh' }, danger: 'Start a fresh session? The worker loses its conversation context; commits stay.', note: true },
    'restart-server': { label: 'Restart server', title: 'Restart the private codearts server (connection problems), then resume the same session', path: 'kick', body: { mode: 'server' }, danger: 'Restart the codearts server of this lane? The session resumes after the restart.' },
    resume: { label: 'Resume', title: 'Continue this lane in place: same id, commits kept, optional note for the worker', path: 'resume', note: true },
    stop: { label: 'Stop', title: 'Abort the session and end the lane (resumable later)', path: 'stop', danger: 'Stop this lane? You can resume it later.' },
    attach: { label: 'Open TUI', title: 'Open the CodeArts TUI on the live session in a new window', path: 'attach' },
  };
  // Ready-made steering messages for one-click steering.
  var QUICK_STEERS = [
    { label: 'Continue', text: 'Continue with the next unfinished step of the brief. Commit after each step that works.' },
    { label: 'Commit and go on', text: 'Commit what already works now with the right "step N:" subject, then continue with the next step.' },
    { label: 'Stop planning', text: 'Stop planning. Make the next concrete edit now, run the check, and read its output.' },
    { label: 'Run the checks', text: 'Run every CHECK line from the brief now, fix what fails, and commit the fixes.' },
    { label: 'Wrap up', text: 'Wrap up: finish the current step, commit it, run the checks, and reply with the steps and commit hashes.' },
  ];
  // control('lane-id', 'resume', { note: '...' }) or control(id, 'kick', { text }) -> Promise<{ ok, message } | { error }>
  function control(laneId, action, extra) {
    var a = ACTIONS[action];
    if (!a) return Promise.resolve({ error: 'unknown action ' + action });
    var body = Object.assign({}, a.body || {}, extra || {});
    return fetch('/api/lane/' + encodeURIComponent(laneId) + '/' + a.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return r.ok ? Object.assign({ ok: true }, j) : { error: j.error || ('HTTP ' + r.status) }; }); })
      .catch(function (e) { return { error: String(e && e.message || e) }; });
  }

  window.CAUI = { status: status, esc: esc, badge: badge, shortModel: function (m) { return String(m || '').replace(/^huaweicloud-maas\//, 'codearts/'); },
    tokenTotal: tokenTotal, fmtTokens: fmtTokens, tokenDetail: tokenDetail, tokenSplit: tokenSplit, ACTIONS: ACTIONS, QUICK_STEERS: QUICK_STEERS, control: control };
})();
