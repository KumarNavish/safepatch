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

## Repository structure

This is the standalone source repository. Run commands from its root.

- `index.html` and `styles.css`: page and styling.
- `src/`: TypeScript geometry, optimization, rendering and controls.
- `tests/`: geometry regressions.
- `package.json`: development, verification and build entrypoints.
- `.github/workflows/pages.yml`: pull-request checks and main-branch Pages deployment.

## Local development

```bash
npm ci
npm run dev
```

Build the static application:

```bash
npm run build
```

Preview an existing build:

```bash
npm run preview
```

## Verification

Run the tests:

```bash
npm test
```

Run the complete local check used by CI:

```bash
npm run check
```

This runs lint, TypeScript checks, tests and the production build. The workflow
checks pull requests without deploying them. A push to `main` also deploys Pages,
including a documentation-only push.
