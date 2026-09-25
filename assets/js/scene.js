/*
 * scene.js — the particle engine behind the page.
 *
 *   var scene = ERH.Scene.create(canvas, { reducedMotion: false });
 *   scene.view({ shape: 'orb', side: 'right' });   // morph + place the shape
 *   scene.morphTo({ text: 'hello' });               // any registered shape or text
 *   scene.pulse(clientX, clientY);                  // shockwave
 *
 * Returns null when WebGL is unavailable so callers can fall back.
 */
(function (global) {
  'use strict';

  var ERH = (global.ERH = global.ERH || {});
  var G = ERH._gl;
  var S = G.shaders;
  var Shapes = ERH.Shapes;
  var damp = G.damp;

  var TAU = Math.PI * 2;
  var FOV = (40 * Math.PI) / 180;
  var CAM = 6;
  var HALF_H = Math.tan(FOV / 2) * CAM; // world half-height visible at z = 0
  var NOMINAL_R = 1.7;
  var BASE = [0.016, 0.02, 0.047]; // page background, linear-ish

  function create(canvas, opts) {
    opts = opts || {};
    var reduced = !!opts.reducedMotion;
    var attrs = {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    };
    var gl = null;
    try {
      gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs) ||
        canvas.getContext('experimental-webgl', attrs);
    } catch (e) { gl = null; }
    if (!gl) return null;

    var isGL2 = typeof global.WebGL2RenderingContext !== 'undefined' && gl instanceof global.WebGL2RenderingContext;
    var coarse = global.matchMedia && global.matchMedia('(pointer: coarse)').matches;
    var cores = global.navigator.hardwareConcurrency || 4;
    var maxCount = opts.count || (coarse || global.innerWidth < 760 ? 24000 : cores >= 8 ? 70000 : 50000);

    var quality = { maxDpr: coarse ? 1.5 : 1.75, scale: 1, count: maxCount };
    var P = {}, buf = {}, rt = {}, slots = [{}, {}], slotData = [null, null];
    var usePost = true, W = 0, H = 0, dpr = 1, maxPoint = 64, proj = null;
    var mv = new Float32Array(16);
    var needsResize = true, lost = false, running = false, raf = 0, last = 0;
    var listeners = {};

    // morph state: slot A holds `from`, slot B holds `cur`
    var aSlot = 0, bSlot = 1, morph = 1, morphDur = 1.8, stagger = 0.42, queued = null;
    var from = null, cur = null;

    // animated parameters (value + target)
    var layoutSpec = { side: 'center' };
    var L = { shiftX: 0, shiftY: 0, scale: 1, dim: 1 }, LT = { shiftX: 0, shiftY: 0, scale: 1, dim: 1 };
    var V = { tiltX: 0.2, spin: 0, angle: 0 }, VT = { tiltX: 0.2, spin: 0.08, sway: 0, faceFront: false };
    var noise = 0.08, noiseT = 0.08, size = 1, sizeT = 1, shapeScale = 1, shapeScaleT = 1;
    var neb = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], nebT = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    var mouse = { x: 0, y: 0, tx: 0, ty: 0, s: 0, ts: 0 };
    var pulseU = new Float32Array([0, 0, -100, 0]);
    var hyper = 0, hyperT = 0, turb = 0, scrollVel = 0, lastScroll = global.pageYOffset || 0;
    var time = 0, fade = 0, elapsed = 0;
    var fps = 60, fpsAcc = 0, fpsFrames = 0, badWindows = 0, lastDegrade = 0;

    var seeds = new Float32Array(maxCount * 4);
    for (var si = 0; si < seeds.length; si++) seeds[si] = Math.random();

    var cache = {}, lastText = null;

    function emit(type, data) {
      (listeners[type] || []).forEach(function (fn) {
        try { fn(data); } catch (e) { /* listener errors never break the render loop */ }
      });
    }

    /* ---------------- shapes ---------------- */

    function resolve(spec) {
      if (typeof spec === 'string') {
        var def = Shapes[spec];
        if (!def || spec === 'text') return null;
        if (!cache[spec]) cache[spec] = def.gen(maxCount);
        return { key: spec, name: spec, def: def, data: cache[spec] };
      }
      if (spec && spec.text != null) {
        var str = String(spec.text).slice(0, 40);
        var key = 'text:' + str;
        if (!lastText || lastText.key !== key) {
          lastText = { key: key, data: Shapes.text.gen(maxCount, str) };
        }
        return { key: key, name: 'text', text: str, def: Shapes.text, data: lastText.data };
      }
      return null;
    }

    function upload(slot, data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, slots[slot].pos);
      gl.bufferData(gl.ARRAY_BUFFER, data.pos, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, slots[slot].tag);
      gl.bufferData(gl.ARRAY_BUFFER, data.tag, gl.DYNAMIC_DRAW);
      slotData[slot] = data;
    }

    function applyShapeTargets(def) {
      VT.tiltX = def.tiltX || 0;
      VT.spin = def.spin || 0;
      VT.sway = def.sway || 0;
      VT.faceFront = !!def.faceFront;
      noiseT = def.noise == null ? 0.06 : def.noise;
      sizeT = def.size || 1;
      shapeScaleT = def.scale || 1;
      var c1 = def.colors[0], c2 = def.colors[1];
      nebT[0] = [c1[0] * 0.2, c1[1] * 0.2, c1[2] * 0.24];
      nebT[1] = [c2[0] * 0.1, c2[1] * 0.1, c2[2] * 0.14];
      nebT[2] = G.mix3([0, 0, 0], c1, c2, 0.5).map(function (v) { return v * 0.24; });
    }

    function start(r, duration, stag) {
      var t = aSlot; aSlot = bSlot; bSlot = t;
      if (!lost) upload(bSlot, r.data); else slotData[bSlot] = r.data;
      from = cur;
      cur = r;
      morph = 0;
      morphDur = duration || (reduced ? 0.7 : 1.8);
      stagger = stag == null ? (reduced ? 0 : 0.42) : stag;
      applyShapeTargets(r.def);
      emit('shape', { name: r.name, key: r.key, text: r.text, label: r.def.label || r.name });
    }

    function morphTo(spec) {
      var r = resolve(spec);
      if (!r) return false;
      if (morph < 1) {
        queued = r.key === cur.key ? null : r;
        return true;
      }
      if (r.key !== cur.key) start(r);
      return true;
    }

    /* ---------------- layout ---------------- */

    function computeLayout() {
      var aspect = W / Math.max(1, H);
      var halfW = HALF_H * aspect;
      var cssW = canvas.clientWidth || global.innerWidth;
      var wide = cssW >= 960 && aspect > 1.1;
      var spec = layoutSpec;
      var t = { shiftX: 0, shiftY: 0, scale: 1, dim: spec.dim == null ? 1 : spec.dim };
      if (wide && spec.side && spec.side !== 'center') {
        var sx = 0.5;
        t.shiftX = spec.side === 'left' ? -sx : sx;
        t.scale = Math.min(1.12, Math.min(halfW * (1 - sx) * 0.95, HALF_H * 0.9) / NOMINAL_R);
      } else if (wide) {
        t.shiftY = spec.shiftY || 0;
        t.scale = Math.min(1.2, (Math.min(halfW, HALF_H) * 0.92) / NOMINAL_R);
      } else {
        t.shiftY = spec.mobileY || 0;
        t.scale = Math.min(1.05, Math.min(halfW * 1.02, HALF_H * 0.9) / NOMINAL_R);
        t.dim *= spec.mobileDim == null ? 0.62 : spec.mobileDim;
      }
      if (spec.scale) t.scale *= spec.scale;
      LT = t;
    }

    /* ---------------- GL setup ---------------- */

    function initGL() {
      P.particles = G.program(gl, S.PARTICLE_VS, S.PARTICLE_FS, ['aPosA', 'aPosB', 'aTagA', 'aTagB', 'aSeed']);
      P.nebula = G.program(gl, S.TRI_VS, S.NEBULA_FS, ['aPos']);
      P.nebulaDirect = G.program(gl, S.TRI_VS, S.NEBULA_DIRECT_FS, ['aPos']);
      P.copy = G.program(gl, S.TRI_VS, S.COPY_FS, ['aPos']);
      P.bright = G.program(gl, S.TRI_VS, S.BRIGHT_FS, ['aPos']);
      P.blur = G.program(gl, S.TRI_VS, S.BLUR_FS, ['aPos']);
      P.composite = G.program(gl, S.TRI_VS, S.COMPOSITE_FS, ['aPos']);

      buf.tri = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.tri);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

      buf.seed = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.seed);
      gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);

      for (var s = 0; s < 2; s++) {
        slots[s] = { pos: gl.createBuffer(), tag: gl.createBuffer() };
        if (slotData[s]) upload(s, slotData[s]);
      }

      var range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
      maxPoint = Math.max(1, Math.min(64, range ? range[1] : 64));

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      usePost = true;
      rt = {};
      W = H = 0;
      needsResize = true;
    }

    function buildTargets() {
      ['scene', 'bg', 'bloomA', 'bloomB'].forEach(function (k) { G.freeTarget(gl, rt[k]); });
      rt = {};
      if (!usePost) return;
      var qw = Math.max(1, Math.round(W / 4)), qh = Math.max(1, Math.round(H / 4));
      rt.scene = G.target(gl, W, H);
      rt.bg = G.target(gl, qw, qh);
      rt.bloomA = G.target(gl, qw, qh);
      rt.bloomB = G.target(gl, qw, qh);
      if (!rt.scene.ok || !rt.bg.ok || !rt.bloomA.ok || !rt.bloomB.ok) {
        usePost = false;
        buildTargets();
      }
    }

    function resize() {
      var cssW = canvas.clientWidth || global.innerWidth;
      var cssH = canvas.clientHeight || global.innerHeight;
      dpr = Math.min(global.devicePixelRatio || 1, quality.maxDpr) * quality.scale;
      var w = Math.max(1, Math.round(cssW * dpr));
      var h = Math.max(1, Math.round(cssH * dpr));
      if (w === W && h === H) return;
      W = canvas.width = w;
      H = canvas.height = h;
      proj = G.perspective(FOV, w / h, 0.1, 100);
      buildTargets();
      computeLayout();
    }

    /* ---------------- drawing ---------------- */

    function use(p) {
      gl.useProgram(p.id);
      return p.u;
    }

    function tex(loc, unit, t) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(loc, unit);
    }

    function drawTri() {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.tri);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      for (var i = 1; i < 5; i++) gl.disableVertexAttribArray(i);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function attrib(loc, buffer, components) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, components, gl.FLOAT, false, 0, 0);
    }

    function bindTarget(t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
      gl.viewport(0, 0, t ? t.w : W, t ? t.h : H);
    }

    function drawNebula(p, w, h) {
      var u = use(p);
      gl.uniform2f(u.uRes, w, h);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uScroll, (global.pageYOffset || 0) / Math.max(1, global.innerHeight));
      gl.uniform2f(u.uMouse, mouse.x, mouse.y);
      gl.uniform3fv(u.uC1, neb[0]);
      gl.uniform3fv(u.uC2, neb[1]);
      gl.uniform3fv(u.uC3, neb[2]);
      drawTri();
    }

    function drawParticles() {
      var u = use(P.particles);
      var ax = V.tiltX + mouse.y * (reduced ? 0 : 0.12);
      var ay = V.angle + mouse.x * (reduced ? 0 : 0.22);
      G.modelView(ax, ay, CAM, mv);
      var countComp = Math.min(2, Math.sqrt(70000 / quality.count));
      gl.uniformMatrix4fv(u.uProj, false, proj);
      gl.uniformMatrix4fv(u.uModelView, false, mv);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uMorph, morph);
      gl.uniform1f(u.uStagger, stagger);
      gl.uniform1f(u.uNoiseAmp, noise * (1 + hyper * 1.5));
      gl.uniform1f(u.uTurb, turb);
      gl.uniform1f(u.uScale, L.scale * shapeScale);
      gl.uniform2f(u.uShift, L.shiftX, L.shiftY);
      gl.uniform2f(u.uMouse, mouse.x, mouse.y);
      gl.uniform1f(u.uMouseStrength, mouse.s);
      gl.uniform1f(u.uAspect, W / H);
      gl.uniform4fv(u.uPulse, pulseU);
      gl.uniform1f(u.uSize, 2.7 * size);
      gl.uniform1f(u.uViewH, H);
      gl.uniform1f(u.uMaxPoint, maxPoint);
      gl.uniform3fv(u.uColA1, from.def.colors[0]);
      gl.uniform3fv(u.uColA2, from.def.colors[1]);
      gl.uniform3fv(u.uColB1, cur.def.colors[0]);
      gl.uniform3fv(u.uColB2, cur.def.colors[1]);
      gl.uniform1f(u.uHyper, hyper);
      gl.uniform1f(u.uIntensity, 0.62 * L.dim * countComp);

      attrib(0, slots[aSlot].pos, 3);
      attrib(1, slots[bSlot].pos, 3);
      attrib(2, slots[aSlot].tag, 2);
      attrib(3, slots[bSlot].tag, 2);
      attrib(4, buf.seed, 4);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, quality.count);
      gl.disable(gl.BLEND);
    }

    function render() {
      var u;
      if (usePost) {
        bindTarget(rt.bg);
        drawNebula(P.nebula, rt.bg.w, rt.bg.h);

        bindTarget(rt.scene);
        u = use(P.copy);
        tex(u.uTex, 0, rt.bg.tex);
        gl.uniform3fv(u.uBase, BASE);
        drawTri();
        drawParticles();

        bindTarget(rt.bloomA);
        u = use(P.bright);
        tex(u.uTex, 0, rt.scene.tex);
        gl.uniform2f(u.uTexel, 1 / W, 1 / H);
        gl.uniform1f(u.uThreshold, 0.32);
        drawTri();

        bindTarget(rt.bloomB);
        u = use(P.blur);
        tex(u.uTex, 0, rt.bloomA.tex);
        gl.uniform2f(u.uDir, 1.4 / rt.bloomA.w, 0);
        drawTri();

        bindTarget(rt.bloomA);
        tex(u.uTex, 0, rt.bloomB.tex);
        gl.uniform2f(u.uDir, 0, 1.4 / rt.bloomA.h);
        drawTri();

        bindTarget(null);
        u = use(P.composite);
        tex(u.uScene, 0, rt.scene.tex);
        tex(u.uBloom, 1, rt.bloomA.tex);
        gl.uniform1f(u.uBloomStrength, 0.95 + hyper * 0.4);
        gl.uniform1f(u.uTime, time);
        gl.uniform1f(u.uFade, fade);
        gl.uniform1f(u.uScrollPx, global.pageYOffset || 0);
        gl.uniform1f(u.uDpr, dpr);
        gl.uniform1f(u.uAspect, W / H);
        drawTri();
      } else {
        bindTarget(null);
        drawNebula(P.nebulaDirect, W, H);
        drawParticles();
      }
    }

    /* ---------------- per-frame update ---------------- */

    function update(dt) {
      elapsed += dt;
      time += dt * (reduced ? 0.25 : 1) * (1 + hyper * 0.8);
      if (time > 20000) {
        // keep shader float precision healthy on very long sessions
        time -= 20000;
        pulseU[2] -= 20000;
      }

      if (morph < 1) {
        var dur = queued ? Math.min(morphDur, 0.55) : morphDur;
        morph = Math.min(1, morph + dt / dur);
        if (morph >= 1 && queued) {
          var q = queued;
          queued = null;
          start(q);
        }
      }

      var sy = global.pageYOffset || 0;
      var v = (sy - lastScroll) / Math.max(dt, 1e-3);
      lastScroll = sy;
      scrollVel = damp(scrollVel, v, 6, dt);
      turb = damp(turb, reduced ? 0 : Math.min(0.32, Math.abs(scrollVel) / 6000), 5, dt);

      mouse.x = damp(mouse.x, mouse.tx, 5, dt);
      mouse.y = damp(mouse.y, mouse.ty, 5, dt);
      mouse.s = damp(mouse.s, reduced ? 0 : mouse.ts, 3, dt);

      L.shiftX = damp(L.shiftX, LT.shiftX, 2.4, dt);
      L.shiftY = damp(L.shiftY, LT.shiftY, 2.4, dt);
      L.scale = damp(L.scale, LT.scale, 2.4, dt);
      L.dim = damp(L.dim, LT.dim, 2.4, dt);

      V.tiltX = damp(V.tiltX, layoutSpec.tiltX == null ? VT.tiltX : layoutSpec.tiltX, 1.8, dt);
      V.spin = damp(V.spin, VT.spin * (reduced ? 0.3 : 1) * (1 + hyper * 2.5), 1.5, dt);
      if (VT.faceFront) {
        var k = Math.round(V.angle / TAU);
        V.angle = damp(V.angle, k * TAU + Math.sin(time * 0.35) * VT.sway, 2.2, dt);
      } else {
        V.angle += V.spin * dt;
      }

      noise = damp(noise, noiseT, 2, dt);
      size = damp(size, sizeT, 2, dt);
      shapeScale = damp(shapeScale, shapeScaleT, 2.4, dt);
      for (var n = 0; n < 3; n++) {
        for (var c = 0; c < 3; c++) neb[n][c] = damp(neb[n][c], nebT[n][c], 1.2, dt);
      }
      hyper = damp(hyper, hyperT, 2, dt);
      fade = Math.min(1, fade + dt / (reduced ? 0.3 : 1.4));
    }

    function trackFps(dt) {
      fpsAcc += dt;
      fpsFrames++;
      if (fpsAcc < 0.5) return;
      fps = fpsFrames / fpsAcc;
      fpsAcc = 0;
      fpsFrames = 0;
      if (elapsed < 3 || opts.fixedQuality) return;
      badWindows = fps < 40 ? badWindows + 1 : Math.max(0, badWindows - 1);
      if (badWindows >= 3 && elapsed - lastDegrade > 2) {
        badWindows = 0;
        lastDegrade = elapsed;
        if (quality.scale > 0.7) {
          quality.scale = Math.max(0.6, quality.scale - 0.15);
          needsResize = true;
        } else if (quality.count > maxCount * 0.3) {
          quality.count = Math.floor(quality.count * 0.75);
        }
        emit('quality', { scale: quality.scale, count: quality.count });
      }
    }

    function frame(now) {
      if (!running) return;
      raf = global.requestAnimationFrame(frame);
      var dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      if (needsResize) {
        needsResize = false;
        resize();
      }
      update(dt);
      render();
      trackFps(dt);
    }

    function startLoop() {
      if (running || lost) return;
      running = true;
      last = global.performance.now();
      raf = global.requestAnimationFrame(frame);
    }

    function stopLoop() {
      running = false;
      global.cancelAnimationFrame(raf);
    }

    /* ---------------- input ---------------- */

    function pointer(e) {
      mouse.tx = (e.clientX / Math.max(1, global.innerWidth)) * 2 - 1;
      mouse.ty = 1 - (e.clientY / Math.max(1, global.innerHeight)) * 2;
      mouse.ts = 1;
    }

    global.addEventListener('pointermove', pointer, { passive: true });
    global.addEventListener('pointerdown', pointer, { passive: true });
    global.addEventListener('pointerup', function (e) {
      if (e.pointerType !== 'mouse') mouse.ts = 0;
    }, { passive: true });
    global.document.documentElement.addEventListener('pointerleave', function () { mouse.ts = 0; });
    global.addEventListener('blur', function () { mouse.ts = 0; });
    global.addEventListener('resize', function () { needsResize = true; });
    global.document.addEventListener('visibilitychange', function () {
      if (global.document.hidden) stopLoop(); else startLoop();
    });

    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      lost = true;
      stopLoop();
    }, false);
    canvas.addEventListener('webglcontextrestored', function () {
      lost = false;
      try {
        initGL();
        startLoop();
      } catch (err) {
        emit('error', err);
      }
    }, false);

    /* ---------------- boot ---------------- */

    try {
      initGL();
    } catch (err) {
      if (global.console) global.console.warn('[scene] WebGL init failed:', err);
      return null;
    }

    var first = resolve(opts.shape || 'orb') || resolve('orb');
    if (reduced || opts.intro === false) {
      from = first;
      cur = first;
      upload(aSlot, first.data);
      upload(bSlot, first.data);
      morph = 1;
      applyShapeTargets(first.def);
      V.tiltX = VT.tiltX;
    } else {
      cur = resolve('scatter');
      upload(bSlot, cur.data);
      upload(aSlot, cur.data);
      start(first, 2.8, 0.55);
      V.tiltX = VT.tiltX;
    }
    neb = nebT.map(function (c) { return c.slice(); });
    startLoop();

    var api = {
      webgl: isGL2 ? 2 : 1,
      maxCount: maxCount,
      shapes: Shapes.names.slice(),
      morphTo: morphTo,
      setLayout: function (spec) {
        layoutSpec = spec || { side: 'center' };
        if (W && H) computeLayout();
      },
      view: function (spec) {
        api.setLayout(spec);
        if (spec && spec.shape) morphTo(spec.shape);
      },
      pulse: function (clientX, clientY, strength) {
        pulseU[0] = (clientX / Math.max(1, global.innerWidth)) * 2 - 1;
        pulseU[1] = 1 - (clientY / Math.max(1, global.innerHeight)) * 2;
        pulseU[2] = time;
        pulseU[3] = reduced ? 0.3 : strength == null ? 1 : strength;
      },
      setHyper: function (on) { hyperT = on ? 1 : 0; return !!on; },
      toggleHyper: function () { return api.setHyper(!hyperT); },
      isHyper: function () { return !!hyperT; },
      setCount: function (n) {
        quality.count = Math.max(1000, Math.min(maxCount, Math.round(n) || maxCount));
        return quality.count;
      },
      // the shape the engine is heading to (a queued morph counts)
      current: function () {
        var t = queued || cur;
        return { name: t.name, key: t.key, text: t.text, label: t.def.label || t.name };
      },
      info: function () {
        return {
          fps: fps, count: quality.count, max: maxCount, dpr: dpr, webgl: isGL2 ? 2 : 1,
          post: usePost, width: W, height: H, shape: cur ? cur.key : ''
        };
      },
      renderer: function () {
        try {
          if (!/firefox/i.test(global.navigator.userAgent)) {
            var ext = gl.getExtension('WEBGL_debug_renderer_info');
            if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
          }
          return String(gl.getParameter(gl.RENDERER));
        } catch (e) { return 'unknown'; }
      },
      on: function (type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      }
    };
    return api;
  }

  ERH.Scene = { create: create };
})(window);
