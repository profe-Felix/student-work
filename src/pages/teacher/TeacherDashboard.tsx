// src/pages/teacher/TeacherDashboard.tsx
import { useEffect, useState } from 'react';
import { listAssignments, listPages, listLatestSubmissionsByPage, getThumbnailForSubmission } from '../../lib/queries';
import { publicUrl } from '../../lib/supabaseHelpers';
import TeacherSyncBar from '../../components/TeacherSyncBar';
import PdfDropZone from '../../components/PdfDropZone';
import { supabase } from '../../lib/db'; // <-- add this

export default function TeacherDashboard() {
  const [assignments, setAssignments] = useState<any[]>([]);
  const [pages, setPages] = useState<any[]>([]);
  const [assignmentId, setAssignmentId] = useState<string>('');
  const [pageId, setPageId] = useState<string>('');
  const [pageIndex, setPageIndex] = useState<number>(0);
  const [cards, setCards] = useState<any[]>([]);

  useEffect(() => {
    listAssignments().then(({ data }: { data: any[] | null }) => setAssignments(data ?? []));
  }, []);

  useEffect(() => {
    if (!assignmentId) return;
    listPages(assignmentId).then(({ data }: { data: any[] | null }) => setPages(data ?? []));
  }, [assignmentId]);

  useEffect(() => {
    async function load() {
      if (!pageId) { setCards([]); return; }
      const subs = await listLatestSubmissionsByPage(pageId);
      const withThumbs = await Promise.all(subs.map(async (s: any) => {
        const path = await getThumbnailForSubmission(s.id);
        return { ...s, thumb: path ? publicUrl(path) : null };
      }));
      setCards(withThumbs);
    }
    load();
  }, [pageId]);

  // ---------------- NEW: reply to student "hello" with a presence snapshot ----------------
  useEffect(() => {
    if (!assignmentId) return;

    const ch = supabase
      .channel(`assignment:${assignmentId}`, { config: { broadcast: { ack: true } } })
      .on('broadcast', { event: 'hello' }, async () => {
        // Minimal snapshot that forces snap-to-teacher-page on join.
        // If you want this to respect a Sync toggle, wire that boolean here.
        await ch.send({
          type: 'broadcast',
          event: 'presence-snapshot',
          payload: {
            autoFollow: true,              // forces snap on join
            teacherPageIndex: pageIndex,   // current teacher page
            allowedPages: null,
            focusOn: false,
            lockNav: false,
            ts: Date.now()
          }
        });
      });

    ch.subscribe();

    return () => { try { ch.unsubscribe(); } catch {} };
  }, [assignmentId, pageIndex]);
  // ----------------------------------------------------------------------------------------

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-2xl font-semibold">Teacher Dashboard</h1>

      <PdfDropZone onCreated={(newId: string) => {
        setAssignmentId(newId);
      }} />

      <div className="flex gap-3 items-center">
        <select
          className="border rounded px-2 py-1"
          value={assignmentId}
          onChange={e => { setAssignmentId(e.target.value); setPageId(''); }}
        >
          <option value="">Select assignment…</option>
          {assignments.map((a: any) => <option key={a.id} value={a.id}>{a.title}</option>)}
        </select>

        <select
          className="border rounded px-2 py-1"
          value={pageId}
          onChange={e => {
            const pid = e.target.value;
            setPageId(pid);
            const idx = pages.find((p: any) => p.id === pid)?.page_index ?? 0;
            setPageIndex(idx);
          }}
          disabled={!assignmentId}
        >
          <option value="">Select page…</option>
          {pages.map((p: any) => <option key={p.id} value={p.id}>Pg {p.page_index + 1}: {p.title}</option>)}
        </select>
      </div>

      {assignmentId && pageId && (
        <TeacherSyncBar
          assignmentId={assignmentId}
          pageId={pageId}
          pageIndex={pageIndex}
          className="sticky top-2 z-10"
        />
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {cards.map((c: any) => (
          <div key={c.id} className="border rounded-xl overflow-hidden shadow-sm">
            {c.thumb ? (
              <img src={c.thumb} alt="thumbnail" className="w-full aspect-[4/3] object-cover" />
            ) : (
              <div className="w-full aspect-[4/3] bg-gray-100 grid place-items-center text-gray-500">No preview</div>
            )}
            <div className="p-2 text-sm">
              <div className="font-medium">Student: {c.student_id}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
