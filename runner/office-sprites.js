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

  function draw(role, opts) {
    var r = ROLES.indexOf(role) < 0 ? 'idle' : role;
    var c = ctx(r, opts);
    if (r === 'lead') return spriteLead(c);
    return spriteIdle(c);
  }

  window.OfficeSprites = { roles: ROLES.slice(), draw: draw };
})();
