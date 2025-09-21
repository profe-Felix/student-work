// src/hooks/useStudentAssignment.ts
import { useMemo, useState } from 'react';

export function useStudentAssignment() {
  // TODO: replace these with your real assignment/page state from Supabase/context
  const [assignmentId] = useState<string>('demo-assignment');
  const [pages] = useState<string[]>(['page-1', 'page-2', 'page-3']);
  const [currentIndex, setCurrentIndex] = useState(0);

  const currentPageId = useMemo(() => pages[currentIndex], [pages, currentIndex]);

  function setPageById(pid: string) {
    const idx = pages.indexOf(pid);
    if (idx >= 0) setCurrentIndex(idx);
  }
  function nextPage() { setCurrentIndex(i => Math.min(i + 1, pages.length - 1)); }
  function prevPage() { setCurrentIndex(i => Math.max(i - 1, 0)); }

  return { assignmentId, currentPageId, setPageById, nextPage, prevPage };
}
