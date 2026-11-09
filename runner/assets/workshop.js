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
  // ---------- time taken ----------
  // Human duration, same format as the CLI (ca.mjs fmtDur): 45s / 12m / 2h 0m / 3d 4h.
  function fmtDur(ms) {
    var s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  }
  // Local HH:MM, with the date appended when the moment is not today (a plan may span days).
  function fmtClock(t) {
    var d = new Date(t); if (isNaN(d.getTime())) return '?';
    var n = new Date();
    var hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    var today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return today ? hm : hm + ' ' + d.toLocaleDateString();
  }
  var SEG_COLOR = { planning: 'var(--lead)', lanes: 'var(--builder)', between: 'var(--faint)', verify: 'var(--muted)' };
  var PHASE_LABEL = { build: 'Build', checks: 'Checks', fix: 'Fix', review: 'Review', wait: 'Waiting', other: 'Other' };
  // The inner HTML of the "time taken" hover card, shared by the Office chip and the Lanes plan head.
  // time: { startedAt, endedAt, live, totalMs, segments:[{key,label,ms}], work:{totalMs,byPhase}, lanes:[{task,ms}] }.
  function timeCard(time) {
    if (!time) return '';
    var segs = Array.isArray(time.segments) ? time.segments : [];
    var barSum = segs.reduce(function (a, s) { return a + (+s.ms || 0); }, 0) || 1;
    var bar = segs.filter(function (s) { return (+s.ms || 0) > 0; }).map(function (s) {
      return '<span style="width:' + (100 * (+s.ms || 0) / barSum) + '%;background:' + (SEG_COLOR[s.key] || 'var(--faint)') + '"></span>';
    }).join('');
    var rows = segs.filter(function (s) { return (+s.ms || 0) > 0 || s.key === 'lanes'; }).map(function (s) {
      return '<div class="tc-row"><span class="tc-sw" style="background:' + (SEG_COLOR[s.key] || 'var(--faint)') + '"></span><span class="tc-l">' + esc(s.label) + '</span><span class="tc-v">' + fmtDur(s.ms) + '</span></div>';
    }).join('');
    var byPhase = (time.work && time.work.byPhase) || {};
    var prows = ['build', 'checks', 'fix', 'review', 'wait', 'other'].filter(function (k) { return (+byPhase[k] || 0) > 0; }).map(function (k) {
      return '<div class="tc-row"><span class="tc-l">' + PHASE_LABEL[k] + '</span><span class="tc-v">' + fmtDur(byPhase[k]) + '</span></div>';
    }).join('');
    var lanes = Array.isArray(time.lanes) ? time.lanes : [];
    var lrows = lanes.map(function (l) {
      return '<div class="tc-row"><span class="tc-l">' + esc(l.task) + '</span><span class="tc-v">' + fmtDur(l.ms) + '</span></div>';
    }).join('');
    var foot = 'Started ' + esc(fmtClock(time.startedAt)) + (time.live ? ' \u00b7 still running' : (time.endedAt != null ? ' \u00b7 finished ' + esc(fmtClock(time.endedAt)) : ''));
    return '<div class="tc-kicker">' + (time.live ? 'Time so far' : 'Time taken') + '</div>' +
      '<div class="tc-big">' + fmtDur(time.totalMs) + '</div>' +
      (bar ? '<div class="tc-bar">' + bar + '</div>' : '') +
      '<div class="tc-sec">' + rows + '</div>' +
      (prows ? '<div class="tc-sec"><div class="tc-kicker">Worker time ' + fmtDur(time.work && time.work.totalMs) + '</div>' + prows + '</div>' : '') +
      (lrows ? '<div class="tc-sec"><div class="tc-kicker">By lane</div>' + lrows + '</div>' : '') +
      '<div class="tc-foot">' + foot + '</div>';
  }
  function timeRowsByPhase(byPhase) {
    var by = byPhase || {};
    return ['build', 'checks', 'fix', 'review', 'wait', 'other'].filter(function (k) { return (+by[k] || 0) > 0; }).map(function (k) { return PHASE_LABEL[k] + ' ' + fmtDur(by[k]); }).join(' / ');
  }

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

  // ---------- floating surfaces ----------
  // place(el, anchor, { side = 'bottom', align = 'start', gap = 8, margin = 8 }): keep a fixed element
  // next to its anchor, flipping sides when it will not fit and clamping inside the viewport with margin.
  // The element should have overflow: auto so a tall body scrolls instead of leaving the screen.
  function place(el, anchor, opts) {
    opts = opts || {};
    var side = opts.side || 'bottom', align = opts.align || 'start';
    var gap = opts.gap == null ? 8 : opts.gap, margin = opts.margin == null ? 8 : opts.margin;
    if (!el || !anchor || !anchor.getBoundingClientRect) return;
    var a = anchor.getBoundingClientRect();
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    // the smaller of the layout and visual viewport: a phone rotating or a mobile browser bar
    // changing size can report a transient innerHeight larger than what is visible
    var vv = window.visualViewport, de = document.documentElement;
    var vh = Math.min(window.innerHeight || 1e9, (de && de.clientHeight) || 1e9, (vv && vv.height) || 1e9);
    if (vh >= 1e9) vh = 0;
    var ew = el.offsetWidth || 0, eh = el.offsetHeight || 0;
    var roomBelow = vh - a.bottom - gap - margin, roomAbove = a.top - gap - margin;
    if (side === 'top') { if (roomAbove < Math.min(eh || 64, 120) && roomBelow > roomAbove) side = 'bottom'; }
    else { if (roomBelow < Math.min(eh || 64, 120) && roomAbove > roomBelow) side = 'top'; }
    var avail = side === 'top' ? roomAbove : roomBelow;
    if (avail < 64) avail = Math.max(64, Math.min(eh || 64, vh - 2 * margin));
    var h = Math.min(eh || avail, avail);
    var top = side === 'top' ? (a.top - gap - h) : (a.bottom + gap);
    var left;
    if (align === 'end') left = a.right - ew; else if (align === 'center') left = a.left + (a.width - ew) / 2; else left = a.left;
    if (left + ew > vw - margin) left = vw - margin - ew;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    if (top + h > vh - margin) top = Math.max(margin, vh - margin - h);
    el.style.position = 'fixed';
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.style.maxHeight = Math.round(avail) + 'px';
  }
  // track(el, anchor, opts): place now and on window resize and scroll (capture). Returns a stop function.
  function track(el, anchor, opts) {
    var raf = 0;
    function now() { place(el, anchor, opts); }
    // place at once, then again on the next frame, after the browser has settled the new viewport
    function run() { now(); if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(function () { raf = 0; now(); }); }
    var vv = window.visualViewport;
    var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(run) : null;
    run();
    window.addEventListener('resize', run);
    window.addEventListener('scroll', run, true);
    if (vv) vv.addEventListener('resize', run);
    if (ro) ro.observe(document.documentElement);
    return function stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', run);
      window.removeEventListener('scroll', run, true);
      if (vv) vv.removeEventListener('resize', run);
      if (ro) ro.disconnect();
    };
  }
  // toast(msg, { tone = 'info' | 'bad', ms = 3200 }): one status toast at the bottom centre.
  // It animates in, animates out before removal, and a new toast replaces the old one.
  var toastEl = null, toastTimer = 0;
  function toast(msg, opts) {
    opts = opts || {};
    var ms = opts.ms == null ? 3200 : opts.ms;
    if (toastEl) { clearTimeout(toastTimer); try { toastEl.remove(); } catch (e) {} toastEl = null; }
    var el = document.createElement('div');
    el.className = 'ca-toast' + (opts.tone === 'bad' ? ' bad' : '');
    el.setAttribute('role', 'status');
    el.textContent = String(msg == null ? '' : msg);
    document.body.appendChild(el);
    toastEl = el;
    var drop = function () { if (el.isConnected) el.remove(); if (toastEl === el) toastEl = null; };
    toastTimer = setTimeout(function () {
      el.style.animation = 'ca-pop-out var(--dur-2) var(--ease-out) forwards';
      el.addEventListener('animationend', drop, { once: true });
      setTimeout(drop, 400);
    }, ms);
    return el;
  }

  // ---------- clipboard ----------
  function copyText(t) {
    t = String(t == null ? '' : t);
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).then(function () { return true; }, function () { return false; });
    try {
      var ta = document.createElement('textarea');
      ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy'); ta.remove(); return Promise.resolve(ok);
    } catch (e) { return Promise.resolve(false); }
  }

  // ---------- update notice ----------
  // A pill in the shared top bar when a newer CLI is available. Both pages get it from here.
  function updateFixture() {
    return { current: '0.2.0', latest: '0.3.0', available: true,
      notes: [{ version: '0.3.0', date: '2026-11-08', items: [
        'Update check: ca update --check, a notice in the CLI and this pill',
        'Agent windows and menus always stay on screen',
        'Animations and polish across the Office and Lanes'] }],
      cmd: 'npm install -g github:Kahar90/codeartsclimcp' };
  }
  function updateDismissed(latest) { try { return localStorage.getItem('ca-update-dismissed') === latest; } catch (e) { return false; } }
  function dismissUpdate(latest) { try { localStorage.setItem('ca-update-dismissed', latest); } catch (e) {} }
  function initUpdate() {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
    var top = document.querySelector('.ca-top');
    if (!top || typeof fetch !== 'function') return;
    var demo = /(^|[?&])update=demo(&|$)/.test(location.search);
    var get = demo ? Promise.resolve(updateFixture())
      : fetch('/api/update', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    get.then(function (info) {
      if (!info || info.available !== true || !info.latest) return;
      if (updateDismissed(info.latest)) return;
      mountUpdate(top, info, demo);
    }).catch(function () {});
  }
  function mountUpdate(top, info, demo) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ca-update';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('title', 'A newer CodeArts CLI is available');
    btn.innerHTML = '<span class="ca-update-dot" aria-hidden="true"></span><span class="ca-update-l">Update</span><span class="ca-update-v">' + esc(info.latest) + '</span>';
    var counts = top.querySelector('.ca-counts');
    if (counts && counts.parentNode === top) top.insertBefore(btn, counts); else top.appendChild(btn);

    var pop = null, stopTrack = null, clickTimer = 0;
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    function onDoc(e) { if (pop && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close(); }
    function close() {
      if (!pop) return;
      var p = pop; pop = null;
      if (stopTrack) { stopTrack(); stopTrack = null; }
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onDoc, true);
      clearTimeout(clickTimer);
      p.style.animation = 'ca-pop-out var(--dur-2) var(--ease-out) forwards';
      var drop = function () { if (p.isConnected) p.remove(); };
      p.addEventListener('animationend', drop, { once: true });
      setTimeout(drop, 400);
      btn.setAttribute('aria-expanded', 'false');
      try { btn.focus(); } catch (e) {}
    }
    function open() {
      if (pop) return;
      pop = buildPop();
      document.body.appendChild(pop);
      btn.setAttribute('aria-expanded', 'true');
      stopTrack = track(pop, btn, { side: 'bottom', align: 'end' });
      document.addEventListener('keydown', onKey, true);
      clickTimer = setTimeout(function () { document.addEventListener('click', onDoc, true); }, 0);
      var now = pop.querySelector('.ca-update-now');
      if (now) try { now.focus(); } catch (e) {}
    }
    function waitForUi() {
      return new Promise(function (resolve) {
        var tries = 0;
        var iv = setInterval(function () {
          tries++;
          fetch('/api/ui', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function () { clearInterval(iv); resolve(); }).catch(function () { if (tries > 240) { clearInterval(iv); resolve(); } });
        }, 500);
      });
    }
    function buildPop() {
      var el = document.createElement('div');
      el.className = 'ca-update-pop';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Update available');
      var notes = Array.isArray(info.notes) ? info.notes : [];
      var groups = notes.map(function (n) {
        var items = (Array.isArray(n.items) ? n.items : []).map(function (t) { return '<li>' + esc(t).replace(/`([^`]+)`/g, '<code>$1</code>') + '</li>'; }).join('');
        var head = esc(n.version || '') + (n.date ? ' &middot; ' + esc(n.date) : '');
        return '<div class="ca-update-grp"><div class="ca-update-gh">' + head + '</div><ul>' + items + '</ul></div>';
      }).join('');
      el.innerHTML =
        '<div class="ca-update-title">Update available</div>' +
        '<div class="ca-update-ver"><b>' + esc(info.current) + '</b><span class="ca-update-arrow" aria-hidden="true">&rarr;</span><b>' + esc(info.latest) + '</b></div>' +
        '<div class="ca-update-notes">' + groups + '</div>' +
        '<div class="ca-update-acts">' +
          '<button type="button" class="btn primary ca-update-now">Update now</button>' +
          '<button type="button" class="btn ca-update-copy">Copy command</button>' +
          '<button type="button" class="btn ca-update-later">Later</button>' +
        '</div>' +
        '<div class="ca-update-status" role="status" hidden><span class="ca-spin" aria-hidden="true"></span><span class="ca-update-st"></span></div>' +
        '<div class="ca-update-err" hidden></div>';
      var now = el.querySelector('.ca-update-now');
      var copy = el.querySelector('.ca-update-copy');
      var later = el.querySelector('.ca-update-later');
      var err = el.querySelector('.ca-update-err');
      var acts = el.querySelector('.ca-update-acts'), stat = el.querySelector('.ca-update-status'), st = el.querySelector('.ca-update-st');
      function busy(text) { acts.hidden = !!text; stat.hidden = !text; if (text) st.textContent = text; }
      copy.addEventListener('click', function () { copyText(info.cmd || '').then(function (ok) { toast(ok ? 'Command copied' : 'Copy failed', { tone: ok ? 'info' : 'bad' }); }); });
      later.addEventListener('click', function () { dismissUpdate(info.latest); if (btn.isConnected) btn.remove(); if (pop) close(); });
      now.addEventListener('click', function () {
        if (demo) { toast('Demo: would run the update'); return; }
        if (err) { err.hidden = true; err.textContent = ''; }
        busy('Installing the update...');
        fetch('/api/update', { method: 'POST', headers: { 'content-type': 'application/json' } })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (j) {
            if (!j || j.ok !== true) throw new Error((j && j.error) || 'update failed');
            busy('Restarting the dashboard...');
            return waitForUi();
          })
          .then(function () { location.reload(); })
          .catch(function (e) {
            busy(''); now.focus();
            if (err) { err.hidden = false; err.textContent = String((e && e.message) || e); }
            var fallback = document.createElement('button');
            fallback.type = 'button'; fallback.className = 'btn tiny ca-update-copy'; fallback.textContent = 'Copy command';
            fallback.addEventListener('click', function () { copyText(info.cmd || '').then(function (ok) { toast(ok ? 'Command copied' : 'Copy failed', { tone: ok ? 'info' : 'bad' }); }); });
            if (err && !err.querySelector('.ca-update-copy')) err.appendChild(fallback);
          });
      });
      return el;
    }
    btn.addEventListener('click', function () { if (pop) close(); else open(); });
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUpdate); else initUpdate();
  }

  window.CAUI = { status: status, esc: esc, badge: badge, shortModel: function (m) { return String(m || '').replace(/^huaweicloud-maas\//, 'codearts/'); },
    tokenTotal: tokenTotal, fmtTokens: fmtTokens, tokenDetail: tokenDetail, tokenSplit: tokenSplit, ACTIONS: ACTIONS, QUICK_STEERS: QUICK_STEERS, control: control,
    place: place, track: track, toast: toast, copyText: copyText, update: initUpdate,
    fmtDur: fmtDur, timeCard: timeCard, timeRowsByPhase: timeRowsByPhase };
})();
