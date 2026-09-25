/*
 * terminal.js — "ersh", a tiny shell that runs in the page and can drive
 * the particle engine. Everything is printed through textContent, so user
 * input is never interpreted as HTML.
 */
(function (global) {
  'use strict';

  var ERH = (global.ERH = global.ERH || {});
  var doc = global.document;

  var GITHUB = 'https://github.com/erhicaldcDev';
  var DISCORD = 'azerbejdzanki';

  var PROJECTS = {
    botify: {
      name: 'Botify', url: GITHUB + '/Botify', status: 'in progress',
      desc: 'Electron desktop app for building Discord bots. Wire logic together in a node-based graph editor (Blueprint Visual Scripting) or write it in the integrated Monaco IDE; generates code for JS, Python and Lua.'
    },
    nxpm: {
      name: 'nxpm', url: GITHUB + '/nxpm', status: 'C11',
      desc: 'NexaPackageManager: a minimalist, source-based package manager in C11 for Linux From Scratch. Fetches, resolves dependencies recursively, builds into a staging root and deploys atomically.'
    },
    fgo: {
      name: 'fckingGoodOptimizer', url: GITHUB + '/fckingGoodOptimizer', status: 'discontinued',
      desc: 'Windows 10/11 optimization toolbox on .NET 6: performance, gaming and network tweaks via system and registry changes. No longer maintained.'
    }
  };
  var PROJECT_ALIAS = { fckinggoodoptimizer: 'fgo', optimizer: 'fgo', bot: 'botify' };

  var SECTIONS = ['top', 'about', 'projects', 'botify', 'nxpm', 'fgo', 'terminal', 'contact'];

  var FILES = {
    'about.txt': function () {
      return [
        "erhicaldc: software developer and systems enthusiast.",
        'I build tools that sit close to the operating system (a source-based',
        'package manager for Linux From Scratch, a Windows optimization toolbox)',
        'and desktop apps that make complex things approachable, like a visual',
        'bot builder for Discord.'
      ];
    },
    'contact.txt': function () {
      return ['discord  ' + DISCORD, 'github   ' + GITHUB];
    },
    'botify.md': function () { return [PROJECTS.botify.desc]; },
    'nxpm.md': function () { return [PROJECTS.nxpm.desc]; },
    'fgo.md': function () { return [PROJECTS.fgo.desc]; }
  };

  var LOGO = [
    '        _.-----._        ',
    "      .'  .-.    '.      ",
    '     /   (   )     \\     ',
    " ===|=====`-'=======|=== ",
    '     \\             /     ',
    "      '._       _.'      ",
    "         '-----'         "
  ];

  function sleep(ms) {
    return new Promise(function (resolve) { global.setTimeout(resolve, ms); });
  }

  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function prng(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function levenshtein(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) d[i] = [i];
    for (j = 0; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) {
      for (j = 1; j <= n; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[m][n];
  }

  function pad(s, n) {
    s = String(s);
    return s.length >= n ? s + ' ' : s + new Array(n - s.length + 1).join(' ');
  }

  function create(root, opts) {
    opts = opts || {};
    var scene = opts.scene || null;
    var reduced = !!opts.reducedMotion;
    var body = root.querySelector('[data-term-body]');
    var out = root.querySelector('[data-term-out]');
    var form = root.querySelector('[data-term-form]');
    var input = root.querySelector('[data-term-input]');
    var history = [];
    var hIndex = -1;
    var busy = false;
    var cancelled = false;
    var jobId = 0;
    var booted = false;
    var startedAt = Date.now();

    /* ---------------- output ---------------- */

    function scrollDown() {
      body.scrollTop = body.scrollHeight;
    }

    function seg(s) {
      if (s == null) return doc.createTextNode('');
      if (typeof s === 'string') return doc.createTextNode(s);
      var el;
      if (s.href) {
        el = doc.createElement('a');
        el.href = s.href;
        if (/^https?:/.test(s.href)) {
          el.target = '_blank';
          el.rel = 'noopener noreferrer';
        }
      } else {
        el = doc.createElement('span');
      }
      if (s.c) el.className = s.c;
      el.textContent = s.t;
      return el;
    }

    function print(parts, cls) {
      var row = doc.createElement('div');
      row.className = 't-row' + (cls ? ' ' + cls : '');
      (Array.isArray(parts) ? parts : [parts]).forEach(function (p) { row.appendChild(seg(p)); });
      out.appendChild(row);
      // keep the DOM bounded
      while (out.childNodes.length > 400) out.removeChild(out.firstChild);
      scrollDown();
      return row;
    }

    function printLines(lines, cls) {
      lines.forEach(function (l) { print(l, cls); });
    }

    function promptParts(cmd) {
      return [
        { t: 'guest@erhicaldc', c: 't-user' }, { t: ':', c: 't-dim' },
        { t: '~', c: 't-path' }, { t: '$ ', c: 't-dim' }, cmd
      ];
    }

    function err(msg) { print({ t: msg, c: 't-err' }); }
    function dim(msg) { print({ t: msg, c: 't-dim' }); }
    function ok(msg) { print({ t: msg, c: 't-ok' }); }

    /* ---------------- commands ---------------- */

    var COMMANDS = {};

    function def(name, args, desc, fn, hidden) {
      COMMANDS[name] = { name: name, args: args, desc: desc, run: fn, hidden: !!hidden };
    }

    def('help', '', 'show this list', function () {
      print({ t: 'ersh commands', c: 't-accent' });
      Object.keys(COMMANDS).forEach(function (k) {
        var c = COMMANDS[k];
        if (c.hidden) return;
        print([{ t: '  ' + pad(c.name + (c.args ? ' ' + c.args : ''), 22), c: 't-cmd' }, { t: c.desc, c: 't-dim' }]);
      });
      dim('Tab completes · ↑/↓ history · Ctrl+C cancels · Ctrl+L clears');
    });

    def('about', '', 'who is erhicaldc', function () {
      printLines(FILES['about.txt']());
      print([{ t: 'more: ', c: 't-dim' }, { t: 'projects', c: 't-cmd' }, { t: ', ', c: 't-dim' }, { t: 'contact', c: 't-cmd' }]);
    });

    def('projects', '', 'list projects', function () {
      Object.keys(PROJECTS).forEach(function (k) {
        var p = PROJECTS[k];
        print([
          { t: pad(p.name, 21), c: 't-accent' },
          { t: pad('[' + p.status + ']', 16), c: p.status === 'discontinued' ? 't-warn' : 't-ok' },
          { t: p.url.replace('https://', ''), href: p.url }
        ]);
      });
      dim("open one with: open botify | open nxpm | open fgo");
    });

    def('ls', '[-la]', 'list files', function (args) {
      if (args[0] && /l/.test(args[0])) {
        printLines([
          [{ t: 'drwxr-xr-x  guest  ', c: 't-dim' }, { t: 'botify/', c: 't-path' }],
          [{ t: 'drwxr-xr-x  guest  ', c: 't-dim' }, { t: 'nxpm/', c: 't-path' }],
          [{ t: 'drwxr-x---  guest  ', c: 't-dim' }, { t: 'fckingGoodOptimizer/', c: 't-path' }, { t: '  (archived)', c: 't-warn' }],
          [{ t: '-rw-r--r--  guest  ', c: 't-dim' }, 'about.txt'],
          [{ t: '-rw-r--r--  guest  ', c: 't-dim' }, 'contact.txt']
        ]);
        return;
      }
      print([
        { t: 'botify/  nxpm/  fckingGoodOptimizer/  ', c: 't-path' },
        'about.txt  contact.txt  botify.md  nxpm.md  fgo.md'
      ]);
    });

    def('cat', '<file>', 'print a file', function (args) {
      var f = (args[0] || '').replace(/^\.\//, '');
      if (!f) return err('cat: missing file operand (try: cat about.txt)');
      if (FILES[f]) return printLines(FILES[f]());
      if (/\/$/.test(f) || PROJECTS[f] || PROJECT_ALIAS[f.toLowerCase()]) return err('cat: ' + f + ': Is a directory');
      err('cat: ' + f + ': No such file');
    });

    def('cd', '<dir>', 'change directory', function () {
      dim('cd: this shell is flat. try `ls`, or `open <project>` to leave for GitHub.');
    }, true);

    def('open', '<project>', 'open a project on GitHub', function (args) {
      var key = (args[0] || '').toLowerCase().replace(/\/$/, '');
      key = PROJECT_ALIAS[key] || key;
      var url = key === 'github' ? GITHUB : PROJECTS[key] && PROJECTS[key].url;
      if (!url) return err('open: unknown project "' + (args[0] || '') + '" (botify, nxpm, fgo, github)');
      print([{ t: 'opening ', c: 't-dim' }, { t: url, href: url }]);
      try { global.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { /* the link above still works */ }
    });

    def('github', '', 'open my GitHub profile', function () {
      COMMANDS.open.run(['github']);
    });

    def('contact', '', 'how to reach me', function () {
      print([{ t: 'discord  ', c: 't-dim' }, { t: DISCORD, c: 't-accent' }]);
      print([{ t: 'github   ', c: 't-dim' }, { t: GITHUB.replace('https://', ''), href: GITHUB }]);
      print([{ t: 'Need custom software or have a project idea? Message me on Discord.', c: 't-dim' }]);
    });

    def('shape', '[name]', 'morph the particles', function (args) {
      if (!scene) return err('shape: WebGL is not available in this browser');
      var names = scene.shapes;
      var want = (args[0] || '').toLowerCase();
      if (!want) {
        print([{ t: 'shapes: ', c: 't-dim' }, { t: names.join('  '), c: 't-cmd' }]);
        print([{ t: 'current: ', c: 't-dim' }, { t: scene.current().label, c: 't-accent' }]);
        return;
      }
      if (want === 'random') {
        var pool = names.filter(function (n) { return n !== scene.current().name; });
        want = pool[Math.floor(Math.random() * pool.length)];
      }
      if (names.indexOf(want) < 0) return err('shape: unknown shape "' + want + '". try: ' + names.join(', '));
      scene.morphTo(want);
      print([{ t: 'morphing → ', c: 't-dim' }, { t: want, c: 't-accent' }, { t: '  (' + scene.info().count.toLocaleString('en-US') + ' particles)', c: 't-dim' }]);
    });

    def('text', '<message>', 'spell a message in particles', function (args) {
      if (!scene) return err('text: WebGL is not available in this browser');
      var msg = args.join(' ').trim();
      if (!msg) return err('text: usage: text <message>');
      if (msg.length > 24) {
        msg = msg.slice(0, 24);
        dim('(trimmed to 24 characters)');
      }
      scene.morphTo({ text: msg });
      print([{ t: 'spelling ', c: 't-dim' }, { t: '"' + msg + '"', c: 't-accent' }, { t: ' with particles', c: 't-dim' }]);
    });

    def('hyper', '', 'toggle hyper mode', function () {
      if (!scene) return err('hyper: WebGL is not available in this browser');
      var on = scene.toggleHyper();
      print([{ t: 'hyper mode ', c: 't-dim' }, { t: on ? 'ENGAGED' : 'off', c: on ? 't-warn' : 't-dim' }]);
      if (opts.onHyper) opts.onHyper(on);
    });

    def('particles', '[count]', 'show or set the particle count', function (args) {
      if (!scene) return err('particles: WebGL is not available in this browser');
      var info = scene.info();
      if (!args[0]) {
        print([{ t: info.count.toLocaleString('en-US'), c: 't-accent' }, { t: ' of ' + info.max.toLocaleString('en-US') + ' particles in use', c: 't-dim' }]);
        return;
      }
      var n = parseInt(String(args[0]).replace(/[_,k]/gi, function (m) { return /k/i.test(m) ? '000' : ''; }), 10);
      if (!isFinite(n)) return err('particles: expected a number');
      var set = scene.setCount(n);
      print([{ t: 'particles → ', c: 't-dim' }, { t: set.toLocaleString('en-US'), c: 't-accent' }]);
    });

    def('nxpm', 'install <pkg>', 'simulated nxpm install (demo)', function (args) {
      if (args[0] !== 'install' || !args[1]) {
        print('usage: nxpm install <package>');
        dim('(a playful simulation of the real thing: ' + PROJECTS.nxpm.url.replace('https://', '') + ')');
        return;
      }
      return nxpmInstall(args.slice(1, 4));
    });

    def('neofetch', '', 'system information', neofetch);

    def('goto', '<section>', 'scroll to a section', function (args) {
      var id = (args[0] || '').toLowerCase().replace(/^#/, '');
      if (id === 'home') id = 'top';
      if (SECTIONS.indexOf(id) < 0) return err('goto: unknown section. try: ' + SECTIONS.join(', '));
      var el = doc.getElementById(id);
      if (el) el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      print([{ t: 'jumping to ', c: 't-dim' }, { t: '#' + id, c: 't-path' }]);
    });

    def('hud', '', 'toggle the performance HUD', function () {
      var on = opts.onHud ? opts.onHud() : false;
      print([{ t: 'hud ', c: 't-dim' }, { t: on ? 'on' : 'off', c: 't-accent' }]);
    });

    def('history', '', 'show command history', function () {
      history.slice().reverse().forEach(function (h, i) {
        print([{ t: pad(i + 1, 5), c: 't-dim' }, h]);
      });
    });

    def('clear', '', 'clear the screen', function () { out.textContent = ''; });

    def('date', '', 'print the date', function () { print(new Date().toString()); }, true);
    def('echo', '<text>', 'print text', function (args) { print(args.join(' ')); }, true);
    def('whoami', '', 'print the current user', function () {
      print([{ t: 'guest', c: 't-accent' }, { t: "  (you could be a client, too — try 'contact')", c: 't-dim' }]);
    }, true);
    def('sudo', '', '', function () {
      err('guest is not in the sudoers file. This incident will be reported.');
    }, true);
    def('rm', '', '', function (args) {
      if (args.join(' ').indexOf('-rf') >= 0) err("rm: refusing to remove '/': the particles live there");
      else err('rm: permission denied');
    }, true);
    def('exit', '', '', function () {
      dim('logout');
      dim('…just kidding. there is no escape. (scrolling works, though)');
    }, true);

    /* ---------------- neofetch ---------------- */

    function neofetch() {
      var info = scene ? scene.info() : null;
      var up = Math.floor((Date.now() - startedAt) / 1000);
      var kernel = scene ? 'WebGL ' + info.webgl + (info.post ? ' · bloom pipeline' : ' · direct') : 'no WebGL (CSS fallback)';
      var gpu = scene ? scene.renderer().replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/,?\s*D3D1\d.*$/i, '').slice(0, 60) : 'n/a';
      var lines = [
        [{ t: 'guest', c: 't-user' }, { t: '@', c: 't-dim' }, { t: 'erhicaldc', c: 't-user' }],
        [{ t: '---------------', c: 't-dim' }],
        ['OS', 'erhicaldcOS (browser edition)'],
        ['Host', global.location.host || 'erhicaldcdev.github.io'],
        ['Kernel', kernel],
        ['GPU', gpu],
        ['Shell', 'ersh 1.0'],
        ['Uptime', Math.floor(up / 60) + 'm ' + (up % 60) + 's'],
        ['Display', global.innerWidth + '×' + global.innerHeight + ' @' + (Math.round((global.devicePixelRatio || 1) * 100) / 100) + 'x'],
        ['Particles', scene ? info.count.toLocaleString('en-US') + ' · ' + scene.current().label : 'n/a'],
        ['Stack', 'C · C# · JavaScript · Python · Lua'],
        ['Projects', 'Botify · nxpm · fckingGoodOptimizer']
      ];
      var wrap = doc.createElement('div');
      wrap.className = 't-row t-fetch';
      var logo = doc.createElement('pre');
      logo.className = 't-logo';
      logo.setAttribute('aria-hidden', 'true');
      logo.textContent = LOGO.join('\n');
      var info2 = doc.createElement('div');
      info2.className = 't-fetch__info';
      lines.forEach(function (l) {
        var row = doc.createElement('div');
        if (typeof l[0] === 'string') {
          row.appendChild(seg({ t: pad(l[0], 10), c: 't-accent' }));
          row.appendChild(seg(l[1]));
        } else {
          l.forEach(function (s) { row.appendChild(seg(s)); });
        }
        info2.appendChild(row);
      });
      var sw = doc.createElement('div');
      sw.className = 't-swatches';
      sw.setAttribute('aria-hidden', 'true');
      ['#8b5cf6', '#6366f1', '#22d3ee', '#34d399', '#fbbf24', '#fb7185', '#f472b6', '#e2e8f0'].forEach(function (c) {
        var i = doc.createElement('i');
        i.style.background = c;
        sw.appendChild(i);
      });
      info2.appendChild(sw);
      wrap.appendChild(logo);
      wrap.appendChild(info2);
      out.appendChild(wrap);
      scrollDown();
    }

    /* ---------------- nxpm install (simulated) ---------------- */

    var DEP_POOL = ['zlib', 'xz', 'bzip2', 'openssl', 'libcurl', 'cjson', 'ncurses', 'readline', 'libffi', 'expat', 'pcre2', 'sqlite'];
    var SPECIAL = { coffee: ['water', 'beans', 'grinder'], pizza: ['dough', 'tomato', 'mozzarella'], botify: ['electron', 'monaco'] };

    function bar(p) {
      var n = Math.round(p / 5);
      return '[' + new Array(n + 1).join('#') + new Array(21 - n).join('.') + ']';
    }

    function nxpmInstall(pkgs) {
      if (scene) scene.morphTo('cube');
      var t0 = global.performance.now();
      var d = reduced ? 0 : 1;
      var chain = Promise.resolve();
      var job = jobId;
      function dead() { return cancelled || job !== jobId; }

      pkgs.forEach(function (pkg) {
        chain = chain.then(function () {
          if (dead()) return;
          if (!/^[a-z0-9][a-z0-9._+-]{0,30}$/i.test(pkg)) {
            err('nxpm: invalid package name "' + pkg + '"');
            return;
          }
          var rnd = prng(hashStr(pkg));
          var deps = SPECIAL[pkg.toLowerCase()] || DEP_POOL.filter(function () { return rnd() < 0.22; }).slice(0, 3);
          var version = (1 + Math.floor(rnd() * 3)) + '.' + Math.floor(rnd() * 10) + '.' + Math.floor(rnd() * 20);
          var files = 12 + Math.floor(rnd() * 90);
          var sources = [pkg].concat(deps).map(function (n) {
            return n + '-' + (1 + Math.floor(rnd() * 4)) + '.' + Math.floor(rnd() * 12) + '.tar.xz';
          });

          print([{ t: ':: ', c: 't-accent' }, 'resolving dependencies for ', { t: pkg, c: 't-accent' }]);
          return sleep(320 * d).then(function () {
            if (dead()) return;
            print({ t: '   ' + pkg, c: 't-ok' });
            deps.forEach(function (dep, i) {
              print({ t: '   ' + (i === deps.length - 1 ? '└── ' : '├── ') + dep, c: 't-dim' });
            });
            if (pkg.toLowerCase() === 'sleep') {
              err('nxpm: dependency cycle: sleep → coffee → sleep. aborting.');
              cancelled = true;
              return;
            }
            print([{ t: ':: ', c: 't-accent' }, 'fetching ' + sources.length + ' source' + (sources.length > 1 ? 's' : '')]);
            var fetches = Promise.resolve();
            sources.forEach(function (src) {
              fetches = fetches.then(function () {
                if (dead()) return;
                var row = print({ t: '   ' + pad(src, 26) + bar(0) + '   0%', c: 't-dim' });
                var p = 0;
                function step() {
                  if (dead()) return Promise.resolve();
                  p = Math.min(100, p + 8 + Math.floor(rnd() * 22));
                  row.firstChild.textContent = '   ' + pad(src, 26) + bar(p) + ' ' + pad(p + '%', 4);
                  return p >= 100 ? Promise.resolve() : sleep(45 * d).then(step);
                }
                return step();
              });
            });
            return fetches;
          }).then(function () {
            if (dead()) return;
            print([{ t: ':: ', c: 't-accent' }, 'building in ', { t: 'BUILD_ROOT=/var/tmp/nxpm/stage/' + pkg, c: 't-path' }]);
            var units = ['main', 'resolve', 'fetch', 'build', 'index'].filter(function () { return rnd() < 0.8; });
            if (!units.length) units = ['main'];
            var cc = Promise.resolve();
            units.forEach(function (u) {
              cc = cc.then(function () {
                if (dead()) return;
                print({ t: '   CC   src/' + u + '.c', c: 't-dim' });
                return sleep(110 * d);
              });
            });
            return cc.then(function () {
              if (dead()) return;
              print({ t: '   LD   ' + pkg, c: 't-dim' });
              return sleep(160 * d);
            });
          }).then(function () {
            if (dead()) return;
            print([{ t: ':: ', c: 't-accent' }, 'atomic deploy: swapping stage into / … done']);
            print([{ t: ':: ', c: 't-accent' }, 'indexing ' + files + ' files → /var/lib/nxpm/' + pkg + '.idx']);
            ok('✔ ' + pkg + ' ' + version + ' installed');
          });
        });
      });

      return chain.then(function () {
        if (dead()) return;
        var secs = ((global.performance.now() - t0) / 1000).toFixed(2);
        dim('done in ' + secs + 's. (simulated; the real nxpm lives at ' + PROJECTS.nxpm.url.replace('https://', '') + ')');
        if (scene && opts.pulseCenter) opts.pulseCenter();
      });
    }

    /* ---------------- execution ---------------- */

    function tokenize(line) {
      var out2 = [], re = /"([^"]*)"|'([^']*)'|(\S+)/g, m;
      while ((m = re.exec(line))) out2.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
      return out2;
    }

    function setBusy(b) {
      busy = b;
      form.classList.toggle('is-busy', b);
      if (!b) scrollDown();
    }

    function run(line) {
      line = String(line || '').trim();
      print(promptParts(line));
      if (!line) return Promise.resolve();
      if (history[0] !== line) history.unshift(line);
      if (history.length > 50) history.pop();
      hIndex = -1;

      var tokens = tokenize(line);
      var name = (tokens.shift() || '').toLowerCase();
      var cmd = COMMANDS[name];
      if (!cmd) {
        var best = null, bestD = 3;
        Object.keys(COMMANDS).forEach(function (k) {
          var dd = levenshtein(name, k);
          if (dd < bestD) { bestD = dd; best = k; }
        });
        err('ersh: command not found: ' + name);
        if (best) print([{ t: 'did you mean ', c: 't-dim' }, { t: best, c: 't-cmd' }, { t: '?', c: 't-dim' }]);
        else dim("type 'help' for a list of commands");
        return Promise.resolve();
      }
      cancelled = false;
      jobId++;
      var result;
      try {
        result = cmd.run(tokens);
      } catch (e) {
        err(name + ': ' + (e && e.message ? e.message : 'failed'));
      }
      if (result && typeof result.then === 'function') {
        setBusy(true);
        return result.then(function () { setBusy(false); }, function () { setBusy(false); });
      }
      return Promise.resolve();
    }

    function complete() {
      var value = input.value;
      var tokens = value.split(/\s+/);
      var candidates = [];
      if (tokens.length <= 1) {
        candidates = Object.keys(COMMANDS).filter(function (k) { return !COMMANDS[k].hidden || k === tokens[0]; });
      } else {
        var c = tokens[0].toLowerCase();
        if (c === 'shape' && scene) candidates = scene.shapes.concat(['random']);
        else if (c === 'open') candidates = ['botify', 'nxpm', 'fgo', 'github'];
        else if (c === 'goto') candidates = SECTIONS.slice();
        else if (c === 'cat') candidates = Object.keys(FILES);
        else if (c === 'nxpm' && tokens.length === 2) candidates = ['install'];
      }
      var last = tokens[tokens.length - 1];
      var matches = candidates.filter(function (k) { return k.indexOf(last) === 0; });
      if (matches.length === 1) {
        tokens[tokens.length - 1] = matches[0];
        input.value = tokens.join(' ') + ' ';
      } else if (matches.length > 1) {
        var prefix = matches.reduce(function (a, b) {
          var i = 0;
          while (i < a.length && a[i] === b[i]) i++;
          return a.slice(0, i);
        });
        if (prefix.length > last.length) {
          tokens[tokens.length - 1] = prefix;
          input.value = tokens.join(' ');
        } else {
          print(promptParts(value));
          print({ t: matches.join('  '), c: 't-cmd' });
        }
      }
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      var line = input.value;
      input.value = '';
      run(line);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        if (!input.value) return; // let Tab move focus out when empty
        e.preventDefault();
        complete();
      } else if (e.key === 'ArrowUp') {
        if (!history.length) return;
        e.preventDefault();
        hIndex = Math.min(history.length - 1, hIndex + 1);
        input.value = history[hIndex];
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        hIndex = Math.max(-1, hIndex - 1);
        input.value = hIndex < 0 ? '' : history[hIndex];
      } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        if (busy || input.value) {
          e.preventDefault();
          cancelled = true;
          print(promptParts(input.value + '^C'));
          input.value = '';
          setBusy(false);
        }
      } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        out.textContent = '';
      }
    });

    body.addEventListener('click', function (e) {
      if (e.target.closest('a')) return;
      var sel = global.getSelection && global.getSelection();
      if (sel && String(sel).length) return;
      input.focus({ preventScroll: true });
    });

    /* ---------------- public ---------------- */

    function boot() {
      if (booted) return;
      booted = true;
      var info = scene ? scene.info() : null;
      var lines = [
        [{ t: '[ ok ] ', c: 't-ok' }, 'mounted ', { t: '~/projects', c: 't-path' }],
        info
          ? [{ t: '[ ok ] ', c: 't-ok' }, 'webgl' + info.webgl + ' context: ' + info.count.toLocaleString('en-US') + ' particles']
          : [{ t: '[warn] ', c: 't-warn' }, 'webgl unavailable, running without particles'],
        [{ t: '[ ok ] ', c: 't-ok' }, 'started ersh 1.0']
      ];
      var p = Promise.resolve();
      lines.forEach(function (l) {
        p = p.then(function () {
          print(l);
          return sleep(reduced ? 0 : 180);
        });
      });
      p.then(function () {
        print('');
        print([{ t: 'Welcome to ersh, the erhicaldc shell.', c: 't-accent' }]);
        print([
          { t: 'Type ', c: 't-dim' }, { t: 'help', c: 't-cmd' },
          { t: ' to get started, or try ', c: 't-dim' }, { t: 'neofetch', c: 't-cmd' },
          { t: ', ', c: 't-dim' }, { t: 'shape galaxy', c: 't-cmd' },
          { t: ' or ', c: 't-dim' }, { t: 'nxpm install coffee', c: 't-cmd' }, { t: '.', c: 't-dim' }
        ]);
      });
    }

    // Type a command into the prompt (visibly) and run it.
    function exec(line) {
      if (busy) return Promise.resolve();
      boot();
      if (reduced) {
        input.value = '';
        return run(line);
      }
      input.value = '';
      var i = 0;
      return new Promise(function (resolve) {
        (function type() {
          if (i <= line.length) {
            input.value = line.slice(0, i++);
            global.setTimeout(type, 18 + Math.random() * 30);
          } else {
            global.setTimeout(function () {
              input.value = '';
              resolve(run(line));
            }, 120);
          }
        })();
      });
    }

    return {
      boot: boot,
      exec: exec,
      run: run,
      focus: function () { input.focus({ preventScroll: true }); }
    };
  }

  ERH.Terminal = { create: create };
})(window);
