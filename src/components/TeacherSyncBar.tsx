// src/components/TeacherSyncBar.tsx
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import {
  assignmentChannel,
  publishAutoFollow,
  publishFocus,
  publishSetPage,
} from '../lib/realtime';

type Props = {
  assignmentId: string;
  pageId: string;
  pageIndex: number;
  className?: string;
};

export default function TeacherSyncBar({
  assignmentId,
  pageId,
  pageIndex,
  className,
}: Props) {
  const [autoFollow, setAutoFollow] = useState(false);
  const [focus, setFocus] = useState(false);
  const [lockNav, setLockNav] = useState(true);
  const chRef = useRef<ReturnType<typeof assignmentChannel> | null>(null);

  // (1) Create/subscribe the channel when assignmentId changes
  useEffect(() => {
    if (!assignmentId) return;

    const ch = assignmentChannel(assignmentId);
    ch.subscribe();
    chRef.current = ch;

    return () => {
      // Some versions expose unsubscribe(), others require removeChannel()
      if (typeof (ch as any).unsubscribe === 'function') {
        (ch as any).unsubscribe();
      } else {
        supabase.removeChannel(ch);
      }
      chRef.current = null;
    };
  }, [assignmentId]);

  // helper to get a current channel safely
  const getCh = () => chRef.current;

  async function pushOnce() {
    const ch = getCh();
    if (!ch) return;
    await publishSetPage(ch, pageId, pageIndex);
  }

  async function toggleAutoFollow() {
    const ch = getCh();
    if (!ch) return;
    const next = !autoFollow;
    setAutoFollow(next);
    await publishAutoFollow(ch, next);
    if (next) {
      // seed initial page when turning on
      await publishSetPage(ch, pageId, pageIndex);
    }
  }

  async function toggleFocus() {
    const ch = getCh();
    if (!ch) return;
    const next = !focus;
    setFocus(next);
    await publishFocus(ch, next, lockNav);
  }

  // (2) When auto-follow is ON, republish the current page if it changes
  useEffect(() => {
    const ch = getCh();
    if (autoFollow && ch) {
      publishSetPage(ch, pageId, pageIndex);
    }
  }, [autoFollow, pageId, pageIndex]);

  return (
    <div
      className={`flex items-center gap-2 p-2 bg-white/80 rounded-xl shadow border ${
        className ?? ''
      }`}
    >
      <button className="px-3 py-1 rounded bg-black text-white" onClick={pushOnce}>
        Sync to Me
      </button>

      <label className="flex items-center gap-1">
        <input type="checkbox" checked={autoFollow} onChange={toggleAutoFollow} />
        Auto-follow
      </label>

      <span className="mx-1 h-5 w-px bg-gray-300" />

      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={lockNav}
          onChange={() => setLockNav((v) => !v)}
          disabled={!focus}
        />
        Lock nav
      </label>

      <button
        className={`px-3 py-1 rounded ${
          focus ? 'bg-red-600 text-white' : 'bg-gray-100'
        }`}
        onClick={toggleFocus}
      >
        {focus ? 'End Focus' : 'Start Focus'}
      </button>
    </div>
  );
}
