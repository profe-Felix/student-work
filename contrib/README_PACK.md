# Pack 2025-10-01 (Add-only, surgical)

This pack **adds** files only—no deletions, no overwrites—to avoid breaking anything.
It introduces:
- `src/lib/api.ts` (unified data helpers),
- `src/lib/assets.ts` (canonical asset URLs),
- `src/lib/drafts.ts`, `src/lib/outbox.ts` (drafts + save queue; localStorage-based),
- `src/components/SaveStatus.tsx` (UI),
- `src/pages/SetupChecklist.tsx` (first-run checks),
- `src/styles/toolbar.css` (bigger tap targets),
- `db/migrations/2025-10-01_init.sql` (authoritative schema snapshot).

## Optional wiring (safe)
1. **Setup page**  
   In `src/main.tsx`, add:
   ```tsx
   import SetupChecklist from './pages/SetupChecklist'
   ...
   <Route path="/setup" element={<SetupChecklist />} />
   ```

2. **Save status pill** (student page)  
   In `src/pages/student/assignment.tsx`, near the toolbar/header:
   ```tsx
   import SaveStatus from '../../components/SaveStatus'
   ...
   <SaveStatus />
   ```

3. **Use unified APIs**  
   Replace calls to `lib/db` + `lib/queries` with `lib/api` **gradually** in new code.

4. **Asset URLs**  
   Where you build URLs for PDFs/audio/thumbnails, prefer:
   ```ts
   import { getAssetUrl } from '../../lib/assets'
   const url = await getAssetUrl('pdfs', pdf_path) // or 'audio', 'thumbnails'
   ```

5. **Run migration**  
   Apply `db/migrations/2025-10-01_init.sql` to your Supabase DB.

This is intentionally minimal and reversible. When you're ready, I can provide a follow-up patch that integrates these across existing components.
