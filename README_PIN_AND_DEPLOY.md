# React/DOM Pin + Pages Deploy (Drop‑in)

This pack fixes the runtime by pinning **react** and **react-dom** to matching stable versions
and ensures GitHub Pages deploys the compiled build.

## Files

- `package.json` — pins:
  - `"react": "18.3.1"`
  - `"react-dom": "18.3.1"`
  - dev deps: Vite 5.x and plugin-react 4.x
- `.github/workflows/deploy.yml` — builds with `--base=/student-work/`, regenerates lockfile, deploys `dist/`.
- `vite.config.ts` — hardcodes `base: '/student-work/'`.

## How to use

1. **Drop these three files** into your repo root (overwrite when prompted):
   - `package.json`
   - `.github/workflows/deploy.yml`
   - `vite.config.ts`

2. Commit and push to **main**.

3. In GitHub → **Settings → Pages → Build and deployment → Source = GitHub Actions**.

4. Open **Actions** → run **Build & Deploy (Vite → GitHub Pages)** (or wait for push).

5. After it’s green, hard refresh:
   - https://profe-felix.github.io/student-work/#/setup
   - https://profe-felix.github.io/student-work/#/student/assignment
   - https://profe-felix.github.io/student-work/#/teacher

If you use a different package set than what’s in this `package.json`, merge just the `"dependencies"` and `"devDependencies"` version pins into your existing `package.json` instead of overwriting the whole file.
