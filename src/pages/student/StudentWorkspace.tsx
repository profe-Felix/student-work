// src/pages/student/StudentWorkspace.tsx
import { useEffect, useRef, useState } from 'react';
import { subscribeToAssignment, SetPagePayload, FocusPayload } from '../../lib/realtime';
import { useStudentAssignment } from '../../hooks/useStudentAssignment'; // see fallback hook below if you don't have one

export default function StudentWorkspace() {
  const { assignmentId, currentPageId, setPageById, nextPage, prevPage } = useStudentAssignment();
  const [focusOn, setFocusOn] = useState(false);
  const [navLocked, setNavLocked] = useState(false);
  const channelRef = useRef<any>(null);

  useEffect(() => {
    if (!assignmentId) return;
    const ch = subscribeToAssignment(assignmentId, {
      onSetPage: ({ pageId }: SetPagePayload) => {
        if (pageId && pageId !== currentPageId) setPageById(pageId);
      },
      onFocus: ({ on, lockNav }: FocusPayload) => {
        setFocusOn(!!on);
        setNavLocked(!!on && !!lockNav);
      }
    });
    channelRef.current = ch;
    return () => { ch?.unsubscribe?.(); };
  }, [assignmentId, currentPageId, setPageById]);

  return (
    <div className="relative p-4">
      {/* your reader/canvas/annotation UI here */}

      <div className="mt-3 flex gap-2">
        <button className="px-3 py-1 rounded bg-gray-100" onClick={prevPage} disabled={navLocked}>Prev</button>
        <button className="px-3 py-1 rounded bg-gray-100" onClick={nextPage} disabled={navLocked}>Next</button>
      </div>

      {focusOn && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] grid place-items-center select-none">
          <div className="text-white text-xl">Focus Mode — watch the teacher ✋</div>
        </div>
      )}
    </div>
  );
}
