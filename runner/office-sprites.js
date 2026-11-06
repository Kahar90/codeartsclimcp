// Office sprites: isometric vignettes, one per role, drawn as self-contained SVG strings.
// API: window.OfficeSprites.draw(role, { state: 'working' | 'idle', hue }) and .roles.
// World coords: x runs screen down-right, y screen down-left, z up (2:1 dimetric, 1 unit = 1 px).
(function () {
  'use strict';

  var ROLES = ['lead', 'builder', 'reviewer', 'fixer', 'done', 'idle'];
  var OX = 82;
  var OY = 186;
  var K = 1.3; // art scale about the foot anchor (80, 186)

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function n(v) { return Math.round(v * 10) / 10; }
  function hueNorm(h) {
    if (typeof h !== 'number' || !isFinite(h)) return 210;
    var x = Math.round(h) % 360;
    return x < 0 ? x + 360 : x;
  }
  function hex(h, s, l) {
    h = hueNorm(h); s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    function two(v) { var t = Math.round((v + m) * 255).toString(16); return t.length < 2 ? '0' + t : t; }
    return '#' + two(r) + two(g) + two(b);
  }

  // ---------- geometry ----------
  function P(x, y, z) { return [n(OX + x - y), n(OY + (x + y) / 2 - (z || 0))]; }
  function d(list) { return 'M ' + list.map(function (p) { return p[0] + ' ' + p[1]; }).join(' L ') + ' Z'; }
  function poly(list, fill, extra) { return '<path d="' + d(list) + '" fill="' + fill + '"' + (extra || '') + '/>'; }
  // Box from (x,y,z) with size (w,d,h). cols = [top, left(+y face), right(+x face)].
  function box(x, y, z, w, dp, h, cols, edge) {
    var t = z + h;
    var s = poly([P(x, y + dp, z), P(x + w, y + dp, z), P(x + w, y + dp, t), P(x, y + dp, t)], cols[1])
      + poly([P(x + w, y, z), P(x + w, y + dp, z), P(x + w, y + dp, t), P(x + w, y, t)], cols[2])
      + poly([P(x, y, t), P(x + w, y, t), P(x + w, y + dp, t), P(x, y + dp, t)], cols[0]);
    if (edge) {
      var a = P(x, y + dp, t), b = P(x + w, y + dp, t), e = P(x + w, y, t);
      s += '<path d="M ' + a[0] + ' ' + a[1] + ' L ' + b[0] + ' ' + b[1] + ' L ' + e[0] + ' ' + e[1] + '" fill="none" stroke="' + edge + '" stroke-width=".8" stroke-linejoin="round"/>';
    }
    return s;
  }
  // Transform for flat art on a vertical plane facing +y (local u = +x, local v = down).
  function planeY(x, y, z) { var p = P(x, y, z); return 'matrix(1 .5 0 1 ' + p[0] + ' ' + p[1] + ')'; }
  function shadow(c, x, y, r, op) {
    var p = P(x, y, 0);
    return '<ellipse cx="' + p[0] + '" cy="' + p[1] + '" rx="' + n(r * 1.41) + '" ry="' + n(r * 0.71) + '" fill="url(#' + c.p + 'sh)" opacity="' + (op || 1) + '"/>';
  }
  function line(x1, y1, x2, y2, w, col, extra) {
    return '<path d="M ' + n(x1) + ' ' + n(y1) + ' L ' + n(x2) + ' ' + n(y2) + '" stroke="' + col + '" stroke-width="' + w + '" stroke-linecap="round" fill="none"' + (extra || '') + '/>';
  }
  function path3(pts, w, col) {
    return '<path d="M ' + pts.map(function (q) { return n(q[0]) + ' ' + n(q[1]); }).join(' L ') + '" stroke="' + col + '" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
  }

  // ---------- palette ----------
  var CAST = {
    lead: { skin: '#c68a62', skinSh: '#a96f4b', hair: '#231c1c', style: 'part' },
    builder: { skin: '#f1c9a8', skinSh: '#dba886', hair: '#3b2a22', style: 'phones' },
    reviewer: { skin: '#8a5a3f', skinSh: '#71472f', hair: '#2a2130', style: 'bun' },
    fixer: { skin: '#e0ad86', skinSh: '#c58f69', hair: '#7a4a2a', style: 'cap' },
    done: { skin: '#f1c9a8', skinSh: '#dba886', hair: '#3b2a22', style: 'part' },
    idle: { skin: '#e0ad86', skinSh: '#c58f69', hair: '#3b2a22', style: 'part' }
  };

  function ctx(role, opts) {
    opts = opts || {};
    var state = opts.state === 'working' ? 'working' : 'idle';
    var hue = hueNorm(opts.hue);
    var w = state === 'working';
    var cast = CAST[role];
    return {
      role: role, state: state, working: w, hue: hue,
      p: 'os-' + role + '-' + hue + '-' + state + '-',
      skin: cast.skin, skinSh: cast.skinSh, hair: cast.hair, style: cast.style,
      top: hex(hue, 46, 54), topSh: hex(hue, 42, 41), topHi: hex(hue, 56, 66),
      dark: hex(hue, 22, 22), darkSh: hex(hue, 22, 15), darkHi: hex(hue, 20, 32),
      glow: hex(hue, 85, 66), glowHi: hex(hue, 90, 82), glowLo: hex(hue, 70, 48),
      glass: hex(hue, 70, 45), accent2: hex(hue + 150, 70, 70),
      ink: '#1d1b24', white: '#f4f6fa',
      deskT: '#e9e2d6', deskL: '#cdbfab', deskR: '#ad9d87', deskE: '#fbf7f0',
      metal: '#3b3f4c', metalSh: '#2a2d37',
      lapT: '#d9dee6', lapL: '#b7bfcb', lapR: '#9ea7b5',
      chairT: '#3a3f4c', chairL: '#2c303b', chairR: '#23262f',
      pants: '#2d3140', pantsSh: '#222533', shoe: '#17181f'
    };
  }

  function defs(c) {
    var p = c.p;
    return '<defs>'
      + '<radialGradient id="' + p + 'sh"><stop offset="0" stop-color="#000" stop-opacity=".5"/><stop offset=".6" stop-color="#000" stop-opacity=".22"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>'
      + '<linearGradient id="' + p + 'gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + c.glass + '" stop-opacity=".42"/><stop offset="1" stop-color="' + c.glass + '" stop-opacity=".12"/></linearGradient>'
      + '<radialGradient id="' + p + 'halo"><stop offset="0" stop-color="' + c.glow + '" stop-opacity=".35"/><stop offset="1" stop-color="' + c.glow + '" stop-opacity="0"/></radialGradient>'
      + '<linearGradient id="' + p + 'beam" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="' + c.glow + '" stop-opacity=".0"/><stop offset=".5" stop-color="' + c.glow + '" stop-opacity=".22"/><stop offset="1" stop-color="' + c.glow + '" stop-opacity=".0"/></linearGradient>'
      + '</defs>';
  }

  function wrap(c, css, body) {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 200" width="160" height="200" role="img">';
    if (c.working && css) s += '<style>' + css + '@media(prefers-reduced-motion:reduce){[class^="os-"]{animation:none!important}}</style>';
    return s + defs(c) + '<g transform="translate(80 186) scale(' + K + ') translate(-80 -186)">' + body + '</g></svg>';
  }

  // ---------- people (screen space, origin = hip point) ----------
  function head(c, o) {
    o = o || {};
    var s = '';
    var hx = -1, hy = -45;
    if (c.style === 'bun') s += '<circle cx="' + (hx + 5) + '" cy="' + (hy - 10.5) + '" r="5" fill="' + c.hair + '"/><path d="M ' + (hx + 1.6) + ' ' + (hy - 12.6) + ' a 4 4 0 0 1 5 -2.4" stroke="#fff" stroke-opacity=".22" stroke-width="1.2" fill="none"/>';
    s += '<rect x="-3.2" y="-37" width="6.4" height="8" rx="2" fill="' + c.skinSh + '"/>'
      + '<circle cx="' + hx + '" cy="' + hy + '" r="10.2" fill="' + c.skinSh + '"/>'
      + '<circle cx="' + (hx - 1.1) + '" cy="' + (hy - 0.4) + '" r="9.6" fill="' + c.skin + '"/>';
    // hair
    if (c.style === 'cap') {
      s += '<path d="M -11.6 -46.5 Q -11 -57.5 -0.5 -57.5 Q 10 -57.5 10.4 -46 L 9.6 -44 Q 0 -47.5 -11.6 -46.5 Z" fill="' + c.dark + '"/>'
        + '<path d="M -11.6 -46.6 Q -16 -46 -18.5 -44.2 Q -13 -43.4 -6 -45 Z" fill="' + c.darkSh + '"/>'
        + '<path d="M 9.6 -44 Q 10.5 -40 9 -37.5 L 7 -41 Z" fill="' + c.hair + '"/>'
        + '<circle cx="-1" cy="-55" r="1.6" fill="' + c.glow + '"/>';
    } else {
      s += '<path d="M -11.4 -45.5 Q -12 -57 -1 -57.2 Q 10.8 -57.4 10.6 -45 Q 10.4 -39.5 8.6 -37 L 7.4 -42.5 Q 5.5 -48.5 -1.5 -49.5 Q -4 -46.5 -11.4 -45.5 Z" fill="' + c.hair + '"/>'
        + '<path d="M -8.5 -51.5 Q -4 -55.6 2.5 -55" stroke="#ffffff" stroke-opacity=".22" stroke-width="1.3" fill="none" stroke-linecap="round"/>';
          }
    // face, turned toward the viewer's left
    var ey = hy + 0.8;
    s += (o.happy
      ? '<path d="M ' + (hx - 7.6) + ' ' + (ey + 0.6) + ' q 1.5 -1.8 3 0 M ' + (hx - 1.2) + ' ' + (ey + 0.6) + ' q 1.5 -1.8 3 0" stroke="' + c.ink + '" stroke-width="1.1" stroke-linecap="round" fill="none"/>'
      : '<ellipse cx="' + (hx - 6.1) + '" cy="' + ey + '" rx="1.25" ry="1.6" fill="' + c.ink + '"/>'
      + '<ellipse cx="' + (hx + 0.3) + '" cy="' + ey + '" rx="1.25" ry="1.6" fill="' + c.ink + '"/>')
      + '<circle cx="' + (hx - 8.3) + '" cy="' + (ey + 3.4) + '" r="1.9" fill="#ff7b6b" opacity=".25"/>'
      + '<path d="M ' + (hx - 4.6) + ' ' + (hy + 6) + ' q 1.7 1.3 3.4 0" stroke="' + c.ink + '" stroke-width="1" stroke-linecap="round" fill="none" opacity=".8"/>'
      + '<ellipse cx="' + (hx + 8.6) + '" cy="' + (hy + 1.2) + '" rx="2.1" ry="2.7" fill="' + c.skinSh + '"/>';
    if (o.glasses) {
      s += '<g fill="none" stroke="' + c.ink + '" stroke-width="1.1"><circle cx="' + (hx - 6.1) + '" cy="' + ey + '" r="3"/><circle cx="' + (hx + 0.5) + '" cy="' + ey + '" r="3"/>'
        + '<path d="M ' + (hx - 3.1) + ' ' + ey + ' L ' + (hx - 2.5) + ' ' + ey + ' M ' + (hx + 3.5) + ' ' + ey + ' L ' + (hx + 7.4) + ' ' + (ey - 0.6) + '"/></g>'
        + '<path d="M ' + (hx - 8) + ' ' + (ey - 1.6) + ' l 2 -1" stroke="#fff" stroke-width=".8" opacity=".7"/>';
    }
    if (c.style === 'phones') {
      s += '<path d="M -10.8 -47 Q -10 -60 0 -59.6 Q 10.6 -59.4 10.4 -46" stroke="' + c.dark + '" stroke-width="2.6" fill="none" stroke-linecap="round"/>'
        + '<rect x="6.2" y="-48.4" width="6" height="8.6" rx="2.8" fill="' + c.dark + '"/>'
        + '<rect x="7.6" y="-46.6" width="3.2" height="5" rx="1.6" fill="' + (c.working ? c.glow : c.darkHi) + '"/>';
    }
    return s;
  }

  function torso(c, fill, shade) {
    return '<path d="M -11 1 L -12.6 -21 Q -13 -30.5 -5 -31 L 5 -31 Q 13 -30.5 12.6 -21 L 11 1 Z" fill="' + fill + '"/>'
      + '<path d="M 5.2 -31 Q 13 -30.5 12.6 -21 L 11 1 L 5.5 1 Q 7.5 -14 5.2 -31 Z" fill="' + shade + '"/>';
  }

  // Seated, facing down-left, hands reaching forward to (hx2, hy2) relative to the hip.
  function seated(c, o) {
    o = o || {};
    var s = torso(c, c.top, c.topSh);
    if (o.collar) s += '<path d="M -5.5 -31 L -1 -25 L 3.5 -31 Z" fill="' + c.topHi + '"/>';
    s += head(c, o);
    var arms = path3([[-11, -27], [-15.5, -11], [-23, 0]], 6.4, c.top)
      + path3([[10, -27], [8, -11], [-7, -1]], 6.4, c.topSh);
    s += o.armClass ? '<g class="' + o.armClass + '">' + arms + '</g>' : arms;
    return s;
  }

  function standing(c, o) {
    o = o || {};
    var s = path3([[-4.5, -2], [-6.5, 30]], 7.4, c.pants) + path3([[4.5, -2], [5.5, 30]], 7.4, c.pantsSh)
      + '<path d="M -12.5 28.5 Q -12.5 33.6 -6 33.6 L -2.5 33.6 L -2.5 27.6 L -8 27.6 Q -12.5 27.6 -12.5 28.5 Z" fill="' + c.shoe + '"/>'
      + '<path d="M 1.6 28.5 L 9.4 28.5 L 9.4 33.6 L 3.5 33.6 Q 0.6 33.6 1.6 28.5 Z" fill="' + c.shoe + '"/>'
      + '<rect x="-12" y="-2" width="23.5" height="5" rx="2" fill="' + c.pantsSh + '"/>';
    // blazer over a white shirt
    s += torso(c, c.dark, c.darkSh)
      + '<path d="M -5 -31 L 0 -14 L 4.6 -31 Z" fill="' + c.white + '"/>'
      + '<path d="M -1.3 -29 L 1.1 -29 L 1.8 -18 L 0 -15.5 L -1.6 -18 Z" fill="' + c.glow + '"/>'
      + '<path d="M -5 -31 L -1.5 -21 L -6.5 -24 Z M 4.6 -31 L 1.5 -21 L 6.5 -24 Z" fill="' + c.darkHi + '"/>';
    s += head(c, o);
    var rest = path3([[10.5, -27], [12.5, -12], [11.5, -2]], 6.6, c.darkSh) + '<circle cx="11.5" cy="-1.2" r="3.2" fill="' + c.skinSh + '"/>';
    var point = path3([[0, 0], [-7, 0], [-12, -9]], 6.6, c.dark) + '<circle cx="-12.6" cy="-10.4" r="3.2" fill="' + c.skin + '"/>'
      + line(-13.4, -12, -15.6, -16, 2.2, c.skin);
    s += rest + '<g transform="translate(-11 -27)">' + (o.pointClass ? '<g class="' + o.pointClass + '">' + point + '</g>' : point) + '</g>';
    return s;
  }

  function at(x, y, z, body) { var p = P(x, y, z); return '<g transform="translate(' + p[0] + ' ' + p[1] + ')">' + body + '</g>'; }

  // ---------- furniture ----------
  function officeChair(c, x, y, accent) {
    var s = box(x - 1, y - 1, 0, 2, 2, 15, [c.metal, c.metalSh, c.metalSh]);
    var a = P(x - 8, y, 1), b = P(x + 8, y, 1), e = P(x, y - 8, 1), f = P(x, y + 8, 1);
    s += line(a[0], a[1], b[0], b[1], 2, c.metalSh) + line(e[0], e[1], f[0], f[1], 2, c.metalSh);
    s += box(x - 9, y - 12, 18, 18, 3, 26, [accent || c.chairT, c.chairL, c.chairR]);
    s += box(x - 9, y - 9, 15, 18, 17, 4, [c.chairT, c.chairL, c.chairR]);
    return s;
  }

  function deskBack(c, x, y, w, dp) {
    return box(x + 1, y + 1, 0, 2, 2, 22, [c.metal, c.metalSh, c.metalSh])
      + box(x + w - 3, y + 1, 0, 2, 2, 22, [c.metal, c.metalSh, c.metalSh]);
  }
  function deskFront(c, x, y, w, dp) {
    return box(x + 1, y + dp - 3, 0, 2, 2, 22, [c.metal, c.metalSh, c.metalSh])
      + box(x + w - 3, y + dp - 3, 0, 2, 2, 22, [c.metal, c.metalSh, c.metalSh])
      + box(x, y, 22, w, dp, 3, [c.deskT, c.deskL, c.deskR], c.deskE);
  }

  function laptop(c, x, y, z, on) {
    var s = box(x, y, z, 18, 11, 1.4, [c.lapT, c.lapL, c.lapR]);
    s += box(x, y + 10, z + 1.4, 18, 1.2, 12.5, [c.lapT, c.lapL, c.lapR]);
    s += '<g transform="' + planeY(x, y + 11.2, z + 13.9) + '"><circle cx="9" cy="6.2" r="1.9" fill="' + (on ? c.glowHi : '#c7ced8') + '"' + (on ? ' class="' + c.p + 'logo"' : '') + '/></g>';
    return s;
  }
  function closedLaptop(c, x, y, z) {
    return box(x, y, z, 18, 11, 2.2, [c.lapT, c.lapL, c.lapR], '#eef1f5');
  }

  function mug(c, x, y, z, steam) {
    var p = P(x, y, z);
    var s = '<g transform="translate(' + p[0] + ' ' + p[1] + ')">'
      + '<path d="M -3 -6 L -3 0 Q 0 1.6 3 0 L 3 -6 Z" fill="' + c.white + '"/><path d="M 1 -6 L 3 -6 L 3 0 Q 2 .6 1 .9 Z" fill="#cfd5de"/>'
      + '<ellipse cx="0" cy="-6" rx="3" ry="1.4" fill="#5b3b2a"/><path d="M 3 -4.6 q 2.6 .3 2.4 2.2 q -.3 1.5 -2.4 1.2" stroke="#cfd5de" stroke-width="1.1" fill="none"/>';
    if (steam) s += '<path class="' + c.p + 'steam" d="M -1 -9 q -1.6 -2.4 0 -4.6 q 1.6 -2.2 0 -4.6" stroke="#ffffff" stroke-opacity=".5" stroke-width="1.1" fill="none" stroke-linecap="round"/>';
    return s + '</g>';
  }

  function plant(c, x, y, z) {
    var s = box(x - 3, y - 3, z, 6, 6, 6, ['#c97b5a', '#b0684a', '#91543b']);
    var p = P(x, y, z + 6);
    s += '<g transform="translate(' + p[0] + ' ' + p[1] + ')">'
      + '<path d="M 0 0 Q -9 -4 -8 -13 Q -2 -9 0 0 Z" fill="#3f8f5f"/>'
      + '<path d="M 0 0 Q 8 -5 9 -12 Q 2 -10 0 0 Z" fill="#2f7650"/>'
      + '<path d="M 0 0 Q -3 -10 1 -18 Q 4 -9 0 0 Z" fill="#56a872"/></g>';
    return s;
  }

  // ---------- holographic panels (flat art on a +y plane) ----------
  function panel(c, x, y, z, w, h, inner) {
    var top = P(x, y, z), bot = P(x + w / 2, y, 0);
    var s = '<path d="M ' + n(top[0] + w / 2 - 6) + ' ' + n(top[1] + w / 4 + h) + ' L ' + n(top[0] + w / 2 + 6) + ' ' + n(top[1] + w / 4 + h + 6) + ' L ' + n(bot[0] + 3) + ' ' + n(bot[1] - 28) + ' L ' + n(bot[0] - 3) + ' ' + n(bot[1] - 31) + ' Z" fill="url(#' + c.p + 'beam)" opacity=".0"/>';
    s += '<g transform="' + planeY(x, y, z) + '">'
      + '<g class="' + c.p + 'float">'
      + '<rect x="-3" y="-3" width="' + (w + 6) + '" height="' + (h + 6) + '" rx="6" fill="' + c.glow + '" opacity=".08"/>'
      + '<rect width="' + w + '" height="' + h + '" rx="3.5" fill="url(#' + c.p + 'gl)" stroke="' + c.glow + '" stroke-opacity=".85" stroke-width=".9"/>'
      + '<path d="M 3.5 .6 L ' + (w - 3.5) + ' .6" stroke="' + c.glowHi + '" stroke-opacity=".7" stroke-width=".8"/>'
      + '<circle cx="4.5" cy="4.3" r="1.1" fill="' + c.glowHi + '"/><circle cx="8.3" cy="4.3" r="1.1" fill="' + c.glow + '" opacity=".7"/><circle cx="12.1" cy="4.3" r="1.1" fill="' + c.glow + '" opacity=".45"/>'
      + inner + '</g></g>';
    return s;
  }
  function bar(c, x, y, w, col, cls, op) {
    return '<rect' + (cls ? ' class="' + cls + '"' : '') + ' x="' + x + '" y="' + y + '" width="' + w + '" height="2.2" rx="1.1" fill="' + col + '"' + (op ? ' opacity="' + op + '"' : '') + '/>';
  }

  // ---------- roles ----------
  function spriteBuilder(c) {
    var p = c.p, on = c.working;
    var b = shadow(c, -4, -2, 34, 0.9)
      + officeChair(c, -4, -19, c.dark)
      + at(-4, -18, 19, seated(c, { armClass: on ? p + 'type' : '' }))
      + deskBack(c, -34, -6, 46, 20) + deskFront(c, -34, -6, 46, 20)
      + laptop(c, -15, -3, 25, on)
      + mug(c, 4, 6, 25, on)
      + plant(c, -29, -1, 25);
    if (on) {
      var code = bar(c, 4, 9, 12, c.glowHi, p + 'l1') + bar(c, 18, 9, 9, c.accent2, p + 'l1')
        + bar(c, 8, 14, 16, c.glow, p + 'l2') + bar(c, 8, 19, 10, c.accent2, p + 'l3') + bar(c, 20, 19, 8, c.glowHi, p + 'l3')
        + bar(c, 4, 24, 14, c.glow, p + 'l4') + '<rect class="' + p + 'cur" x="20" y="23.4" width="2" height="3.4" rx=".6" fill="#fff"/>';
      b += panel(c, -58, -10, 80, 36, 30, code);
    }
    var css = '.' + p + 'type{animation:' + p + 'type .36s ease-in-out infinite}'
      + '@keyframes ' + p + 'type{50%{transform:translateY(1.2px)}}'
      + '.' + p + 'float{animation:' + p + 'float 3.2s ease-in-out infinite}'
      + '@keyframes ' + p + 'float{50%{transform:translateY(-2.5px)}}'
      + '.' + p + 'l1,.' + p + 'l2,.' + p + 'l3,.' + p + 'l4{transform-box:fill-box;transform-origin:0 50%;animation:' + p + 'code 4s ease-out infinite}'
      + '.' + p + 'l2{animation-delay:.5s}.' + p + 'l3{animation-delay:1s}.' + p + 'l4{animation-delay:1.5s}'
      + '@keyframes ' + p + 'code{0%{transform:scaleX(0);opacity:0}12%{transform:scaleX(1);opacity:1}85%{opacity:1}100%{opacity:0}}'
      + '.' + p + 'cur{animation:' + p + 'blink 1s steps(1) infinite}@keyframes ' + p + 'blink{50%{opacity:0}}'
      + '.' + p + 'logo{animation:' + p + 'pulse 2.4s ease-in-out infinite}@keyframes ' + p + 'pulse{50%{opacity:.45}}'
      + '.' + p + 'steam{animation:' + p + 'steam 2.6s ease-in-out infinite}@keyframes ' + p + 'steam{0%{opacity:0;transform:translateY(2px)}40%{opacity:1}100%{opacity:0;transform:translateY(-3px)}}';
    return wrap(c, css, b);
  }

  function spriteFixer(c) {
    var p = c.p, on = c.working;
    var b = shadow(c, -4, -2, 34, 0.9)
      + officeChair(c, -4, -19, c.dark)
      + at(-4, -18, 19, seated(c, { armClass: on ? p + 'type' : '' }))
      + deskBack(c, -34, -6, 46, 20) + deskFront(c, -34, -6, 46, 20)
      + laptop(c, -15, -3, 25, on)
      // toolbox on the desk
      + box(-31, 0, 25, 11, 7, 6, [c.top, c.topSh, hex(c.hue, 42, 32)])
      + box(-27.5, 2.6, 31, 4, 1.8, 1.6, [c.metal, c.metalSh, c.metalSh]);
    if (on) {
      var red = '#ff7b86', green = '#5fe0a0';
      var diff = '<rect x="3" y="9" width="30" height="4.4" rx="1.2" fill="' + red + '" opacity=".16"/>' + bar(c, 5, 10.1, 3, red) + bar(c, 10, 10.1, 16, red, '', '.9')
        + '<rect x="3" y="15" width="30" height="4.4" rx="1.2" fill="' + green + '" opacity=".16"/>' + bar(c, 5, 16.1, 3, green) + bar(c, 10, 16.1, 13, green, p + 'add')
        + bar(c, 10, 22.1, 18, c.glow, '', '.7');
      var gear = '<g transform="translate(32 4.3)"><g class="' + p + 'gear"><circle r="3.2" fill="none" stroke="' + c.glowHi + '" stroke-width="1.6" stroke-dasharray="1.6 1"/><circle r="1" fill="' + c.glowHi + '"/></g></g>';
      b += panel(c, -58, -10, 80, 38, 28, diff + gear);
    }
    var css = '.' + p + 'type{animation:' + p + 'type .5s ease-in-out infinite}@keyframes ' + p + 'type{50%{transform:translateY(1.2px)}}'
      + '.' + p + 'float{animation:' + p + 'float 3.4s ease-in-out infinite}@keyframes ' + p + 'float{50%{transform:translateY(-2.5px)}}'
      + '.' + p + 'gear{animation:' + p + 'spin 2.4s linear infinite}@keyframes ' + p + 'spin{to{transform:rotate(360deg)}}'
      + '.' + p + 'add{transform-box:fill-box;transform-origin:0 50%;animation:' + p + 'add 2.8s ease-out infinite}@keyframes ' + p + 'add{0%{transform:scaleX(0)}35%,100%{transform:scaleX(1)}}'
      + '.' + p + 'logo{animation:' + p + 'pulse 1.6s ease-in-out infinite}@keyframes ' + p + 'pulse{50%{opacity:.45}}';
    return wrap(c, css, b);
  }

  function spriteReviewer(c) {
    var p = c.p, on = c.working;
    var up = [hex(c.hue + 190, 18, 46), hex(c.hue + 190, 18, 37), hex(c.hue + 190, 18, 29)];
    var b = shadow(c, -2, -6, 32, 0.9)
      + box(16.5, -25.5, 0, 2, 2, 15, [c.metal, c.metalSh, c.metalSh])
      + box(12, -30, 0, 11, 11, 1, [c.metalSh, c.metalSh, c.metalSh])
      + box(11, -31, 15, 13, 13, 2.2, [c.deskT, c.deskL, c.deskR], c.deskE)
      + mug(c, 17.5, -24.5, 17.2, on)
      // armchair: back, seat, arms
      + box(-14, -20, 4, 26, 5, 34, up)
      + box(-14, -15, 4, 26, 20, 12, up)
      + box(-17, -20, 4, 4, 25, 20, up);
    // seated legs, then body
    var hip = P(-2, -10, 16);
    b += '<g transform="translate(' + hip[0] + ' ' + hip[1] + ')">'
      + path3([[-4, 0], [-15, 6], [-15, 24]], 7.2, c.pants) + path3([[5, 1], [-6, 9], [-7, 26]], 7.2, c.pantsSh)
      + '<path d="M -20 22.5 L -13 22.5 L -13 27.5 L -18 27.5 Q -21.5 27.5 -20 22.5 Z" fill="' + c.shoe + '"/>'
      + '<path d="M -12 24.5 L -4.5 24.5 L -4.5 29.5 L -10 29.5 Q -13.5 29.5 -12 24.5 Z" fill="' + c.shoe + '"/>'
      + torso(c, c.top, c.topSh) + '<path d="M -5.5 -31 L -1 -25 L 3.5 -31 Z" fill="' + c.topHi + '"/>'
      + head(c, { glasses: true })
      // tablet held in front, back facing the viewer
      + '<g transform="rotate(-24 -12 -12)"><rect x="-21" y="-19" width="18" height="13" rx="2" fill="#262a35"/><rect x="-21" y="-19" width="18" height="13" rx="2" fill="none" stroke="#4a5163" stroke-width=".8"/><circle cx="-12" cy="-12.5" r="1.4" fill="' + (on ? c.glow : '#4a5163') + '"/></g>'
      + path3([[-11, -27], [-15, -13], [-20, -11]], 6.2, c.top) + '<circle cx="-20" cy="-11" r="2.8" fill="' + c.skin + '"/>'
      + path3([[10, -27], [7, -12], [-4, -14]], 6.2, c.topSh) + '<circle cx="-4.5" cy="-14" r="2.8" fill="' + c.skinSh + '"/>'
      + '</g>';
    // near arm of the chair, side table with mug
    b += box(9, -20, 4, 4, 25, 20, up);
    if (on) {
      var rows = '';
      for (var i = 0; i < 4; i++) {
        var y = 9 + i * 5.2;
        rows += '<rect x="4" y="' + (y - 1.6) + '" width="4" height="4" rx="1" fill="none" stroke="' + c.glow + '" stroke-width=".8"/>'
          + '<path class="' + p + 'tk ' + p + 'tk' + i + '" d="M 4.8 ' + n(y + 0.4) + ' l 1.2 1.2 l 2.2 -2.6" stroke="' + c.glowHi + '" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="6"/>'
          + bar(c, 11, y - 0.7, [18, 14, 20, 11][i], c.glow, '', '.75');
      }
      var mag = '<g class="' + p + 'mag"><circle cx="27" cy="12" r="4" fill="' + c.glowHi + '" fill-opacity=".14" stroke="' + c.white + '" stroke-width="1.2"/>'
        + line(30, 15, 33.5, 18.5, 1.8, c.white) + '</g>';
      b += panel(c, -54, -14, 82, 36, 30, rows + mag);
    }
    var css = '.' + p + 'float{animation:' + p + 'float 3.6s ease-in-out infinite}@keyframes ' + p + 'float{50%{transform:translateY(-2.5px)}}'
      + '.' + p + 'tk{stroke-dashoffset:6;animation:' + p + 'tick 4.8s ease-out infinite}'
      + '.' + p + 'tk1{animation-delay:.8s}.' + p + 'tk2{animation-delay:1.6s}.' + p + 'tk3{animation-delay:2.4s}'
      + '@keyframes ' + p + 'tick{0%{stroke-dashoffset:6}12%,88%{stroke-dashoffset:0;opacity:1}100%{stroke-dashoffset:0;opacity:0}}'
      + '.' + p + 'mag{animation:' + p + 'mag 4.8s ease-in-out infinite}'
      + '@keyframes ' + p + 'mag{0%,100%{transform:translate(0,0)}25%{transform:translate(-4px,5.2px)}50%{transform:translate(-1px,10.4px)}75%{transform:translate(-5px,15.6px)}}'
      + '.' + p + 'steam{animation:' + p + 'steam 2.6s ease-in-out infinite}@keyframes ' + p + 'steam{0%{opacity:0;transform:translateY(2px)}40%{opacity:1}100%{opacity:0;transform:translateY(-3px)}}';
    return wrap(c, css, b);
  }

  function spriteLead(c) {
    var p = c.p, on = c.working;
    var b = shadow(c, -8, -2, 34, 0.9);
    // easel legs behind the board
    var l1 = P(-36, 1, 0), l2 = P(-10, 1, 0), l3 = P(-23, -8, 0), top = P(-23, 1, 70);
    b += line(top[0], top[1], l3[0], l3[1], 2, c.metalSh)
      + line(P(-34, 2, 30)[0], P(-34, 2, 30)[1], l1[0], l1[1], 2.2, c.metal)
      + line(P(-12, 2, 30)[0], P(-12, 2, 30)[1], l2[0], l2[1], 2.2, c.metal);
    // board (a thin box) with a plan drawn on its face
    b += box(-40, 0, 30, 34, 2, 38, ['#d7dce5', '#f2f4f8', '#b9c0cc']);
    var nodeA = '<rect class="' + p + 'n1" x="4" y="7" width="10" height="7" rx="1.6" fill="' + c.top + '"/>';
    var nodeB = '<rect class="' + p + 'n2" x="20" y="7" width="10" height="7" rx="1.6" fill="' + c.topHi + '"/>';
    var nodeC = '<rect class="' + p + 'n3" x="12" y="24" width="10" height="7" rx="1.6" fill="' + c.glowLo + '"/>';
    var links = '<path class="' + p + 'flow" d="M 14 10.5 L 20 10.5 M 9 14 L 15 24 M 25 14 L 19 24" stroke="#8a93a5" stroke-width="1" fill="none" stroke-dasharray="2 1.6"/>';
    b += '<g transform="' + planeY(-40, 2, 68) + '">'
      + '<rect x="1.5" y="1.5" width="31" height="35" rx="1.5" fill="none" stroke="#c3c9d4" stroke-width=".8"/>'
      + bar(c, 4, 3.4, 12, '#9aa3b4') + links + nodeA + nodeB + nodeC
      + '<path d="M 6 34 L 28 34" stroke="#c3c9d4" stroke-width="1"/></g>';
    b += box(-40, 2, 29, 34, 4, 1.4, [c.metal, c.metalSh, c.metalSh]);
    // the lead, standing to the right of the board
    b += at(6, -4, 34, standing(c, { pointClass: on ? p + 'point' : '' }));
    var css = '.' + p + 'point{transform-box:view-box;transform-origin:0 0;animation:' + p + 'point 2.4s ease-in-out infinite}'
      + '@keyframes ' + p + 'point{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-8deg)}}'
      + '.' + p + 'n1,.' + p + 'n2,.' + p + 'n3{animation:' + p + 'node 3.6s ease-in-out infinite}'
      + '.' + p + 'n2{animation-delay:1.2s}.' + p + 'n3{animation-delay:2.4s}'
      + '@keyframes ' + p + 'node{0%,30%,100%{opacity:1}15%{opacity:.35}}'
      + '.' + p + 'flow{animation:' + p + 'flow 1.2s linear infinite}@keyframes ' + p + 'flow{to{stroke-dashoffset:-7.2}}';
    return wrap(c, css, b);
  }

  // Planned seat: an empty desk, tucked chair, closed laptop and a plant. Never animates.
  function spriteIdle(c) {
    var b = shadow(c, -4, -2, 34, 0.8)
      + officeChair(c, -4, -15, c.chairT)
      + deskBack(c, -34, -6, 46, 20) + deskFront(c, -34, -6, 46, 20)
      + closedLaptop(c, -15, 0, 25)
      + poly([P(-10, 3, 27.3), P(-4, 3, 27.3), P(-4, 8, 27.3), P(-10, 8, 27.3)], c.topHi)
      + plant(c, -29, -1, 25)
      + mug(c, 4, 6, 25, false);
    return wrap(c, '', b);
  }

  // Finished lane: the worker leans back, hands behind the head, laptop shut, a check badge over the desk. Static.
  function spriteDone(c) {
    var lean = '<g transform="rotate(7 0 0)">'
      + path3([[-11, -27], [-18, -44], [-7, -51]], 6.2, c.top) + path3([[10, -27], [16, -45], [5, -52]], 6.2, c.topSh)
      + torso(c, c.top, c.topSh) + '<path d="M -5.5 -31 L -1 -25 L 3.5 -31 Z" fill="' + c.topHi + '"/>'
      + head(c, { happy: true }) + '</g>';
    var badge = '<g transform="' + planeY(-50, -12, 74) + '">'
      + '<circle cx="11" cy="11" r="13" fill="' + c.glow + '" opacity=".1"/>'
      + '<circle cx="11" cy="11" r="9.5" fill="url(#' + c.p + 'gl)" stroke="' + c.glow + '" stroke-width="1"/>'
      + '<path d="M 6.6 11.2 L 9.8 14.4 L 15.6 7.6" stroke="' + c.glowHi + '" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>';
    var b = shadow(c, -4, -2, 34, 0.9)
      + officeChair(c, -4, -21, c.dark)
      + at(-4, -19, 19, lean)
      + deskBack(c, -34, -6, 46, 20) + deskFront(c, -34, -6, 46, 20)
      + closedLaptop(c, -15, -1, 25)
      + mug(c, 4, 6, 25, false)
      + plant(c, -29, -1, 25)
      + badge;
    return wrap(c, '', b);
  }

  // Portrait crops (viewBox x, y, size) around each character's head and shoulders, for small avatars.
  var PORTRAIT = { lead: [70, 66, 50], builder: [74, 72, 50], fixer: [74, 72, 50], reviewer: [68, 84, 50], done: [76, 62, 52], idle: [22, 92, 90] };

  function draw(role, opts) {
    var r = ROLES.indexOf(role) < 0 ? 'idle' : role;
    var c = ctx(r, opts);
    var svg = r === 'lead' ? spriteLead(c) : r === 'builder' ? spriteBuilder(c) : r === 'fixer' ? spriteFixer(c)
      : r === 'reviewer' ? spriteReviewer(c) : r === 'done' ? spriteDone(c) : spriteIdle(c);
    if (opts && opts.portrait) {
      var v = PORTRAIT[r];
      svg = svg.replace('viewBox="0 0 160 200" width="160" height="200"', 'viewBox="' + v[0] + ' ' + v[1] + ' ' + v[2] + ' ' + v[2] + '" width="' + v[2] + '" height="' + v[2] + '"');
    }
    return svg;
  }

  window.OfficeSprites = { roles: ROLES.slice(), draw: draw };
})();
