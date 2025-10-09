// src/pages/teacher/TeacherDashboard.tsx
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  listAssignments,
  listPages,
  listLatestSubmissionsByPage,
  getThumbnailForSubmission
} from '../../lib/queries';
import { publicUrl } from '../../lib/supabaseHelpers';
import TeacherSyncBar from '../../components/TeacherSyncBar';
import PdfDropZone from '../../components/PdfDropZone';
import { teacherPresenceResponder } from '../../lib/realtime';

export default function TeacherDashboard() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const classCode = (params.get('class') || 'A').toUpperCase();

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
      const withThumbs = await Promise.all(
        subs.map(async (s: any) => {
          const path = await getThumbnailForSubmission(s.id);
          return { ...s, thumb: path ? publicUrl(path) : null };
        })
      );
      setCards(withThumbs);
    }
    load();
  }, [pageId]);

  // === Answer student "hello" pings with the current teacher presence snapshot (class-scoped) ===
  useEffect(() => {
    if (!assignmentId) return;

    const stop = teacherPresenceResponder(classCode, assignmentId, () => {
      // Try class-scoped cache first; fall back to legacy key if present
      try {
        const rawScoped = localStorage.getItem(`presence:${classCode}:${assignmentId}`);
        const rawLegacy = localStorage.getItem(`presence:${assignmentId}`);
        const p = rawScoped ? JSON.parse(rawScoped) : (rawLegacy ? JSON.parse(rawLegacy) : {});
        return {
          autoFollow: !!p.autoFollow,
          focusOn: !!p.focusOn,
          lockNav: !!p.lockNav,
          allowedPages: Array.isArray(p.allowedPages) ? p.allowedPages : null,
          teacherPageIndex:
            typeof p.teacherPageIndex === 'number' ? p.teacherPageIndex : pageIndex,
        };
      } catch {
        return {
          autoFollow: false,
          focusOn: false,
          lockNav: false,
          allowedPages: null,
          teacherPageIndex: pageIndex,
        };
      }
    });

    return stop;
  }, [classCode, assignmentId, pageIndex]);

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-2xl font-semibold">Teacher Dashboard</h1>

      <PdfDropZone
        onCreated={(newId: string) => {
          setAssignmentId(newId);
          setPageId('');
          setPageIndex(0);
        }}
      />

      <div className="flex gap-3 items-center">
        <select
          className="border rounded px-2 py-1"
          value={assignmentId}
          onChange={e => { setAssignmentId(e.target.value); setPageId(''); }}
        >
          <option value="">Select assignment…</option>
          {assignments.map((a: any) => (
            <option key={a.id} value={a.id}>{a.title}</option>
          ))}
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
          {pages.map((p: any) => (
            <option key={p.id} value={p.id}>
              Pg {p.page_index + 1}: {p.title}
            </option>
          ))}
        </select>
      </div>

      {assignmentId && pageId && (
        <TeacherSyncBar
          classCode={classCode}
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
              <div className="w-full aspect-[4/3] bg-gray-100 grid place-items-center text-gray-500">
                No preview
              </div>
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
