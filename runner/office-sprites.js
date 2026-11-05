(function () {
  'use strict';

  var ROLES = ['lead', 'builder', 'reviewer', 'fixer', 'idle'];

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function n(v) {
    return Math.round(v * 100) / 100;
  }

  function hueNorm(h) {
    if (typeof h !== 'number' || !isFinite(h)) return 210;
    var x = Math.round(h) % 360;
    return x < 0 ? x + 360 : x;
  }

  function hex(h, s, l) {
    h = hueNorm(h);
    s = clamp(s, 0, 100) / 100;
    l = clamp(l, 0, 100) / 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r = 0;
    var g = 0;
    var b = 0;
    if (h < 60) {
      r = c; g = x;
    } else if (h < 120) {
      r = x; g = c;
    } else if (h < 180) {
      g = c; b = x;
    } else if (h < 240) {
      g = x; b = c;
    } else if (h < 300) {
      r = x; b = c;
    } else {
      r = c; b = x;
    }
    function two(v) {
      var t = Math.round((v + m) * 255).toString(16);
      return t.length < 2 ? '0' + t : t;
    }
    return '#' + two(r) + two(g) + two(b);
  }

  function ctx(role, opts) {
    opts = opts || {};
    var state = opts.state === 'working' ? 'working' : 'idle';
    var hue = hueNorm(opts.hue);
    return {
      role: role,
      state: state,
      working: state === 'working',
      hue: hue,
      p: 'os-' + role + '-' + hue + '-' + state + '-',
      shirt: hex(hue, 58, 50),
      shirtHi: hex(hue, 62, 62),
      shirtLo: hex(hue, 55, 34),
      hair: hex(hue + 45, 34, 27),
      hairHi: hex(hue + 45, 40, 40),
      pants: hex(hue, 14, 30),
      pantsLo: hex(hue, 14, 20),
      suit: hex(hue, 26, 19),
      suitHi: hex(hue, 28, 30),
      suitLo: hex(hue, 24, 11),
      tie: hex(hue, 52, 44),
      tieHi: hex(hue, 55, 58),
      boxFill: hex(hue, 50, 76),
      boxLine: hex(hue, 45, 42),
      chair: hex(hue, 12, 27),
      chairHi: hex(hue, 14, 37),
      chairLo: hex(hue, 11, 17),
      scr: hex(hue, 62, 46),
      scrHi: hex(hue, 72, 66),
      glow: hex(hue, 80, 60),
      screenHi: hex(hue, 50, 16),
      screenLo: hex(hue, 55, 8),
      steel: '#a9bacf',
      steelLo: '#8fa2ba',
      deskHi: '#8a7052',
      deskLo: '#54432f',
      lapHi: '#454d5c',
      lapLo: '#2c323d',
      skin: '#f3c39a',
      skinHi: '#ffdcb0',
      skinLo: '#dfa677',
      ink: '#20242c',
      shoe: '#242833',
      shoeHi: '#3a4150'
    };
  }

  function stops(list) {
    var s = '';
    for (var i = 0; i < list.length; i++) {
      s += '<stop offset="' + list[i][0] + '" stop-color="' + list[i][1] + '"';
      if (list[i][2] !== undefined) s += ' stop-opacity="' + list[i][2] + '"';
      s += '/>';
    }
    return s;
  }

  function lin(id, x1, y1, x2, y2, st) {
    return '<linearGradient id="' + id + '" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '">' + st + '</linearGradient>';
  }

  function rad(id, cx, cy, r, st) {
    return '<radialGradient id="' + id + '" cx="' + cx + '" cy="' + cy + '" r="' + r + '">' + st + '</radialGradient>';
  }

  function defsCommon(c) {
    var p = c.p;
    return rad(p + 'skin', 0.35, 0.3, 0.95, stops([[0, c.skinHi], [0.55, c.skin], [1, c.skinLo]]))
      + lin(p + 'hair', 0, 0, 0, 1, stops([[0, c.hairHi], [1, c.hair]]))
      + lin(p + 'shirt', 0, 0, 0, 1, stops([[0, c.shirtHi], [0.5, c.shirt], [1, c.shirtLo]]))
      + lin(p + 'pants', 0, 0, 0, 1, stops([[0, c.pants], [1, c.pantsLo]]))
      + lin(p + 'shoe', 0, 0, 0, 1, stops([[0, c.shoeHi], [1, c.shoe]]))
      + rad(p + 'shadow', 0.5, 0.5, 0.5, stops([[0, '#000000', 0.35], [0.65, '#000000', 0.16], [1, '#000000', 0]]));
  }

  function defsDesk(c) {
    var p = c.p;
    return defsCommon(c)
      + lin(p + 'chair', 0, 0, 0, 1, stops([[0, c.chairHi], [0.6, c.chair], [1, c.chairLo]]))
      + lin(p + 'desk', 0, 0, 0, 1, stops([[0, c.deskHi], [1, c.deskLo]]))
      + lin(p + 'screen', 0, 0, 0, 1, stops([[0, c.screenHi], [1, c.screenLo]]))
      + lin(p + 'lap', 0, 0, 0, 1, stops([[0, c.lapHi], [1, c.lapLo]]))
      + rad(p + 'glow', 0.5, 0.5, 0.5, stops([[0, c.glow, 0.4], [0.5, c.glow, 0.15], [1, c.glow, 0]]))
      + rad(p + 'halo', 0.5, 0.5, 0.5, stops([[0, c.glow, 0.45], [0.55, c.glow, 0.15], [1, c.glow, 0]]));
  }

  function wrap(c, css, defs, body) {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 200" width="160" height="200" role="img">';
    if (c.working && css) s += '<style>' + css + '</style>';
    return s + '<defs>' + defs + '</defs>' + body + '</svg>';
  }

  function shadow(c, cx, cy, rx, ry) {
    return '<ellipse cx="' + n(cx) + '" cy="' + n(cy) + '" rx="' + n(rx) + '" ry="' + n(ry) + '" fill="url(#' + c.p + 'shadow)"/>';
  }

  function neck(c, cx, y, w, h) {
    return '<rect x="' + n(cx - w / 2) + '" y="' + n(y) + '" width="' + n(w) + '" height="' + n(h) + '" rx="' + n(w / 4) + '" fill="' + c.skinLo + '"/>';
  }

  function torso(c, cx, top, bot, hw, fill) {
    var sh = hw * 0.42;
    return '<path d="M ' + n(cx - hw) + ' ' + n(bot - 2)
      + ' Q ' + n(cx - hw) + ' ' + n(bot + 3) + ' ' + n(cx - hw + 5) + ' ' + n(bot + 3)
      + ' L ' + n(cx + hw - 5) + ' ' + n(bot + 3)
      + ' Q ' + n(cx + hw) + ' ' + n(bot + 3) + ' ' + n(cx + hw) + ' ' + n(bot - 2)
      + ' L ' + n(cx + hw) + ' ' + n(top + sh)
      + ' Q ' + n(cx + hw) + ' ' + n(top) + ' ' + n(cx + hw - sh) + ' ' + n(top)
      + ' L ' + n(cx - hw + sh) + ' ' + n(top)
      + ' Q ' + n(cx - hw) + ' ' + n(top) + ' ' + n(cx - hw) + ' ' + n(top + sh)
      + ' Z" fill="' + fill + '"/>';
  }

  function limb(x1, y1, x2, y2, w, color) {
    return '<path d="M ' + n(x1) + ' ' + n(y1) + ' L ' + n(x2) + ' ' + n(y2) + '" fill="none" stroke="' + color + '" stroke-width="' + n(w) + '" stroke-linecap="round"/>';
  }

  function limb3(x1, y1, x2, y2, x3, y3, w, color) {
    return '<path d="M ' + n(x1) + ' ' + n(y1) + ' L ' + n(x2) + ' ' + n(y2) + ' L ' + n(x3) + ' ' + n(y3) + '" fill="none" stroke="' + color + '" stroke-width="' + n(w) + '" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  function hand(c, x, y, r) {
    return '<circle cx="' + n(x) + '" cy="' + n(y) + '" r="' + n(r || 4.4) + '" fill="' + c.skin + '"/>';
  }

  function shoe(c, cx, y) {
    return '<rect x="' + n(cx - 10.5) + '" y="' + n(y) + '" width="21" height="11" rx="5.5" fill="url(#' + c.p + 'shoe)"/>';
  }

  function head(c, cx, cy, r, o) {
    o = o || {};
    var p = c.p;
    var ex = r * 0.4;
    var ey = cy + r * 0.12;
    var s = '<circle cx="' + n(cx - r * 0.99) + '" cy="' + n(cy + r * 0.08) + '" r="' + n(r * 0.2) + '" fill="' + c.skinLo + '"/>'
      + '<circle cx="' + n(cx + r * 0.99) + '" cy="' + n(cy + r * 0.08) + '" r="' + n(r * 0.2) + '" fill="' + c.skinLo + '"/>'
      + '<circle cx="' + n(cx) + '" cy="' + n(cy) + '" r="' + n(r) + '" fill="url(#' + p + 'skin)"/>'
      + '<path d="M ' + n(cx - r) + ' ' + n(cy)
      + ' A ' + n(r) + ' ' + n(r) + ' 0 0 1 ' + n(cx + r) + ' ' + n(cy)
      + ' Q ' + n(cx + r * 0.7) + ' ' + n(cy - r * 0.12) + ' ' + n(cx + r * 0.4) + ' ' + n(cy - r * 0.27)
      + ' Q ' + n(cx + r * 0.12) + ' ' + n(cy - r * 0.35) + ' ' + n(cx) + ' ' + n(cy - r * 0.15)
      + ' Q ' + n(cx - r * 0.12) + ' ' + n(cy - r * 0.35) + ' ' + n(cx - r * 0.4) + ' ' + n(cy - r * 0.27)
      + ' Q ' + n(cx - r * 0.7) + ' ' + n(cy - r * 0.12) + ' ' + n(cx - r) + ' ' + n(cy)
      + ' Z" fill="url(#' + p + 'hair)"/>'
      + '<ellipse cx="' + n(cx - ex) + '" cy="' + n(ey) + '" rx="' + n(r * 0.1) + '" ry="' + n(r * 0.14) + '" fill="' + c.ink + '"/>'
      + '<ellipse cx="' + n(cx + ex) + '" cy="' + n(ey) + '" rx="' + n(r * 0.1) + '" ry="' + n(r * 0.14) + '" fill="' + c.ink + '"/>'
      + '<circle cx="' + n(cx - ex + r * 0.04) + '" cy="' + n(ey - r * 0.05) + '" r="' + n(r * 0.04) + '" fill="#ffffff" opacity="0.9"/>'
      + '<circle cx="' + n(cx + ex + r * 0.04) + '" cy="' + n(ey - r * 0.05) + '" r="' + n(r * 0.04) + '" fill="#ffffff" opacity="0.9"/>'
      + '<path d="M ' + n(cx - r * 0.28) + ' ' + n(cy + r * 0.42) + ' Q ' + n(cx) + ' ' + n(cy + r * 0.68) + ' ' + n(cx + r * 0.28) + ' ' + n(cy + r * 0.42) + '" fill="none" stroke="#a35d43" stroke-width="' + n(r * 0.09) + '" stroke-linecap="round"/>';
    if (o.glasses) {
      var gr = r * 0.3;
      var gy = ey + r * 0.02;
      var gw = r * 0.075;
      s += '<circle cx="' + n(cx - ex) + '" cy="' + n(gy) + '" r="' + n(gr) + '" fill="#cfe8ff" fill-opacity="0.25" stroke="' + c.ink + '" stroke-width="' + n(gw) + '"/>'
        + '<circle cx="' + n(cx + ex) + '" cy="' + n(gy) + '" r="' + n(gr) + '" fill="#cfe8ff" fill-opacity="0.25" stroke="' + c.ink + '" stroke-width="' + n(gw) + '"/>'
        + '<path d="M ' + n(cx - ex + gr) + ' ' + n(gy) + ' L ' + n(cx + ex - gr) + ' ' + n(gy) + '" fill="none" stroke="' + c.ink + '" stroke-width="' + n(gw) + '"/>'
        + '<path d="M ' + n(cx - ex - gr) + ' ' + n(gy) + ' L ' + n(cx - r * 0.95) + ' ' + n(gy - r * 0.03) + '" fill="none" stroke="' + c.ink + '" stroke-width="' + n(gw) + '"/>'
        + '<path d="M ' + n(cx + ex + gr) + ' ' + n(gy) + ' L ' + n(cx + r * 0.95) + ' ' + n(gy - r * 0.03) + '" fill="none" stroke="' + c.ink + '" stroke-width="' + n(gw) + '"/>';
    }
    if (o.phones) {
      s += '<path d="M ' + n(cx - r * 0.98) + ' ' + n(cy - r * 0.1) + ' A ' + n(r * 0.99) + ' ' + n(r * 0.99) + ' 0 0 1 ' + n(cx + r * 0.98) + ' ' + n(cy - r * 0.1) + '" fill="none" stroke="' + c.ink + '" stroke-width="' + n(r * 0.16) + '"/>'
        + '<circle cx="' + n(cx - r * 0.99) + '" cy="' + n(cy + r * 0.08) + '" r="' + n(r * 0.27) + '" fill="' + c.ink + '"/>'
        + '<circle cx="' + n(cx + r * 0.99) + '" cy="' + n(cy + r * 0.08) + '" r="' + n(r * 0.27) + '" fill="' + c.ink + '"/>'
        + '<circle cx="' + n(cx - r * 0.99) + '" cy="' + n(cy + r * 0.08) + '" r="' + n(r * 0.1) + '" fill="' + c.scrHi + '"/>'
        + '<circle cx="' + n(cx + r * 0.99) + '" cy="' + n(cy + r * 0.08) + '" r="' + n(r * 0.1) + '" fill="' + c.scrHi + '"/>';
    }
    return s;
  }

  function spriteIdle(c) {
    var p = c.p;
    var b = shadow(c, 80, 187, 34, 8.5)
      + limb(73, 130, 68, 177, 11, c.pants)
      + limb(87, 130, 92, 177, 11, c.pantsLo)
      + shoe(c, 68, 174.5)
      + shoe(c, 92, 174.5)
      + neck(c, 80, 68, 12, 18)
      + torso(c, 80, 84, 138, 21, 'url(#' + p + 'shirt)')
      + limb(62, 94, 56, 122, 9, c.shirt)
      + hand(c, 56, 124);
    if (c.working) {
      b += '<g class="' + p + 'wave">' + limb3(98, 94, 108, 104, 112, 86, 9, c.shirtLo) + hand(c, 113, 84) + '</g>';
    } else {
      b += limb(98, 94, 104, 122, 9, c.shirtLo) + hand(c, 104, 124);
    }
    b += head(c, 80, 57, 21);
    var css = '';
    if (c.working) {
      css = '.' + p + 'wave{transform-box:fill-box;transform-origin:0% 59%;animation:' + p + 'wave 1.5s ease-in-out infinite}'
        + '@keyframes ' + p + 'wave{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(-20deg)}}';
    }
    return wrap(c, css, defsCommon(c), b);
  }

  function flowBox(c, x, y) {
    return '<rect x="' + n(x) + '" y="' + n(y) + '" width="17" height="11" rx="2.5" fill="' + c.boxFill + '" stroke="' + c.boxLine + '" stroke-width="1.4"/>';
  }

  function spriteLead(c) {
    var p = c.p;
    var b = shadow(c, 74, 188, 54, 9)
      + limb(46, 183, 46, 102, 4, c.ink)
      + limb(26, 183, 35, 103, 4.5, '#2b303a')
      + limb(66, 183, 57, 103, 4.5, '#2b303a')
      + '<rect x="24" y="99" width="42" height="5" rx="2.5" fill="#2b303a"/>'
      + '<rect x="17" y="36" width="58" height="64" rx="5" fill="url(#' + p + 'board)" stroke="#262b34" stroke-width="3"/>'
      + limb(24, 41, 46, 41, 1.6, '#5a6472')
      + flowBox(c, 24, 46)
      + flowBox(c, 51, 46)
      + flowBox(c, 37.5, 74)
      + limb(41, 51.5, 51, 51.5, 1.6, '#5a6472')
      + limb(33, 57.5, 44, 74, 1.6, '#5a6472')
      + limb(59, 57.5, 48, 74, 1.6, '#5a6472')
      + limb(93, 132, 88, 177, 11, c.suit)
      + limb(107, 132, 112, 177, 11, c.suitLo)
      + shoe(c, 88, 174.5)
      + shoe(c, 112, 174.5)
      + neck(c, 100, 68, 12, 18)
      + torso(c, 100, 84, 138, 21, 'url(#' + p + 'suit)')
      + '<path d="M 91 86 L 100 104 L 109 86 Q 100 83 91 86 Z" fill="#f4f6f9"/>'
      + '<rect x="96.6" y="85" width="6.8" height="4.6" rx="1.6" fill="' + c.tieHi + '"/>'
      + '<path d="M 96.9 90 L 103.1 90 L 104.4 103 L 100 109 L 95.6 103 Z" fill="' + c.tie + '"/>'
      + limb(116, 94, 120, 122, 9, c.suitLo)
      + hand(c, 120, 124);
    var point = limb3(84, 94, 78, 112, 72, 96, 9, c.suitHi) + limb(72, 96, 66, 91, 3.4, c.skin) + hand(c, 72, 96);
    b += c.working ? '<g class="' + p + 'point">' + point + '</g>' : point;
    b += head(c, 100, 57, 21);
    var css = '';
    if (c.working) {
      css = '.' + p + 'point{transform-box:fill-box;transform-origin:100% 14%;animation:' + p + 'point 2s ease-in-out infinite}'
        + '@keyframes ' + p + 'point{0%,100%{transform:rotate(0deg)}50%{transform:rotate(7deg)}}';
    }
    var defs = defsCommon(c)
      + lin(p + 'suit', 0, 0, 0, 1, stops([[0, c.suitHi], [0.45, c.suit], [1, c.suitLo]]))
      + lin(p + 'board', 0, 0, 0, 1, stops([[0, '#f8fafc'], [1, '#d9e1ea']]));
    return wrap(c, css, defs, b);
  }

  function chair(c) {
    var p = c.p;
    return '<rect x="77" y="136" width="6" height="42" rx="3" fill="' + c.chairLo + '"/>'
      + '<path d="M 56 180 Q 80 171 104 180" fill="none" stroke="' + c.chairLo + '" stroke-width="5" stroke-linecap="round"/>'
      + '<circle cx="54" cy="181" r="3.4" fill="' + c.ink + '"/>'
      + '<circle cx="106" cy="181" r="3.4" fill="' + c.ink + '"/>'
      + '<rect x="52" y="74" width="56" height="52" rx="16" fill="url(#' + p + 'chair)"/>'
      + '<rect x="46" y="112" width="11" height="30" rx="5.5" fill="' + c.chairLo + '"/>'
      + '<rect x="103" y="112" width="11" height="30" rx="5.5" fill="' + c.chairLo + '"/>';
  }

  function desk(c) {
    var p = c.p;
    return '<path d="M 34 150 L 126 150 L 118 140 L 42 140 Z" fill="url(#' + p + 'desk)"/>'
      + '<rect x="34" y="149" width="92" height="5" rx="2" fill="' + c.deskLo + '"/>'
      + '<rect x="38" y="152" width="8" height="30" rx="3" fill="' + c.deskLo + '"/>'
      + '<rect x="114" y="152" width="8" height="30" rx="3" fill="' + c.deskLo + '"/>'
      + '<rect x="35" y="179" width="14" height="6" rx="3" fill="' + c.deskLo + '"/>'
      + '<rect x="111" y="179" width="14" height="6" rx="3" fill="' + c.deskLo + '"/>';
  }

  function monitor(c, mode) {
    var p = c.p;
    var s = '';
    if (mode === 'code') s += '<circle cx="80" cy="114" r="30" fill="url(#' + p + 'glow)"/>';
    s += '<rect x="64" y="100" width="32" height="32" rx="4.5" fill="#2b303c"/>'
      + '<rect x="67" y="103" width="26" height="24" rx="2.5" fill="url(#' + p + 'screen)"/>';
    if (mode === 'code') {
      s += '<rect class="' + p + 'cl1" x="70" y="107" width="14" height="2.6" rx="1.3" fill="' + c.scrHi + '"/>'
        + '<rect class="' + p + 'cl2" x="70" y="112.5" width="20" height="2.6" rx="1.3" fill="' + c.scr + '"/>'
        + '<rect class="' + p + 'cl3" x="70" y="118" width="11" height="2.6" rx="1.3" fill="' + c.scrHi + '"/>'
        + '<rect class="' + p + 'cl4" x="70" y="123.5" width="17" height="2.6" rx="1.3" fill="' + c.scr + '"/>'
        + '<rect class="' + p + 'cur" x="82.5" y="118" width="3" height="6.5" rx="1" fill="#ffffff"/>';
    }
    s += '<rect x="77" y="132" width="6" height="5" fill="#2b303c"/>'
      + '<ellipse cx="80" cy="138.5" rx="10" ry="2.6" fill="#2b303c"/>';
    return s;
  }

  function keyboard(c) {
    return '<rect x="60" y="143" width="40" height="7" rx="2.5" fill="#333a47"/>'
      + '<rect x="63" y="145" width="34" height="1.4" rx="0.7" fill="#4b5464"/>'
      + '<rect x="72" y="147.4" width="16" height="1.4" rx="0.7" fill="#4b5464"/>';
  }

  function seatedBase(c) {
    return limb(72, 148, 69, 176, 10, c.pants)
      + limb(88, 148, 91, 176, 10, c.pantsLo)
      + shoe(c, 68, 174.5)
      + shoe(c, 92, 174.5)
      + neck(c, 80, 70, 11, 18)
      + torso(c, 80, 86, 142, 20, 'url(#' + c.p + 'shirt)');
  }

  function spriteBuilder(c) {
    var p = c.p;
    var b = shadow(c, 80, 188, 52, 9)
      + chair(c)
      + seatedBase(c)
      + desk(c)
      + monitor(c, 'code')
      + keyboard(c)
      + limb(61, 96, 58, 118, 8.5, c.shirt)
      + limb(99, 96, 102, 118, 8.5, c.shirtLo);
    var tapL = limb(58, 118, 66, 145, 8.5, c.shirt) + hand(c, 66, 146, 4.3);
    var tapR = limb(102, 118, 94, 145, 8.5, c.shirtLo) + hand(c, 94, 146, 4.3);
    if (c.working) {
      b += '<g class="' + p + 'tapL">' + tapL + '</g><g class="' + p + 'tapR">' + tapR + '</g>';
    } else {
      b += tapL + tapR;
    }
    b += head(c, 80, 62, 20, { phones: true });
    var css = '';
    if (c.working) {
      css = '.' + p + 'tapL{animation:' + p + 'tap .34s ease-in-out infinite}'
        + '.' + p + 'tapR{animation:' + p + 'tap .34s ease-in-out .17s infinite}'
        + '@keyframes ' + p + 'tap{0%,100%{transform:translateY(0)}50%{transform:translateY(2.2px)}}'
        + '.' + p + 'cl1{animation:' + p + 'flk .8s ease-in-out infinite}'
        + '.' + p + 'cl2{animation:' + p + 'flk 1.15s ease-in-out .3s infinite}'
        + '.' + p + 'cl3{animation:' + p + 'flk .95s ease-in-out .15s infinite}'
        + '.' + p + 'cl4{animation:' + p + 'flk 1.3s ease-in-out .5s infinite}'
        + '@keyframes ' + p + 'flk{0%,100%{opacity:1}50%{opacity:.35}}'
        + '.' + p + 'cur{animation:' + p + 'cur 1.1s linear infinite}'
        + '@keyframes ' + p + 'cur{0%,49%{opacity:1}50%,100%{opacity:0}}';
    }
    return wrap(c, css, defsDesk(c), b);
  }

  function spriteFixer(c) {
    var p = c.p;
    var b = shadow(c, 80, 188, 52, 9)
      + chair(c)
      + seatedBase(c)
      + desk(c)
      + monitor(c, 'dark')
      + '<g transform="rotate(-5 80 107)">'
      + '<rect x="66" y="96" width="28" height="22" rx="3" fill="url(#' + p + 'lap)"/>'
      + '<circle cx="80" cy="107" r="3.4" fill="' + c.scr + '"/>'
      + '</g>'
      + '<path d="M 65 118 L 95 118 L 99 126 L 61 126 Z" fill="' + c.lapLo + '"/>'
      + limb3(61, 96, 56, 108, 63, 119, 8.5, c.shirt)
      + hand(c, 63, 120, 4.3)
      + limb3(99, 96, 104, 108, 97, 119, 8.5, c.shirtLo)
      + hand(c, 97, 120, 4.3)
      + head(c, 80, 62, 20)
      + '<circle cx="80" cy="24" r="14" fill="url(#' + p + 'halo)"/>';
    var wrench = '<g transform="rotate(-14 80 24)">'
      + '<path d="M 72 9 Q 72 23 80 23 Q 88 23 88 9 L 83.4 9 Q 83.4 17.5 80 17.5 Q 76.6 17.5 76.6 9 Z" fill="' + c.steel + '"/>'
      + '<rect x="77" y="21.5" width="6" height="17" rx="3" fill="' + c.steelLo + '"/>'
      + '</g>';
    b += c.working ? '<g class="' + p + 'wrench">' + wrench + '</g>' : wrench;
    var css = '';
    if (c.working) {
      css = '.' + p + 'wrench{transform-box:fill-box;transform-origin:50% 50%;animation:' + p + 'wrench 1.8s ease-in-out infinite}'
        + '@keyframes ' + p + 'wrench{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(9deg)}}';
    }
    return wrap(c, css, defsDesk(c), b);
  }

  function spriteReviewer(c) {
    var p = c.p;
    if (!c.working) {
      var empty = shadow(c, 80, 188, 52, 9)
        + chair(c)
        + desk(c)
        + monitor(c, 'dark')
        + keyboard(c);
      return wrap(c, '', defsDesk(c), empty);
    }
    var b = shadow(c, 80, 188, 50, 9)
      + '<rect x="46" y="64" width="68" height="70" rx="22" fill="url(#' + p + 'chair)"/>'
      + '<rect x="52" y="146" width="56" height="32" rx="9" fill="' + c.chairLo + '"/>'
      + '<rect x="54" y="176" width="9" height="8" rx="2.5" fill="#3d342c"/>'
      + '<rect x="97" y="176" width="9" height="8" rx="2.5" fill="#3d342c"/>'
      + neck(c, 80, 70, 11, 18)
      + torso(c, 80, 86, 140, 20, 'url(#' + p + 'shirt)')
      + '<rect x="50" y="128" width="60" height="20" rx="10" fill="' + c.chairHi + '"/>'
      + limb(66, 148, 64, 176, 10, c.pants)
      + limb(94, 148, 96, 176, 10, c.pantsLo)
      + shoe(c, 64, 174.5)
      + shoe(c, 96, 174.5)
      + '<path d="M 60 133 L 100 133 L 96 127 L 64 127 Z" fill="' + c.lapLo + '"/>'
      + '<rect x="64" y="103" width="32" height="25" rx="3" fill="url(#' + p + 'lap)"/>'
      + '<circle cx="80" cy="115" r="3.4" fill="' + c.scr + '"/>'
      + limb3(61, 96, 56, 110, 63, 129, 8.5, c.shirt)
      + hand(c, 63, 130, 4.3)
      + limb3(99, 96, 104, 110, 97, 129, 8.5, c.shirtLo)
      + hand(c, 97, 130, 4.3)
      + '<rect x="40" y="108" width="13" height="36" rx="6.5" fill="' + c.chairLo + '"/>'
      + '<rect x="107" y="108" width="13" height="36" rx="6.5" fill="' + c.chairLo + '"/>'
      + '<rect x="40" y="106" width="13" height="9" rx="4.5" fill="' + c.chairHi + '"/>'
      + '<rect x="107" y="106" width="13" height="9" rx="4.5" fill="' + c.chairHi + '"/>'
      + head(c, 80, 62, 20, { glasses: true })
      + '<circle cx="106" cy="88" r="13" fill="url(#' + p + 'halo)"/>';
    var mag = '<circle cx="106" cy="88" r="7" fill="#cfe8ff" fill-opacity="0.35" stroke="#eaf3ff" stroke-width="2.4"/>'
      + '<path d="M 111 93 L 118 102" stroke="#eaf3ff" stroke-width="3.4" stroke-linecap="round" fill="none"/>'
      + '<path d="M 101 85.5 Q 103 82.8 105.8 82.2" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" fill="none" opacity="0.8"/>';
    b += '<g class="' + p + 'mag">' + mag + '</g>';
    var css = '.' + p + 'mag{transform-box:fill-box;transform-origin:50% 50%;animation:' + p + 'mag 1.4s ease-in-out infinite}'
      + '@keyframes ' + p + 'mag{0%,100%{transform:scale(1);opacity:.95}50%{transform:scale(1.15);opacity:.65}}';
    return wrap(c, css, defsDesk(c), b);
  }

  function draw(role, opts) {
    var r = ROLES.indexOf(role) < 0 ? 'idle' : role;
    var c = ctx(r, opts);
    if (r === 'lead') return spriteLead(c);
    if (r === 'builder') return spriteBuilder(c);
    if (r === 'fixer') return spriteFixer(c);
    if (r === 'reviewer') return spriteReviewer(c);
    return spriteIdle(c);
  }

  window.OfficeSprites = { roles: ROLES.slice(), draw: draw };
})();
