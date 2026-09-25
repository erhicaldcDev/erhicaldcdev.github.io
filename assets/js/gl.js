/*
 * gl.js — shaders and WebGL helpers for the site background renderer.
 *
 * Pipeline per frame:
 *   1. nebula      fbm/domain-warped gas, rendered at quarter resolution
 *   2. scene       nebula upscaled + GPU particles (additive point sprites)
 *   3. bloom       bright-pass + separable gaussian blur at quarter resolution
 *   4. composite   chromatic aberration, bloom, starfield, vignette, grain
 *
 * Particles morph between procedural shapes (see shapes.js). Two position
 * buffers hold the "from" and "to" shapes; a per-particle staggered ease
 * blends them in the vertex shader, and the buffers swap roles when a morph
 * completes, so any morph can start from any finished state without a CPU
 * snapshot. Works on WebGL 1 and 2; falls back to direct rendering when
 * framebuffers are unavailable.
 */
(function (global) {
  'use strict';

  var ERH = (global.ERH = global.ERH || {});

  /* ------------------------------------------------------------------ */
  /* Shaders                                                             */
  /* ------------------------------------------------------------------ */

  var PRECISION =
    '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

  // "Hash without Sine" — Dave Hoskins (MIT). Stable across GPUs, no sin().
  var HASH =
    'float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}\n' +
    'vec3 hash33(vec3 p3){p3=fract(p3*vec3(.1031,.1030,.0973));p3+=dot(p3,p3.yxz+33.33);return fract((p3.xxy+p3.yxx)*p3.zyx)*2.0-1.0;}\n';

  var TRI_VS = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  var PARTICLE_VS = [
    'precision highp float;',
    'attribute vec3 aPosA;',
    'attribute vec3 aPosB;',
    'attribute vec2 aTagA;',
    'attribute vec2 aTagB;',
    'attribute vec4 aSeed;',
    'uniform mat4 uProj;',
    'uniform mat4 uModelView;',
    'uniform float uTime;',
    'uniform float uMorph;',
    'uniform float uStagger;',
    'uniform float uNoiseAmp;',
    'uniform float uTurb;',
    'uniform float uScale;',
    'uniform vec2 uShift;',
    'uniform vec2 uMouse;',
    'uniform float uMouseStrength;',
    'uniform float uAspect;',
    'uniform vec4 uPulse;',
    'uniform float uSize;',
    'uniform float uViewH;',
    'uniform float uMaxPoint;',
    'uniform vec3 uColA1;',
    'uniform vec3 uColA2;',
    'uniform vec3 uColB1;',
    'uniform vec3 uColB2;',
    'uniform float uHyper;',
    'uniform float uIntensity;',
    'varying vec3 vColor;',
    'varying float vSize;',
    HASH,
    'float gnoise(vec3 p){',
    '  vec3 i = floor(p); vec3 f = fract(p);',
    '  vec3 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(mix(dot(hash33(i), f),',
    '                     dot(hash33(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0)), u.x),',
    '                 mix(dot(hash33(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0)),',
    '                     dot(hash33(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0)), u.x), u.y),',
    '             mix(mix(dot(hash33(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0)),',
    '                     dot(hash33(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0)), u.x),',
    '                 mix(dot(hash33(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0)),',
    '                     dot(hash33(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0)), u.x), u.y), u.z);',
    '}',
    'float ease(float t){ return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) * 0.5; }',
    'void main(){',
    '  float delay = aSeed.x * uStagger;',
    '  float t = clamp((uMorph - delay) / (1.0 - uStagger), 0.0, 1.0);',
    '  float e = ease(t);',
    '  float flight = sin(3.14159265 * t);',
    '  vec3 pos = mix(aPosA, aPosB, e);',
    '  float path = mix(aTagA.x, aTagB.x, step(0.5, e));',
    '  float tone = mix(aTagA.y, aTagB.y, e);',
    // swirl while in flight
    '  float ang = flight * (aSeed.w - 0.5) * 2.4;',
    '  float ca = cos(ang), sa = sin(ang);',
    '  pos.xz = mat2(ca, sa, -sa, ca) * pos.xz;',
    // organic drift
    '  vec3 np = pos * 1.35 + vec3(0.0, uTime * 0.11, uTime * 0.07) + aSeed.w * 0.35;',
    '  vec3 disp = vec3(gnoise(np), gnoise(np + vec3(31.4, 17.1, 9.2)), gnoise(np + vec3(-11.3, 47.9, 23.7)));',
    '  pos += disp * (uNoiseAmp + uTurb + flight * 0.55);',
    '  pos *= uScale;',
    '  vec4 view = uModelView * vec4(pos, 1.0);',
    '  vec4 clip = uProj * view;',
    '  clip.xy += uShift * clip.w;',
    // pointer repulsion in screen space
    '  vec2 ndc = clip.xy / clip.w;',
    '  vec2 dm = (ndc - uMouse) * vec2(uAspect, 1.0);',
    '  float dist = length(dm);',
    '  float push = smoothstep(0.34, 0.0, dist) * uMouseStrength;',
    '  vec2 off = (dist > 1e-4 ? dm / dist : vec2(0.0)) * push * 0.11;',
    // click shockwave ring
    '  float age = max(uTime - uPulse.z, 0.0);',
    '  vec2 dp = (ndc - uPulse.xy) * vec2(uAspect, 1.0);',
    '  float pd = length(dp);',
    '  float band = exp(-pow((pd - age * 1.25) * 7.0, 2.0)) * uPulse.w * exp(-age * 1.6);',
    '  off += (pd > 1e-4 ? dp / pd : vec2(0.0)) * band * 0.075;',
    '  off.x /= uAspect;',
    '  clip.xy += off * clip.w;',
    '  gl_Position = clip;',
    // size with perspective
    '  float s = uSize * (0.35 + aSeed.z * aSeed.z * 1.65);',
    '  s *= (uViewH / 900.0) * (6.0 / max(-view.z, 0.5)) * uScale;',
    '  s *= 1.0 + band * 1.6 + push * 0.5 + flight * 0.4;',
    '  gl_PointSize = clamp(s, 1.0, uMaxPoint);',
    '  vSize = gl_PointSize;',
    // colour
    '  vec3 ca1 = mix(uColA1, uColA2, tone);',
    '  vec3 cb1 = mix(uColB1, uColB2, tone);',
    '  vec3 col = mix(ca1, cb1, e);',
    '  float spark = step(0.965, fract(aSeed.y * 13.37));',
    '  col = mix(col, vec3(1.0, 0.96, 1.0), spark * 0.75);',
    '  float pulseL = pow(0.5 + 0.5 * sin(path * 34.0 - uTime * 2.4), 10.0);',
    '  vec3 rainbow = 0.55 + 0.45 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + path * 0.8 + uTime * 0.18 + aSeed.y * 0.3));',
    '  col = mix(col, rainbow, uHyper);',
    '  float twinkle = 0.72 + 0.28 * sin(uTime * (0.8 + aSeed.w * 2.2) + aSeed.y * 40.0);',
    '  float depth = smoothstep(11.0, 3.0, -view.z);',
    '  float glow = twinkle * (0.75 + pulseL * 1.25) * (1.0 + band * 2.5 + push * 1.2) * (1.0 + spark * 0.6);',
    // point sizes clamp at 1px, so fade sub-pixel particles instead of shrinking them
    '  float cover = clamp(s * s, 0.12, 1.0);',
    '  vColor = col * glow * depth * uIntensity * cover;',
    '}'
  ].join('\n');

  // Gaussian falloff measured in pixels, so 2px sprites keep their energy
  // instead of vanishing between pixel centres.
  var PARTICLE_FS = [
    'precision mediump float;',
    'varying vec3 vColor;',
    'varying float vSize;',
    'void main(){',
    '  float d = length(gl_PointCoord - 0.5) * vSize;',
    '  float sigma = max(0.62, vSize * 0.2);',
    '  float a = exp(-d * d / (2.0 * sigma * sigma));',
    '  gl_FragColor = vec4(vColor * a, 1.0);',
    '}'
  ].join('\n');

  var NEBULA_FS = [
    PRECISION,
    'varying vec2 vUv;',
    'uniform vec2 uRes;',
    'uniform float uTime;',
    'uniform float uScroll;',
    'uniform vec2 uMouse;',
    'uniform vec3 uC1;',
    'uniform vec3 uC2;',
    'uniform vec3 uC3;',
    HASH,
    'float vnoise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),',
    '             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    'float fbm(vec2 p){',
    '  float v = 0.0, a = 0.5;',
    '  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);',
    '  for (int i = 0; i < 5; i++){ v += a * vnoise(p); p = m * p + 7.31; a *= 0.5; }',
    '  return v;',
    '}',
    'void main(){',
    '  vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);',
    '  p += uMouse * 0.035;',
    '  p.y -= uScroll * 0.32;',
    '  float t = uTime * 0.025;',
    '  vec2 q = vec2(fbm(p * 1.3 + vec2(0.0, t)), fbm(p * 1.3 + vec2(5.2, -t)));',
    '  vec2 r = vec2(fbm(p * 1.1 + q * 2.0 + vec2(1.7, 9.2) + t * 0.6), fbm(p * 1.1 + q * 2.0 + vec2(8.3, 2.8) - t * 0.4));',
    '  float n = fbm(p * 1.25 + r * 1.7);',
    '  vec3 col = mix(uC1, uC2, clamp(n * n * 2.1, 0.0, 1.0));',
    '  col = mix(col, uC3, clamp(length(q) * r.x * 0.9, 0.0, 1.0));',
    '  col *= smoothstep(0.22, 0.95, n) * 1.1 + 0.08;',
    '  col *= 1.0 - 0.5 * smoothstep(0.25, 1.15, length(p));',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var COPY_FS = [
    PRECISION,
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec3 uBase;',
    'void main(){ gl_FragColor = vec4(texture2D(uTex, vUv).rgb + uBase, 1.0); }'
  ].join('\n');

  var BRIGHT_FS = [
    PRECISION,
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2 uTexel;',
    'uniform float uThreshold;',
    'void main(){',
    '  vec3 c = texture2D(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb;',
    '  c += texture2D(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb;',
    '  c += texture2D(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb;',
    '  c += texture2D(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;',
    '  c *= 0.25;',
    '  float l = max(c.r, max(c.g, c.b));',
    '  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.4, l), 1.0);',
    '}'
  ].join('\n');

  var BLUR_FS = [
    PRECISION,
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2 uDir;',
    'void main(){',
    '  vec3 c = texture2D(uTex, vUv).rgb * 0.2270270270;',
    '  c += texture2D(uTex, vUv + uDir * 1.3846153846).rgb * 0.3162162162;',
    '  c += texture2D(uTex, vUv - uDir * 1.3846153846).rgb * 0.3162162162;',
    '  c += texture2D(uTex, vUv + uDir * 3.2307692308).rgb * 0.0702702703;',
    '  c += texture2D(uTex, vUv - uDir * 3.2307692308).rgb * 0.0702702703;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  var COMPOSITE_FS = [
    PRECISION,
    'varying vec2 vUv;',
    'uniform sampler2D uScene;',
    'uniform sampler2D uBloom;',
    'uniform float uBloomStrength;',
    'uniform float uTime;',
    'uniform float uFade;',
    'uniform float uScrollPx;',
    'uniform float uDpr;',
    'uniform float uAspect;',
    HASH,
    'void main(){',
    '  vec2 uv = vUv;',
    '  vec2 dc = uv - 0.5;',
    '  float r2 = dot(dc, dc);',
    '  vec2 off = dc * r2 * 0.022;',
    '  vec3 col = vec3(texture2D(uScene, uv + off).r, texture2D(uScene, uv).g, texture2D(uScene, uv - off).b);',
    '  col += texture2D(uBloom, uv).rgb * uBloomStrength;',
    // starfield with a little scroll parallax
    '  float cell = 3.0 * uDpr;',
    '  vec2 sp = (gl_FragCoord.xy + vec2(0.0, uScrollPx * 0.06 * uDpr)) / cell;',
    '  vec2 id = floor(sp);',
    '  float h = hash12(id);',
    '  if (h > 0.9965) {',
    '    float d = length(fract(sp) - 0.5);',
    '    float tw = 0.55 + 0.45 * sin(uTime * (0.7 + h * 3.0) + h * 91.0);',
    '    col += vec3(0.8, 0.85, 1.0) * smoothstep(0.5, 0.0, d) * tw * (0.35 + (h - 0.9965) * 180.0);',
    '  }',
    '  vec2 vd = dc * vec2(uAspect > 1.0 ? 1.0 : 0.8, 1.0);',
    '  col *= mix(0.5, 1.0, smoothstep(0.85, 0.2, length(vd)));',
    '  col += (hash12(gl_FragCoord.xy + fract(uTime * 7.0) * 317.0) - 0.5) * 0.03;',
    '  gl_FragColor = vec4(col * uFade, 1.0);',
    '}'
  ].join('\n');

  // Used only when framebuffers are unavailable: nebula + particles straight to screen.
  var NEBULA_DIRECT_FS = NEBULA_FS.replace(
    'gl_FragColor = vec4(col, 1.0);',
    'gl_FragColor = vec4(col + vec3(0.016, 0.02, 0.047), 1.0);'
  );

  /* ------------------------------------------------------------------ */
  /* GL helpers                                                          */
  /* ------------------------------------------------------------------ */

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      var log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('Shader compile failed: ' + log);
    }
    return s;
  }

  function program(gl, vsSrc, fsSrc, attribs) {
    var p = gl.createProgram();
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    attribs.forEach(function (name, i) { gl.bindAttribLocation(p, i, name); });
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    var u = {};
    var count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < count; i++) {
      var info = gl.getActiveUniform(p, i);
      var name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, info.name);
    }
    return { id: p, u: u, attribs: attribs.length };
  }

  function target(gl, w, h) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex: tex, fb: fb, w: w, h: h, ok: ok };
  }

  function freeTarget(gl, t) {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
  }

  /* column-major mat4 */
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0
    ]);
  }

  // view = translate(0,0,-dist) * Rx(ax) * Ry(ay)
  function modelView(ax, ay, dist, out) {
    var cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
    out[0] = cy; out[1] = sx * sy; out[2] = -cx * sy; out[3] = 0;
    out[4] = 0; out[5] = cx; out[6] = sx; out[7] = 0;
    out[8] = sy; out[9] = -sx * cy; out[10] = cx * cy; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = -dist; out[15] = 1;
    return out;
  }

  function damp(a, b, lambda, dt) {
    return a + (b - a) * (1 - Math.exp(-lambda * dt));
  }

  function mix3(out, a, b, t) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
  }

  ERH._gl = {
    shaders: {
      TRI_VS: TRI_VS, PARTICLE_VS: PARTICLE_VS, PARTICLE_FS: PARTICLE_FS,
      NEBULA_FS: NEBULA_FS, NEBULA_DIRECT_FS: NEBULA_DIRECT_FS, COPY_FS: COPY_FS,
      BRIGHT_FS: BRIGHT_FS, BLUR_FS: BLUR_FS, COMPOSITE_FS: COMPOSITE_FS
    },
    program: program,
    target: target,
    freeTarget: freeTarget,
    perspective: perspective,
    modelView: modelView,
    damp: damp,
    mix3: mix3
  };
})(window);
