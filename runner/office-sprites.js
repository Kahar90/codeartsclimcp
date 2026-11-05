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
      skin: '#f3c39a',
      skinHi: '#ffdcb0',
      skinLo: '#dfa677',
      ink: '#20242c',
      shoe: '#242833'
    };
  }

  function wrap(c, css, body) {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 200" width="160" height="200" role="img">';
    if (c.working && css) s += '<style>' + css + '</style>';
    return s + body + '</svg>';
  }

  function spriteIdle(c) {
    var p = c.p;
    var inner = '<rect x="68" y="126" width="11" height="52" rx="5.5" fill="' + c.pants + '"/>'
      + '<rect x="81" y="126" width="11" height="52" rx="5.5" fill="' + c.pantsLo + '"/>'
      + '<rect x="57.5" y="174.5" width="21" height="11" rx="5.5" fill="' + c.shoe + '"/>'
      + '<rect x="81.5" y="174.5" width="21" height="11" rx="5.5" fill="' + c.shoe + '"/>'
      + '<rect x="59" y="84" width="42" height="57" rx="14" fill="' + c.shirt + '"/>'
      + '<circle cx="80" cy="57" r="21" fill="' + c.skin + '"/>'
      + '<path d="M 59 57 A 21 21 0 0 1 101 57 Q 94 45 80 44 Q 66 45 59 57 Z" fill="' + c.hair + '"/>'
      + '<circle cx="72" cy="59" r="2.4" fill="' + c.ink + '"/>'
      + '<circle cx="88" cy="59" r="2.4" fill="' + c.ink + '"/>'
      + '<path d="M 73 66 Q 80 71 87 66" fill="none" stroke="#a35d43" stroke-width="2" stroke-linecap="round"/>';
    var body = '<ellipse cx="80" cy="187" rx="34" ry="8.5" fill="#000000" opacity="0.3"/>';
    var css = '';
    if (c.working) {
      css = '.' + p + 'bob{animation:' + p + 'bob 1.6s ease-in-out infinite}'
        + '@keyframes ' + p + 'bob{0%,100%{transform:translateY(0)}50%{transform:translateY(2px)}}';
      body += '<g class="' + p + 'bob">' + inner + '</g>';
    } else {
      body += inner;
    }
    return wrap(c, css, body);
  }

  function draw(role, opts) {
    var r = ROLES.indexOf(role) < 0 ? 'idle' : role;
    return spriteIdle(ctx(r, opts));
  }

  window.OfficeSprites = { roles: ROLES.slice(), draw: draw };
})();
