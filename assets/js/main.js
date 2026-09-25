/*
 * main.js — page behaviour: scene/section sync, navigation, reveals,
 * text decode effects, terminal wiring, clipboard, HUD and easter eggs.
 */
(function (global) {
  'use strict';

  var ERH = (global.ERH = global.ERH || {});
  var doc = global.document;
  var root = doc.documentElement;
  var mq = function (q) { return global.matchMedia ? global.matchMedia(q).matches : false; };
  var reduced = mq('(prefers-reduced-motion: reduce)');
  var finePointer = mq('(hover: hover) and (pointer: fine)');
  var $ = function (sel, ctx) { return (ctx || doc).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); };

  // What the particle engine shows while each section crosses the middle of the viewport.
  var SECTION_VIEW = {
    hero: { shape: 'orb', side: 'right', mobileY: 0.34, mobileDim: 0.9 },
    about: { shape: 'knot', side: 'left' },
    botify: { shape: 'graph', side: 'right' },
    nxpm: { shape: 'cube', side: 'left' },
    fgo: { shape: 'gear', side: 'right' },
    terminal: { shape: 'grid', side: 'right' },
    contact: { shape: 'galaxy', side: 'center', shiftY: -0.86, tiltX: 0.42, dim: 0.85, mobileY: -0.62, mobileDim: 0.75 }
  };
  var NAV_FOR = { about: 'about', botify: 'projects', nxpm: 'projects', fgo: 'projects', terminal: 'terminal', contact: 'contact' };

  /* ---------------- scene ---------------- */

  var scene = null;
  var canvas = doc.getElementById('gl');
  if (canvas && ERH.Scene) {
    try {
      scene = ERH.Scene.create(canvas, {
        reducedMotion: reduced,
        fixedQuality: /[?&]quality=fixed\b/.test(global.location.search)
      });
    } catch (e) {
      scene = null;
    }
  }
  root.classList.add(scene ? 'has-webgl' : 'no-webgl');

  var fmt = function (n) { return Math.round(n).toLocaleString('en-US'); };

  function updateCounts() {
    if (!scene) return;
    var info = scene.info();
    $$('[data-particle-count]').forEach(function (el) { el.textContent = fmt(info.count); });
    $$('[data-webgl-version]').forEach(function (el) { el.textContent = 'WebGL ' + info.webgl; });
  }

  if (scene) {
    updateCounts();
    var nameEl = $('[data-scene-name]');
    var setName = function (s) { if (nameEl) nameEl.textContent = s.label; };
    setName(scene.current());
    scene.on('shape', setName);
    scene.on('quality', updateCounts);
  }

  /* ---------------- toast ---------------- */

  var toastEl = $('#toast');
  var toastTimer = 0;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('is-visible');
    global.clearTimeout(toastTimer);
    toastTimer = global.setTimeout(function () { toastEl.classList.remove('is-visible'); }, 2600);
  }

  /* ---------------- text decode effect ---------------- */

  var GLYPHS = '!<>-_\\/[]{}=+*^?#%&01';

  function prepScramble(el) {
    if (el._scramble) return;
    var text = el.textContent;
    el.textContent = '';
    var sr = doc.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = text;
    var vis = doc.createElement('span');
    vis.setAttribute('aria-hidden', 'true');
    vis.textContent = text;
    el.appendChild(sr);
    el.appendChild(vis);
    el._scramble = { text: text, vis: vis, done: false };
  }

  function scramble(el) {
    var d = el._scramble;
    if (!d || d.done || reduced) return;
    d.done = true;
    var text = d.text, len = text.length;
    var t0 = global.performance.now();
    var dur = Math.min(1300, 450 + len * 55);
    var at = [];
    for (var i = 0; i < len; i++) at.push(t0 + (i / len) * dur * 0.65 + Math.random() * dur * 0.35);
    (function tick(now) {
      var s = '', done = true;
      for (var k = 0; k < len; k++) {
        var ch = text.charAt(k);
        if (ch === ' ' || ch === '\u200b' || now >= at[k]) s += ch;
        else {
          done = false;
          s += GLYPHS.charAt(Math.floor(Math.random() * GLYPHS.length));
        }
      }
      d.vis.textContent = s;
      if (!done) global.requestAnimationFrame(tick);
    })(t0);
  }

  $$('[data-scramble]').forEach(prepScramble);

  /* ---------------- reveal on scroll ---------------- */

  var revealables = $$('[data-reveal]');
  if ('IntersectionObserver' in global) {
    var io = new global.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        el.classList.add('is-in');
        if (el.hasAttribute('data-scramble')) scramble(el);
        $$('[data-scramble]', el).forEach(scramble);
        io.unobserve(el);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    revealables.forEach(function (el) { io.observe(el); });
    // headings that are not inside a reveal wrapper still decode once visible
    $$('[data-scramble]').forEach(function (el) {
      if (!el.closest('[data-reveal]')) io.observe(el);
    });
  } else {
    revealables.forEach(function (el) { el.classList.add('is-in'); });
  }

  /* ---------------- navigation ---------------- */

  var nav = $('[data-nav-bar]');
  var progress = $('[data-progress]');
  var hero = $('[data-section="hero"]');
  var sections = $$('[data-section]');
  var active = null;

  function setActive(name) {
    $$('[data-nav]').forEach(function (a) {
      if (a.getAttribute('data-nav') === NAV_FOR[name]) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
    $$('[data-rail]').forEach(function (a) {
      a.classList.toggle('is-active', a.getAttribute('data-rail') === name);
    });
    root.classList.toggle('in-hero', name === 'hero');
    if (scene && SECTION_VIEW[name]) scene.view(SECTION_VIEW[name]);
  }

  function findActive() {
    var mid = global.innerHeight * 0.5;
    for (var i = 0; i < sections.length; i++) {
      var r = sections[i].getBoundingClientRect();
      if (r.top <= mid && r.bottom > mid) return sections[i];
    }
    return null;
  }

  function onScrollFrame() {
    var y = global.pageYOffset || 0;
    var max = root.scrollHeight - global.innerHeight;
    if (progress) progress.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, y / max) : 0).toFixed(4) + ')';
    if (nav) nav.classList.toggle('is-scrolled', y > 16);
    if (hero && !reduced) {
      var p = Math.min(1, y / Math.max(1, hero.offsetHeight));
      hero.style.setProperty('--hero-p', p.toFixed(3));
    }
    var found = findActive();
    if (found && found !== active) {
      active = found;
      setActive(found.getAttribute('data-section'));
    }
  }

  var ticking = false;
  function requestScrollFrame() {
    if (ticking) return;
    ticking = true;
    global.requestAnimationFrame(function () {
      ticking = false;
      onScrollFrame();
    });
  }
  global.addEventListener('scroll', requestScrollFrame, { passive: true });
  global.addEventListener('resize', requestScrollFrame);
  onScrollFrame();

  /* mobile menu */
  var menuBtn = $('[data-menu-toggle]');
  var menu = $('#mobile-menu');
  var menuTimer = 0;
  function setMenu(open) {
    if (!menuBtn || !menu) return;
    global.clearTimeout(menuTimer);
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    root.classList.toggle('menu-open', open);
    if (open) {
      menu.hidden = false;
      global.requestAnimationFrame(function () { menu.classList.add('is-open'); });
    } else {
      menu.classList.remove('is-open');
      menuTimer = global.setTimeout(function () { menu.hidden = true; }, reduced ? 0 : 320);
    }
  }
  if (menuBtn && menu) {
    menuBtn.addEventListener('click', function () {
      setMenu(menuBtn.getAttribute('aria-expanded') !== 'true');
    });
    $$('a', menu).forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menuBtn.getAttribute('aria-expanded') === 'true') {
        setMenu(false);
        menuBtn.focus();
      }
    });
    global.addEventListener('resize', function () {
      if (global.innerWidth > 860) setMenu(false);
    });
  }

  /* ---------------- pointer niceties ---------------- */

  if (finePointer && !reduced) {
    $$('[data-magnetic]').forEach(function (el) {
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        var x = e.clientX - (r.left + r.width / 2);
        var y = e.clientY - (r.top + r.height / 2);
        el.style.transform = 'translate(' + (x * 0.2).toFixed(1) + 'px,' + (y * 0.3).toFixed(1) + 'px)';
      });
      el.addEventListener('pointerleave', function () { el.style.transform = ''; });
    });

    doc.addEventListener('pointermove', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('.spot') : null;
      if (!el) return;
      var r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (e.clientX - r.left).toFixed(0) + 'px');
      el.style.setProperty('--my', (e.clientY - r.top).toFixed(0) + 'px');
    }, { passive: true });
  }

  if (scene) {
    global.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      var t = e.target;
      if (t && t.closest && t.closest('a, button, input, textarea, select, label, [data-term], [data-no-pulse]')) return;
      scene.pulse(e.clientX, e.clientY);
    }, { passive: true });
  }

  /* ---------------- clipboard ---------------- */

  function copyText(text) {
    if (global.navigator.clipboard && global.isSecureContext) {
      return global.navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
    doc.body.removeChild(ta);
    return ok;
  }

  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var value = btn.getAttribute('data-copy');
      copyText(value).then(function (ok) {
        toast(ok ? 'Copied “' + value + '” to your clipboard' : 'Copy failed. The handle is ' + value);
        if (!ok) return;
        btn.classList.add('is-copied');
        global.setTimeout(function () { btn.classList.remove('is-copied'); }, 1800);
        if (scene) {
          var r = btn.getBoundingClientRect();
          scene.pulse(r.left + r.width / 2, r.top + r.height / 2, 0.9);
        }
      });
    });
  });

  /* ---------------- HUD ---------------- */

  var hud = $('#hud');
  var hudTimer = 0;
  var hudOn = false;
  function renderHud() {
    if (!hud || !scene) return;
    var i = scene.info();
    hud.textContent = fmt(i.fps) + ' fps · ' + fmt(i.count) + ' particles · ' + i.width + '×' + i.height +
      ' · dpr ' + i.dpr.toFixed(2) + ' · WebGL ' + i.webgl + (i.post ? ' + bloom' : '') + ' · ' + scene.current().label;
  }
  function toggleHud(force) {
    if (!hud || !scene) return false;
    hudOn = typeof force === 'boolean' ? force : !hudOn;
    hud.hidden = !hudOn;
    global.clearInterval(hudTimer);
    if (hudOn) {
      renderHud();
      hudTimer = global.setInterval(renderHud, 500);
    }
    return hudOn;
  }
  $$('[data-hud-toggle]').forEach(function (b) {
    b.addEventListener('click', function () { toggleHud(); });
  });

  /* ---------------- terminal ---------------- */

  var termRoot = $('[data-term]');
  var term = null;
  if (termRoot && ERH.Terminal) {
    term = ERH.Terminal.create(termRoot, {
      scene: scene,
      reducedMotion: reduced,
      onHud: function () { return toggleHud(); },
      onHyper: function (on) { toast(on ? 'Hyper mode engaged' : 'Hyper mode off'); },
      pulseCenter: function () {
        if (!scene) return;
        var wide = global.innerWidth >= 960;
        scene.pulse(global.innerWidth * (wide ? 0.75 : 0.5), global.innerHeight * 0.5, 1);
      }
    });

    if ('IntersectionObserver' in global) {
      var tio = new global.IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) {
          term.boot();
          tio.disconnect();
        }
      }, { threshold: 0.35 });
      tio.observe(termRoot);
    } else {
      term.boot();
    }

    $$('[data-cmd]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        term.exec(btn.getAttribute('data-cmd'));
      });
    });
  }

  /* ---------------- keyboard: HUD + konami ---------------- */

  var KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  var kIndex = 0;
  function typing(el) {
    return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }
  doc.addEventListener('keydown', function (e) {
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    var key = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === '`') {
      toggleHud();
      return;
    }
    if (key === KONAMI[kIndex]) {
      kIndex++;
      if (kIndex === KONAMI.length) {
        kIndex = 0;
        if (scene) {
          var on = scene.toggleHyper();
          toast(on ? '↑↑↓↓←→←→BA · Hyper mode engaged' : 'Hyper mode off');
        }
      }
    } else {
      kIndex = key === KONAMI[0] ? 1 : 0;
    }
  });

  /* ---------------- misc ---------------- */

  $$('[data-year]').forEach(function (el) { el.textContent = String(new Date().getFullYear()); });

  // Standalone pages (404) can ask for a text shape: <body data-scene-text="404">
  var sceneText = doc.body.getAttribute('data-scene-text');
  if (scene && sceneText) {
    var showText = function () {
      scene.view({ shape: { text: sceneText }, side: 'center', shiftY: 0.34, mobileY: 0.36, mobileDim: 0.9, scale: 0.78 });
    };
    if (doc.fonts && doc.fonts.ready) {
      var done = false;
      var once = function () { if (!done) { done = true; showText(); } };
      doc.fonts.load('700 100px "Space Grotesk"').then(once, once);
      global.setTimeout(once, 1500);
    } else {
      showText();
    }
  }

  ERH.page = { scene: scene, term: term, toast: toast, toggleHud: toggleHud };
})(window);
