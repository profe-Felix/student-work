# Student Work Starter (v0.1)

## Quick start
1. Create a Supabase project and note your URL and keys.
2. Copy `.env.example` to `.env` and fill values:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` for frontend
   - `SUPABASE_SERVICE_ROLE_KEY` for seeding (do NOT ship to frontend)
3. Install deps: `pnpm i` (or `npm i`)
4. Seed students `A_01…A_28`: `npm run seed`
5. Run dev server: `npm run dev`
6. Open `/student/assignment` and test drawing + recording.

## Notes
- This is Milestone 1 scaffold (drawing, audio, basic pages).
- Storage uploads and manifest writes are next to wire (M1 finishing).
- Videos are generated on-demand server-side and auto-deleted after download (M2).


## Deploy to GitHub Pages (no local npm needed)
1. Create a new GitHub repo and upload all files in this folder.
2. In the repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `VITE_SUPABASE_URL` (from Supabase Settings → API)
   - `VITE_SUPABASE_ANON_KEY` (anon public key)
3. Go to **Settings → Pages** and set **Source: GitHub Actions**.
4. Push to `main` (or use the GitHub web UI to upload) — the `Deploy to GitHub Pages` workflow will build and publish automatically.
5. Your site will be at: `https://<your-username>.github.io/<repo-name>/`
   - Sign in with a seeded account (e.g., A_01@local / A_01!) if you’ve seeded users.
