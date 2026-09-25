/*
 * shapes.js — procedural point clouds for the particle engine.
 *
 * Every generator returns { pos: Float32Array(n * 3), tag: Float32Array(n * 2) }.
 *   pos  xyz position, roughly normalised to a radius of ~1.6 world units
 *   tag  x = "path" (0..1, drives the light pulses that travel along a shape)
 *        y = "tone" (0..1, position inside the shape's two-colour palette)
 *
 * Output is shuffled, so drawing only the first K particles is always a
 * uniform subsample (the engine relies on that for adaptive quality).
 */
(function (global) {
  'use strict';

  var ERH = (global.ERH = global.ERH || {});
  var TAU = Math.PI * 2;
  var rand = Math.random;

  function gauss() {
    var u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rand());
  }

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /* ---------------------------------------------------------------- */

  function Builder(n) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.tag = new Float32Array(n * 2);
    this.i = 0;
  }

  Builder.prototype.push = function (x, y, z, path, tone) {
    if (this.i >= this.n) return;
    var i = this.i++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.tag[i * 2] = path;
    this.tag[i * 2 + 1] = clamp01(tone);
  };

  Builder.prototype.full = function () {
    return this.i >= this.n;
  };

  /* Scale so the furthest point sits at `radius`, then shuffle. */
  Builder.prototype.done = function (radius) {
    var n = this.n, pos = this.pos, tag = this.tag, i, j, t;

    // Pad (only happens if a generator under-fills).
    for (i = this.i; i < n; i++) {
      j = Math.floor(rand() * Math.max(1, this.i));
      pos[i * 3] = pos[j * 3];
      pos[i * 3 + 1] = pos[j * 3 + 1];
      pos[i * 3 + 2] = pos[j * 3 + 2];
      tag[i * 2] = tag[j * 2];
      tag[i * 2 + 1] = tag[j * 2 + 1];
    }

    if (radius) {
      // Normalise by the 98th-percentile distance so sparse halos and
      // sparks don't shrink the body of the shape.
      var dist = new Float32Array(n);
      for (i = 0; i < n; i++) {
        var x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        dist[i] = x * x + y * y + z * z;
      }
      dist.sort();
      var ref = Math.sqrt(dist[Math.floor((n - 1) * 0.98)]);
      var s = ref > 0 ? radius / ref : 1;
      for (i = 0; i < n * 3; i++) pos[i] *= s;
    }

    // Fisher–Yates over whole particles.
    for (i = n - 1; i > 0; i--) {
      j = Math.floor(rand() * (i + 1));
      t = pos[i * 3]; pos[i * 3] = pos[j * 3]; pos[j * 3] = t;
      t = pos[i * 3 + 1]; pos[i * 3 + 1] = pos[j * 3 + 1]; pos[j * 3 + 1] = t;
      t = pos[i * 3 + 2]; pos[i * 3 + 2] = pos[j * 3 + 2]; pos[j * 3 + 2] = t;
      t = tag[i * 2]; tag[i * 2] = tag[j * 2]; tag[j * 2] = t;
      t = tag[i * 2 + 1]; tag[i * 2 + 1] = tag[j * 2 + 1]; tag[j * 2 + 1] = t;
    }
    return { pos: pos, tag: tag };
  };

  /* Weighted pick: weights = [w0, w1, ...] summing to anything. */
  function picker(weights) {
    var total = 0, acc = [], i;
    for (i = 0; i < weights.length; i++) {
      total += weights[i];
      acc.push(total);
    }
    return function () {
      var r = rand() * total;
      for (var k = 0; k < acc.length; k++) if (r < acc[k]) return k;
      return acc.length - 1;
    };
  }

  function rotate(p, ax, az) {
    // rotate around X then Z
    var c = Math.cos(ax), s = Math.sin(ax);
    var y = p[1] * c - p[2] * s, z = p[1] * s + p[2] * c;
    p[1] = y; p[2] = z;
    c = Math.cos(az); s = Math.sin(az);
    var x = p[0] * c - p[1] * s;
    y = p[0] * s + p[1] * c;
    p[0] = x; p[1] = y;
    return p;
  }

  /* ---------------------------------------------------------------- */
  /* scatter — the chaotic cloud the intro condenses from              */

  function scatter(n) {
    var b = new Builder(n);
    while (!b.full()) {
      var x = gauss(), y = gauss(), z = gauss();
      var l = Math.sqrt(x * x + y * y + z * z) || 1;
      var r = 2.2 + Math.pow(rand(), 0.5) * 4.5;
      b.push((x / l) * r * 1.6, (y / l) * r, (z / l) * r, rand(), rand());
    }
    return b.done(0);
  }

  /* orb — fibonacci sphere with a tilted ring and a faint halo (hero) */

  function orb(n) {
    var b = new Builder(n);
    var shellN = Math.floor(n * 0.66);
    var ringN = Math.floor(n * 0.26);
    var golden = Math.PI * (3 - Math.sqrt(5));
    var k, p = [0, 0, 0];

    for (k = 0; k < shellN; k++) {
      var y = 1 - (2 * (k + 0.5)) / shellN;
      var r = Math.sqrt(1 - y * y);
      var th = golden * k;
      var R = 1 + gauss() * 0.008;
      b.push(Math.cos(th) * r * R, y * R, Math.sin(th) * r * R,
        (y + 1) * 0.5, 0.5 - y * 0.42 + gauss() * 0.1);
    }

    for (k = 0; k < ringN; k++) {
      var a = rand() * TAU;
      var rr = 1.45 + Math.pow(rand(), 1.8) * 0.62;
      if (rand() < 0.12) rr = 1.3 + rand() * 0.06; // thin inner ring
      p[0] = Math.cos(a) * rr;
      p[1] = gauss() * 0.01;
      p[2] = Math.sin(a) * rr;
      rotate(p, 0.28, 0.36);
      b.push(p[0], p[1], p[2], a / TAU, 0.8 + rand() * 0.2);
    }

    while (!b.full()) {
      var gx = gauss(), gy = gauss(), gz = gauss();
      var gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
      var hr = 1.15 + Math.pow(rand(), 2) * 1.3;
      b.push((gx / gl) * hr, (gy / gl) * hr, (gz / gl) * hr, rand(), rand());
    }
    return b.done(1.75);
  }

  /* knot — a (2,3) torus knot drawn as a hollow tube (about) */

  function knotAt(t, out) {
    var p = 2, q = 3, R = 1, r = 0.45;
    var rr = R + r * Math.cos(q * t);
    out[0] = rr * Math.cos(p * t);
    out[1] = r * Math.sin(q * t);
    out[2] = rr * Math.sin(p * t);
    return out;
  }

  function knot(n) {
    var b = new Builder(n);
    var P = [0, 0, 0], A = [0, 0, 0], B = [0, 0, 0];
    var h = 0.001;
    while (!b.full()) {
      var t = rand() * TAU;
      knotAt(t, P); knotAt(t + h, A); knotAt(t - h, B);
      // tangent
      var tx = A[0] - B[0], ty = A[1] - B[1], tz = A[2] - B[2];
      var tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      tx /= tl; ty /= tl; tz /= tl;
      // curvature direction
      var nx = A[0] + B[0] - 2 * P[0], ny = A[1] + B[1] - 2 * P[1], nz = A[2] + B[2] - 2 * P[2];
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      // binormal = T x N
      var bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;

      var phi = rand() * TAU;
      var aura = rand() < 0.14;
      var tube = aura ? 0.2 + rand() * 0.16 : 0.1 + gauss() * 0.006;
      var c = Math.cos(phi) * tube, s = Math.sin(phi) * tube;
      b.push(
        P[0] + nx * c + bx * s,
        P[1] + ny * c + by * s,
        P[2] + nz * c + bz * s,
        t / TAU,
        aura ? rand() : 0.5 + 0.5 * Math.sin(t * 3) * 0.8 + gauss() * 0.08
      );
    }
    return b.done(1.6);
  }

  /* graph — a Blueprint-style node graph with bezier wires (Botify) */

  var NODES = [
    { x: -1.8, y: 0.62, w: 0.98, h: 0.62, z: 0.12, ins: 0, outs: 2 },
    { x: -1.8, y: -0.66, w: 0.98, h: 0.5, z: -0.06, ins: 0, outs: 1 },
    { x: 0.0, y: 0.84, w: 1.08, h: 0.6, z: 0.0, ins: 1, outs: 2 },
    { x: 0.0, y: -0.46, w: 1.08, h: 0.88, z: 0.14, ins: 2, outs: 2 },
    { x: 1.8, y: 0.44, w: 0.98, h: 0.6, z: -0.1, ins: 2, outs: 0 },
    { x: 1.8, y: -0.86, w: 0.98, h: 0.5, z: 0.06, ins: 2, outs: 0 }
  ];
  // [fromNode, outPin, toNode, inPin]
  var EDGES = [
    [0, 0, 2, 0], [0, 1, 3, 0], [1, 0, 3, 1],
    [2, 0, 4, 0], [3, 0, 4, 1], [3, 1, 5, 0], [2, 1, 5, 1]
  ];
  var HEADER = 0.17, PIN_GAP = 0.17;

  function pinPos(node, side, idx) {
    var top = node.y + node.h / 2;
    return [
      node.x + (side > 0 ? node.w / 2 : -node.w / 2),
      top - HEADER - 0.12 - idx * PIN_GAP,
      node.z
    ];
  }

  function bezier(p0, p1, p2, p3, t, out) {
    var u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out[0] = a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0];
    out[1] = a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1];
    out[2] = a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2];
    return out;
  }

  function roundedRectPoint(node, s, out) {
    // s in [0,1) along the perimeter of a rounded rectangle
    var w = node.w, h = node.h, r = 0.07;
    var sw = w - 2 * r, sh = h - 2 * r, arc = (Math.PI / 2) * r;
    var per = 2 * sw + 2 * sh + 4 * arc;
    var d = s * per;
    var x0 = node.x - w / 2, y0 = node.y - h / 2, x1 = node.x + w / 2, y1 = node.y + h / 2;
    var segs = [
      ['l', sw, x0 + r, y1, 1, 0],
      ['a', arc, x1 - r, y1 - r, Math.PI / 2, 0],
      ['l', sh, x1, y1 - r, 0, -1],
      ['a', arc, x1 - r, y0 + r, 0, -Math.PI / 2],
      ['l', sw, x1 - r, y0, -1, 0],
      ['a', arc, x0 + r, y0 + r, -Math.PI / 2, -Math.PI],
      ['l', sh, x0, y0 + r, 0, 1],
      ['a', arc, x0 + r, y1 - r, Math.PI, Math.PI / 2]
    ];
    for (var k = 0; k < segs.length; k++) {
      var g = segs[k];
      if (d <= g[1] || k === segs.length - 1) {
        var f = Math.min(1, d / g[1]);
        if (g[0] === 'l') {
          out[0] = g[2] + g[4] * f * g[1];
          out[1] = g[3] + g[5] * f * g[1];
        } else {
          var ang = g[4] + (g[5] - g[4]) * f;
          out[0] = g[2] + Math.cos(ang) * r;
          out[1] = g[3] + Math.sin(ang) * r;
        }
        out[2] = node.z;
        return out;
      }
      d -= g[1];
    }
    return out;
  }

  function graph(n) {
    var b = new Builder(n);
    var wires = EDGES.map(function (e) {
      var p0 = pinPos(NODES[e[0]], 1, e[1]);
      var p3 = pinPos(NODES[e[2]], -1, e[3]);
      var dx = Math.max(0.45, (p3[0] - p0[0]) * 0.55);
      var p1 = [p0[0] + dx, p0[1], p0[2]];
      var p2 = [p3[0] - dx, p3[1], p3[2]];
      // approximate length for weighting
      var len = 0, prev = p0.slice(), cur = [0, 0, 0];
      for (var k = 1; k <= 24; k++) {
        bezier(p0, p1, p2, p3, k / 24, cur);
        len += Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]);
        prev = cur.slice();
      }
      return { p: [p0, p1, p2, p3], len: len };
    });
    var pickWire = picker(wires.map(function (w) { return w.len; }));
    var pickNode = picker(NODES.map(function (nd) { return nd.w + nd.h; }));
    var pickPart = picker([0.46, 0.2, 0.14, 0.09, 0.11]);
    var out = [0, 0, 0];

    while (!b.full()) {
      if (rand() < 0.5) {
        var w = wires[pickWire()];
        var t = rand();
        bezier(w.p[0], w.p[1], w.p[2], w.p[3], t, out);
        var j = 0.006 + (rand() < 0.2 ? 0.012 : 0);
        b.push(out[0] + gauss() * j, out[1] + gauss() * j, out[2] + gauss() * j,
          t, 0.82 + rand() * 0.18);
        continue;
      }
      var nd = NODES[pickNode()];
      var part = pickPart();
      var top = nd.y + nd.h / 2, left = nd.x - nd.w / 2;
      if (part === 0) {
        roundedRectPoint(nd, rand(), out);
        b.push(out[0] + gauss() * 0.004, out[1] + gauss() * 0.004, out[2], rand(), 0.1);
      } else if (part === 1) {
        // header bar
        b.push(left + 0.02 + rand() * (nd.w - 0.04), top - 0.02 - rand() * (HEADER - 0.03),
          nd.z + gauss() * 0.004, rand(), 0.0);
      } else if (part === 2) {
        // "label" rows inside the body
        var row = Math.floor(rand() * 3);
        var rowLen = 0.28 + ((row * 37 + Math.round(nd.x * 11 + nd.y * 7)) % 5) * 0.08;
        b.push(left + 0.14 + rand() * Math.min(rowLen, nd.w - 0.28),
          top - HEADER - 0.12 - row * PIN_GAP + gauss() * 0.006,
          nd.z, rand(), 0.35);
      } else if (part === 3) {
        // sparse body fill
        b.push(left + rand() * nd.w, nd.y - nd.h / 2 + rand() * (nd.h - HEADER),
          nd.z + gauss() * 0.01, rand(), 0.25);
      } else {
        // pins (small rings)
        var outs = nd.outs, ins = nd.ins;
        if (!outs && !ins) continue;
        var side = rand() < outs / (outs + ins) ? 1 : -1;
        var idx = Math.floor(rand() * (side > 0 ? outs : ins));
        var pp = pinPos(nd, side, idx);
        var a = rand() * TAU, pr = 0.038;
        b.push(pp[0] + Math.cos(a) * pr, pp[1] + Math.sin(a) * pr, pp[2], rand(), 1.0);
      }
    }
    return b.done(1.95);
  }

  /* cube — an outer and inner cube joined corner to corner (nxpm) */

  function cube(n) {
    var b = new Builder(n);
    var O = 1, I = 0.46;
    function corners(s) {
      var c = [];
      for (var i = 0; i < 8; i++) c.push([(i & 1 ? 1 : -1) * s, (i & 2 ? 1 : -1) * s, (i & 4 ? 1 : -1) * s]);
      return c;
    }
    function edges(c) {
      var e = [];
      for (var i = 0; i < 8; i++) for (var j = i + 1; j < 8; j++) {
        var diff = i ^ j;
        if (diff === 1 || diff === 2 || diff === 4) e.push([c[i], c[j]]);
      }
      return e;
    }
    var oc = corners(O), ic = corners(I);
    var oe = edges(oc), ie = edges(ic);
    var links = oc.map(function (c, k) { return [ic[k], c]; });
    var pickPart = picker([0.4, 0.18, 0.14, 0.18, 0.1]);

    function onEdge(e, jit, tone, flip) {
      var t = rand();
      var a = e[0], c = e[1];
      b.push(
        a[0] + (c[0] - a[0]) * t + gauss() * jit,
        a[1] + (c[1] - a[1]) * t + gauss() * jit,
        a[2] + (c[2] - a[2]) * t + gauss() * jit,
        flip ? 1 - t : t, tone === undefined ? t : tone
      );
    }

    while (!b.full()) {
      var part = pickPart();
      if (part === 0) onEdge(oe[Math.floor(rand() * 12)], 0.005, 0.0);
      else if (part === 1) onEdge(ie[Math.floor(rand() * 12)], 0.004, 1.0);
      else if (part === 2) onEdge(links[Math.floor(rand() * 8)], 0.004);
      else if (part === 3) {
        // faint grid on the outer faces
        var axis = Math.floor(rand() * 3), sign = rand() < 0.5 ? -1 : 1;
        var u = rand() * 2 - 1, v = rand() * 2 - 1;
        if (rand() < 0.75) {
          var lines = 4;
          if (rand() < 0.5) u = Math.round((u + 1) * lines / 2) / (lines / 2) - 1;
          else v = Math.round((v + 1) * lines / 2) / (lines / 2) - 1;
        }
        var p = [0, 0, 0];
        p[axis] = sign * O;
        p[(axis + 1) % 3] = u * O;
        p[(axis + 2) % 3] = v * O;
        b.push(p[0], p[1], p[2], rand(), 0.3);
      } else {
        // glowing core inside the inner cube
        var gx = gauss() * 0.16, gy = gauss() * 0.16, gz = gauss() * 0.16;
        b.push(gx, gy, gz, rand(), 0.85 + rand() * 0.15);
      }
    }
    return b.done(1.6);
  }

  /* gear — extruded 12-tooth gear with lightening holes (optimizer) */

  function gearProfile(teeth, rr, rt) {
    // polyline (x,z) around the gear outline, then cumulative lengths
    var pts = [], steps = teeth * 64, i;
    for (i = 0; i <= steps; i++) {
      var th = (i / steps) * TAU;
      var f = ((th / TAU) * teeth) % 1;
      var r;
      if (f < 0.12) r = rr + (rt - rr) * (f / 0.12);
      else if (f < 0.4) r = rt;
      else if (f < 0.52) r = rt - (rt - rr) * ((f - 0.4) / 0.12);
      else r = rr;
      pts.push([Math.cos(th) * r, Math.sin(th) * r, th]);
    }
    var cum = [0];
    for (i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    return { pts: pts, cum: cum, len: cum[cum.length - 1] };
  }

  function sampleProfile(pr, out) {
    var d = rand() * pr.len, lo = 0, hi = pr.cum.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (pr.cum[mid] < d) lo = mid; else hi = mid;
    }
    var seg = pr.cum[hi] - pr.cum[lo] || 1;
    var f = (d - pr.cum[lo]) / seg;
    var a = pr.pts[lo], c = pr.pts[hi];
    out[0] = a[0] + (c[0] - a[0]) * f;
    out[1] = a[1] + (c[1] - a[1]) * f;
    out[2] = a[2] + (c[2] - a[2]) * f;
    return out;
  }

  function gear(n) {
    var b = new Builder(n);
    var teeth = 10, rr = 0.98, rt = 1.36, h = 0.16;
    var pr = gearProfile(teeth, rr, rt);
    var holes = [];
    for (var k = 0; k < 5; k++) {
      var ha = (k / 5) * TAU + 0.3;
      holes.push([Math.cos(ha) * 0.64, Math.sin(ha) * 0.64]);
    }
    var holeR = 0.19, bore = 0.24, hub = 0.36;
    // outline, walls, face fill, hole rims, hub, sparks
    var pickPart = picker([0.36, 0.14, 0.2, 0.17, 0.08, 0.05]);
    var out = [0, 0, 0];

    function inHole(x, z) {
      if (x * x + z * z < hub * hub) return true;
      for (var i = 0; i < holes.length; i++) {
        var dx = x - holes[i][0], dz = z - holes[i][1];
        if (dx * dx + dz * dz < holeR * holeR) return true;
      }
      return false;
    }

    while (!b.full()) {
      var part = pickPart();
      var face = rand() < 0.5 ? -h : h;
      if (part === 0) {
        // crisp tooth outline on both faces
        sampleProfile(pr, out);
        b.push(out[0], face + gauss() * 0.003, out[1], out[2] / TAU, rand() * 0.12);
      } else if (part === 1) {
        sampleProfile(pr, out);
        b.push(out[0], (rand() * 2 - 1) * h, out[1], out[2] / TAU, 0.22);
      } else if (part === 2) {
        // face fill with lightening holes cut out
        var th = rand() * TAU;
        var r = Math.sqrt(hub * hub + rand() * (rr * rr - hub * hub));
        var x = Math.cos(th) * r, z = Math.sin(th) * r;
        if (inHole(x, z)) continue;
        b.push(x, face, z, th / TAU, 0.42 + rand() * 0.14);
      } else if (part === 3) {
        // rims of the lightening holes and the hub
        var which = Math.floor(rand() * (holes.length + 1));
        var a = rand() * TAU, cx = 0, cz = 0, rad = hub;
        if (which < holes.length) { cx = holes[which][0]; cz = holes[which][1]; rad = holeR; }
        var y = rand() < 0.75 ? face : (rand() * 2 - 1) * h;
        b.push(cx + Math.cos(a) * rad, y, cz + Math.sin(a) * rad, a / TAU, which < holes.length ? 0.12 : 0.7);
      } else if (part === 4) {
        // raised hub ring around the bore
        var ha2 = rand() * TAU;
        b.push(Math.cos(ha2) * bore, (rand() * 2 - 1) * 0.3, Math.sin(ha2) * bore, ha2 / TAU, 0.9);
      } else {
        // sparks thrown off the tooth tips
        var tooth = Math.floor(rand() * teeth);
        var sa = ((tooth + 0.26) / teeth) * TAU + gauss() * 0.035;
        var sr = rt + 0.05 + Math.pow(rand(), 2.4) * 0.6;
        b.push(Math.cos(sa) * sr, gauss() * 0.04, Math.sin(sa) * sr, sa / TAU, 1.0);
      }
    }
    return b.done(1.6);
  }

  /* grid — a rolling wireframe terrain (terminal) */

  function grid(n) {
    var b = new Builder(n);
    var S = 2.3, step = 0.23, lines = Math.round((2 * S) / step) + 1;
    function height(x, z) {
      return 0.24 * Math.sin(x * 1.35 + 0.6) * Math.cos(z * 1.15) +
        0.12 * Math.sin((x + z) * 2.1) - 0.05 * (x * x + z * z) * 0.25;
    }
    while (!b.full()) {
      if (rand() < 0.08) {
        // floating data motes
        var mx = (rand() * 2 - 1) * S, mz = (rand() * 2 - 1) * S;
        b.push(mx, height(mx, mz) + 0.12 + rand() * 0.9, mz, rand(), 0.9 + rand() * 0.1);
        continue;
      }
      var li = Math.floor(rand() * lines);
      var along = (rand() * 2 - 1) * S;
      var across = -S + li * step;
      var x = rand() < 0.5 ? along : across;
      var z = x === along ? across : along;
      var d = Math.sqrt(x * x + z * z);
      b.push(x, height(x, z), z, d / (S * 1.42), (x + S) / (2 * S));
    }
    return b.done(2.0);
  }

  /* galaxy — two-armed logarithmic spiral around a round bulge (contact) */

  function galaxy(n) {
    var b = new Builder(n);
    var Rmax = 2.2, r0 = 0.32;
    var wind = 1 / Math.tan((17 * Math.PI) / 180); // pitch angle ~17°
    while (!b.full()) {
      var roll = rand();
      if (roll < 0.22) {
        // round bulge
        var s = 0.19 * (rand() < 0.7 ? 1 : 1.8);
        b.push(gauss() * s, gauss() * s * 0.7, gauss() * s, rand() * 0.12, 0.88 + rand() * 0.12);
      } else if (roll < 0.78) {
        // spiral arms, widening with radius
        var r = r0 + Math.pow(rand(), 1.15) * (Rmax - r0);
        var arm = rand() < 0.5 ? 0 : Math.PI;
        var spread = 0.07 + 0.2 * (r / Rmax);
        var ang = arm + wind * Math.log(r / r0) + gauss() * spread;
        var rr = r * (1 + gauss() * 0.05);
        b.push(Math.cos(ang) * rr, gauss() * 0.05 * (1.2 - r / Rmax), Math.sin(ang) * rr,
          r / Rmax, clamp01(1 - r / Rmax + gauss() * 0.08));
      } else if (roll < 0.94) {
        // faint disk between the arms
        var dr = r0 + Math.sqrt(rand()) * (Rmax - r0);
        var da = rand() * TAU;
        b.push(Math.cos(da) * dr, gauss() * 0.04, Math.sin(da) * dr, dr / Rmax, clamp01(0.7 - dr / Rmax));
      } else {
        // sparse halo
        var hx = gauss(), hy = gauss() * 0.4, hz = gauss();
        var hl = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
        var hr = 0.5 + rand() * 1.9;
        b.push((hx / hl) * hr, (hy / hl) * hr * 0.5, (hz / hl) * hr, rand(), rand() * 0.5);
      }
    }
    return b.done(2.05);
  }

  /* text — rasterise a string on a 2D canvas and sample its pixels */

  function wrapText(str, maxChars) {
    var words = String(str).trim().split(/\s+/), lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      while (w.length > maxChars) {
        if (line) { lines.push(line); line = ''; }
        lines.push(w.slice(0, maxChars));
        w = w.slice(maxChars);
      }
      if (!line) line = w;
      else if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    return lines.slice(0, 3);
  }

  function text(n, str, opts) {
    opts = opts || {};
    var lines = wrapText(str || ' ', opts.maxChars || 11);
    var W = 1400, lineH = 250, H = lineH * lines.length + 60;
    var cv = global.document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    var ctx = cv.getContext('2d');
    var family = opts.font || '"Space Grotesk", "Segoe UI", system-ui, sans-serif';
    var size = 220;
    ctx.font = '700 ' + size + 'px ' + family;
    var widest = 0;
    lines.forEach(function (l) { widest = Math.max(widest, ctx.measureText(l).width); });
    if (widest > W * 0.94) size = Math.floor(size * (W * 0.94) / widest);
    ctx.font = '700 ' + size + 'px ' + family;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach(function (l, i) {
      ctx.fillText(l, W / 2, 30 + lineH * (i + 0.5));
    });

    var data = ctx.getImageData(0, 0, W, H).data;
    var fill = [], edge = [], x, y, minX = W, maxX = 0, minY = H, maxY = 0;
    function on(px, py) {
      return px >= 0 && py >= 0 && px < W && py < H && data[(py * W + px) * 4 + 3] > 127;
    }
    for (y = 0; y < H; y += 2) {
      for (x = 0; x < W; x += 2) {
        if (!on(x, y)) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (!on(x - 3, y) || !on(x + 3, y) || !on(x, y - 3) || !on(x, y + 3)) edge.push(x, y);
        else fill.push(x, y);
      }
    }
    if (!fill.length && !edge.length) return orb(n);

    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    var span = Math.max(maxX - minX, (maxY - minY) * 1.6, 1);
    var scale = 3.5 / span;
    var b = new Builder(n);
    while (!b.full()) {
      var src = edge.length && (rand() < 0.42 || !fill.length) ? edge : fill;
      var k = Math.floor(rand() * (src.length / 2)) * 2;
      var px = src[k] + rand() * 2, py = src[k + 1] + rand() * 2;
      var u = (px - minX) / Math.max(1, maxX - minX);
      b.push((px - cx) * scale, -(py - cy) * scale, gauss() * 0.035, u, u * 0.9 + rand() * 0.1);
    }
    return b.done(0);
  }

  /* ---------------------------------------------------------------- */
  /* Registry: generator + palette + how the engine should present it.  */

  function hex(h) {
    var v = parseInt(h.replace('#', ''), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }

  ERH.Shapes = {
    scatter: { gen: scatter, colors: [hex('#6d28d9'), hex('#22d3ee')], tiltX: 0.2, spin: 0.05, noise: 0.18, size: 1.0 },
    orb: { gen: orb, label: 'orb', colors: [hex('#8b5cf6'), hex('#22d3ee')], tiltX: 0.18, spin: 0.09, noise: 0.075, size: 1.0, scale: 1.02 },
    knot: { gen: knot, label: 'torus knot', colors: [hex('#6366f1'), hex('#f472b6')], tiltX: 0.62, spin: 0.16, noise: 0.05, size: 1.0 },
    graph: { gen: graph, label: 'node graph', colors: [hex('#a78bfa'), hex('#38bdf8')], tiltX: 0.06, spin: 0, sway: 0.3, faceFront: true, noise: 0.022, size: 0.9, scale: 0.8 },
    cube: { gen: cube, label: 'package', colors: [hex('#22d3ee'), hex('#c084fc')], tiltX: 0.52, spin: 0.2, noise: 0.03, size: 0.95 },
    gear: { gen: gear, label: 'gear', colors: [hex('#fb7185'), hex('#fbbf24')], tiltX: 1.18, spin: 0.3, noise: 0.025, size: 0.95, scale: 0.9 },
    grid: { gen: grid, label: 'terrain', colors: [hex('#34d399'), hex('#22d3ee')], tiltX: 0.42, spin: 0.045, noise: 0.06, size: 0.95, scale: 1.12 },
    galaxy: { gen: galaxy, label: 'galaxy', colors: [hex('#60a5fa'), hex('#f5b8f9')], tiltX: 1.02, spin: 0.07, noise: 0.045, size: 0.9, scale: 1.08 },
    text: { gen: text, label: 'text', colors: [hex('#a78bfa'), hex('#22d3ee')], tiltX: 0.0, spin: 0, sway: 0.22, faceFront: true, noise: 0.03, size: 0.9 }
  };

  ERH.Shapes.names = ['orb', 'knot', 'graph', 'cube', 'gear', 'grid', 'galaxy'];
  ERH.Shapes.hex = hex;
})(window);
