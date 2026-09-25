# erhicaldcdev.github.io

Personal site of **erhicaldc**, a software developer and systems enthusiast.
It's served by GitHub Pages at <https://erhicaldcdev.github.io/>.

The site is built from scratch with no frameworks, bundlers or build step: plain HTML, CSS and
hand-written WebGL.

## What's inside

- **A GPU particle engine** (`assets/js/gl.js`, `scene.js`): up to 70,000 particles morph between
  procedural shapes as you scroll. Each project gets its own emblem: a node graph for Botify, a
  nested package cube for nxpm and a gear for fckingGoodOptimizer.
- **Post-processing:** quarter-resolution domain-warped nebula, bloom (bright pass plus separable
  Gaussian blur), chromatic aberration, starfield, vignette and film grain.
- **Interaction:** particles scatter around the cursor, clicking sends a shockwave, and scrolling
  fast stirs up turbulence.
- **ersh, a terminal in the page** (`assets/js/terminal.js`): try `help`, `neofetch`,
  `shape galaxy`, `text hello` or `nxpm install coffee`. It has tab completion, history and Ctrl+C.
- **Easter eggs:** press <kbd>`</kbd> for live render stats, or enter the Konami code.
- **A 404 page** (`404.html`) where the particles spell out "404".

## Performance and accessibility

- Adaptive quality lowers resolution, then particle count, if the frame rate drops. Rendering pauses
  while the tab is hidden, and a lost WebGL context is restored.
- Without WebGL the page falls back to a CSS gradient and stays fully usable.
- `prefers-reduced-motion` is respected: animation slows down and text effects and parallax are
  turned off.
- The page uses semantic landmarks, a skip link, visible focus styles and screen-reader-safe text
  effects.
- Touch devices get opaque panels instead of backdrop blur over a live canvas.

## Project layout

```
index.html              page markup and all copy
404.html                GitHub Pages "not found" page
favicon.svg
assets/css/style.css    all styles
assets/js/shapes.js     procedural point clouds (orb, knot, graph, cube, gear, grid, galaxy, text)
assets/js/gl.js         shaders and small WebGL helpers
assets/js/scene.js      the engine: morphing, layout, post-processing, input, quality
assets/js/terminal.js   the in-page shell
assets/js/main.js       page wiring: section → shape mapping, nav, reveals, clipboard, HUD
assets/img/             social preview and touch icon
```

To add or change a project, edit its `<article>` in `index.html`. Then map its `data-section` to a
shape in `SECTION_VIEW` in `assets/js/main.js`, and add it to `PROJECTS` in `assets/js/terminal.js`
if you want the terminal to know about it.

## Running locally

Any static file server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly from disk works too; the 404 page needs a server because it uses
root-relative paths. Add `?quality=fixed` to the URL to turn off adaptive quality, which helps
when you take screenshots.

## Credits

The shader hash functions are "Hash without Sine" by Dave Hoskins (MIT). Fonts are Space Grotesk,
Inter and JetBrains Mono, served by Google Fonts.
