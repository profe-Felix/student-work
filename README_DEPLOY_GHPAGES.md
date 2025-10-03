# GH Pages Drop‑in (Vite React, HashRouter)

This drop‑in fixes the white screen on GitHub Pages by locking the Vite base path
and adds a reusable GitHub Actions workflow.

## Files in this pack

- `vite.config.ts` — hardcodes `base: '/student-work/'` (required for GH Pages repo `student-work`).
- `.github/workflows/deploy.yml` — CI build + deploy to GitHub Pages. Also copies `dist/index.html` → `dist/404.html` for SPA fallback.

## How to use

1. **Drop these files** into your repo (overwrite `vite.config.ts` if prompted):
   - `vite.config.ts`
   - `.github/workflows/deploy.yml`

2. Commit & push to **main** (or change the workflow branch if needed).  
   GitHub Actions will build and deploy your site to Pages automatically.

3. In the repo, go to **Settings → Pages → Build and deployment → Source = GitHub Actions**.

4. After the workflow finishes, visit:
   - `https://profe-felix.github.io/student-work/#/setup`
   - `https://profe-felix.github.io/student-work/#/student/assignment`
   - `https://profe-felix.github.io/student-work/#/teacher`

> If you prefer deploying from a branch (without Actions), build locally with:
>
> ```bash
> npm run build -- --base=/student-work/
> cp dist/index.html dist/404.html
> ```
>
> Then push `dist/` to a `gh-pages` branch and set Pages to that branch.
