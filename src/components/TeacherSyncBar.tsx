// src/components/TeacherSyncBar.tsx
import React, { useCallback, useMemo, useState } from 'react';
import {
  publishAutoFollow,
  publishFocus,
  publishSetPage,
  setTeacherPresence,
} from '../lib/realtime';

type Props = {
  assignmentId: string;
  pageId: string;
  pageIndex: number;
  className?: string;
};

export default function TeacherSyncBar({ assignmentId, pageId, pageIndex, className }: Props) {
  const [autoFollow, setAutoFollow] = useState(false);
  const [lockNav, setLockNav] = useState(false);
  const [focus, setFocus] = useState(false);
  const allowedPages = useMemo<number[] | null>(() => null, [pageId]);

  const pushPresence = useCallback(async (nextAutoFollow: boolean, nextPageIndex: number) => {
    await setTeacherPresence(assignmentId, {
      autoFollow: nextAutoFollow,
      allowedPages,
      teacherPageIndex: nextPageIndex,
      focusOn: focus,
      lockNav,
    });
  }, [assignmentId, allowedPages, focus, lockNav]);

  const toggleSync = useCallback(async () => {
    const next = !autoFollow;
    setAutoFollow(next);
    await publishAutoFollow(assignmentId, { on: next, allowedPages, teacherPageIndex: pageIndex });
    await pushPresence(next, pageIndex);
  }, [autoFollow, assignmentId, allowedPages, pageIndex, pushPresence]);

  const toggleFocus = useCallback(async () => {
    const next = !focus;
    setFocus(next);
    await publishFocus(assignmentId, { on: next, lockNav });
    await pushPresence(autoFollow, pageIndex);
  }, [assignmentId, focus, lockNav, autoFollow, pageIndex, pushPresence]);

  const gotoPage = useCallback(async (idx: number) => {
    await publishSetPage(assignmentId, idx);
    await pushPresence(autoFollow, idx);
  }, [assignmentId, autoFollow, pushPresence]);

  return (
    <div className={className ?? ''}>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoFollow}
            onChange={toggleSync}
          />
          Sync to me
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={lockNav}
            onChange={() => setLockNav(v => !v)}
            disabled={!focus}
          />
          Lock nav
        </label>

        <button
          className={`px-3 py-1 rounded ${focus ? 'bg-red-600 text-white' : 'bg-gray-100'}`}
          onClick={toggleFocus}
        >
          {focus ? 'End Focus' : 'Start Focus'}
        </button>

        <button
          className="px-3 py-1 rounded bg-gray-100"
          onClick={() => gotoPage(pageIndex)}
        >
          Resend page {pageIndex + 1}
        </button>
      </div>
    </div>
  );
}
