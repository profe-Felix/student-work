//src/components/TeacherSyncBar.tsx
import { useEffect, useRef, useState } from 'react';
import {
  assignmentChannel,
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

export default function TeacherSyncBar({ assignmentId, pageId, pageIndex, className }: Props) {
  const [autoFollow, setAutoFollow] = useState(false);
  const [focus, setFocus] = useState(false);
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

  // Presence stays current with UI toggles and page changes
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

  async function pushOnce() {
    if (!chRef.current) return;
    await publishSetPage(chRef.current, pageId, pageIndex);
  }

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
    await setTeacherPresence(chRef.current, {
      autoFollow,
      allowedPages: allowedRef.current ?? null,
      teacherPageIndex: pageIndex,
      focusOn: next,
      lockNav,
    });
    await publishFocus(chRef.current, next, lockNav);
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 p-2 bg-white/80 rounded-xl shadow border ${className ?? ''}`}>
      <button
        className="px-3 py-1 rounded bg-black text-white"
        onClick={pushOnce}
        title="Push current page to all students one time"
      >
        Sync to Me (once)
      </button>

      <button
        className={`px-3 py-1 rounded ${autoFollow ? 'bg-black text-white' : 'bg-gray-100'}`}
        onClick={toggleAutoFollow}
        title="While ON, students follow your page. Optionally allow a page range."
      >
        {autoFollow ? 'Auto-follow: ON' : 'Auto-follow: OFF'}
      </button>

      <label className="flex items-center gap-1 text-sm">
        <span className="text-gray-600">Allow pages</span>
        <input
          className="border rounded px-2 py-1"
          placeholder="e.g. 1-3,5"
          value={rangeText}
          onChange={e => setRangeText(e.target.value)}
          disabled={autoFollow} // lock input while active
          style={{ minWidth: 120 }}
        />
      </label>

      <span className="mx-1 h-5 w-px bg-gray-300" />

      <label className="flex items-center gap-1 text-sm">
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
    </div>
  );
}
