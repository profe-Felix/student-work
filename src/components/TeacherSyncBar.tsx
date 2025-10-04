// src/components/TeacherSyncBar.tsx
import { useEffect, useRef, useState } from 'react';
import {
  assignmentChannel,
  publishAutoFollow,
  publishFocus,
  publishSetPage,
  publishSetAssignment,
  setTeacherPresence,
} from '../lib/realtime';

type Props = {
  assignmentId: string;
  pageId: string;
  pageIndex: number;
  className?: string;
  roomId?: string;
  onSyncChange?: (on: boolean) => void;
};

// Accept "1-3,5,8-9" (1-based) -> [0,1,2,4,7,8] (0-based)
function parseRanges(input: string): number[] {
  const out = new Set<number>();
  const parts = input.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (isFinite(a) && isFinite(b)) {
        if (a > b) [a, b] = [b, a];
        for (let k = a; k <= b; k++) out.add(k - 1);
      }
    } else {
      const n = parseInt(p, 10);
      if (isFinite(n)) out.add(n - 1);
    }
  }
  return Array.from(out.values()).sort((a, b) => a - b);
}

export default function TeacherSyncBar({ assignmentId, pageId, pageIndex, className, roomId, onSyncChange }: Props) {
  const [autoFollow, setAutoFollow] = useState(false);
  const [focus, setFocus] = useState(false);
  
  async function toggleSync() {
    if (!chRef.current) return;
    const next = !autoFollow;
    setAutoFollow(next);
    try {
      const allowed = parseRanges(rangeText);
      allowedRef.current = allowed ?? null;
      await setTeacherPresence(chRef.current, {
        autoFollow: next,
        allowedPages: allowedRef.current ?? null,
        teacherPageIndex: pageIndex,
        focusOn: focus,
        lockNav,
      });
      await publishAutoFollow(chRef.current, next, allowed ?? null, pageIndex);
      if (next) {
        await publishSetPage(chRef.current, pageId, pageIndex);
        try { await publishSetAssignment(assignmentId, roomId || 'default'); } catch {}
      }
    } finally {
      try { onSyncChange?.(next); } catch {}
    }
  }
const [lockNav, setLockNav] = useState(true);
  const [rangeText, setRangeText] = useState('');
  const allowedRef = useRef<number[] | null>(null);
  const chRef = useRef<ReturnType<typeof assignmentChannel> | null>(null);

  // Open teacher channel and publish initial presence AFTER subscribe
  useEffect(() => {
    if (!assignmentId) return;
    const ch = assignmentChannel(assignmentId);
    ch.subscribe(async (status: string) => {
      if (status === 'SUBSCRIBED') {
        await setTeacherPresence(ch, {
          autoFollow,
          allowedPages: allowedRef.current ?? null,
          teacherPageIndex: pageIndex,
          focusOn: focus,
          lockNav,
        });
      }
    });
    chRef.current = ch;
    return () => { ch.unsubscribe(); chRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentId]);

  // Whenever these change, update presence
  useEffect(() => {
    if (!chRef.current) return;
    void setTeacherPresence(chRef.current, {
      autoFollow,
      allowedPages: allowedRef.current ?? null,
      teacherPageIndex: pageIndex,
      focusOn: focus,
      lockNav,
    });
  }, [autoFollow, focus, lockNav, pageIndex]);

  // When auto-follow is ON, rebroadcast current page on change (snappy)
  useEffect(() => {
    if (autoFollow && chRef.current && pageId) {
      void publishSetPage(chRef.current, pageId, pageIndex);
    }
  }, [autoFollow, pageId, pageIndex]);

  async function toggleAutoFollow() {
    if (!chRef.current) return;
    const next = !autoFollow;
    setAutoFollow(next);

    const allowed = next ? parseRanges(rangeText) : null;
    allowedRef.current = allowed;

    // presence first (so late joiners immediately see it)
    await setTeacherPresence(chRef.current, {
      autoFollow: next,
      allowedPages: allowed ?? null,
      teacherPageIndex: pageIndex,
      focusOn: focus,
      lockNav,
    });

    // broadcast for currently connected students
    await publishAutoFollow(chRef.current, next, allowed ?? null, pageIndex);
    if (next) {
      await publishSetPage(chRef.current, pageId, pageIndex);
    }
  }

  
  async function toggleFocus() {
    if (!chRef.current) return;
    const next = !focus;
    setFocus(next);
    await publishFocus(chRef.current, next, lockNav);
    await setTeacherPresence(chRef.current, {
      autoFollow,
      allowedPages: allowedRef.current ?? null,
      teacherPageIndex: pageIndex,
      focusOn: next,
      lockNav,
    });
  }

