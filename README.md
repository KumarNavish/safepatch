# SafePatch Geometry

SafePatch Geometry is a canvas-based, single-page demo for constrained patch optimization.

## What it shows

- A 2D ship zone formed by the intersection of 2-4 halfspaces.
- An unconstrained update `Δ0 = -η g_new` (red arrow).
- A projected, ship-safe update `Δ*` (blue arrow) from the QP:

```text
min_Δ   <g_new, Δ> + (1 / (2η)) ||Δ||^2
s.t.    <g_k, Δ> <= ε_k
```

- Dual multipliers `λ_k >= 0` with animated dials.
- SHIP/HOLD state with reason when certification fails.

## Structure

```text
/demo
  index.html
  styles.css
  src/
    main.ts
    geometry.ts
    qp.ts
    render.ts
    ui.ts
  tests/
    geometry.test.ts
  README.md
```

In this repository, the demo lives at:

- `site/demos/safepatch/` (source)
- `site/public/safepatch/` (built output)

## Local development

From `site/`:

```bash
npm install
npm run safepatch:dev
```

Build static output:

```bash
npm run safepatch:build
```

Run tests:

```bash
npm run safepatch:test
```
