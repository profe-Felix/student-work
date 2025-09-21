// src/components/TeacherSyncBar.tsx
import { useEffect, useRef, useState } from 'react';
import { assignmentChannel, publishAutoFollow, publishFocus, publishSetPage } from '@/lib/realtime';

type Props = { assignmentId: string; pageId: string; pageIndex: number; className?: string };

export default function TeacherSyncBar({ assignmentId, pageId, pageIndex, className }: Props) {
  const [autoFollow, setAutoFollow] = useState(false);
  const [focus, setFocus] = useState(false);
  const [lockNav, setLockNav] = useState(true);
  const chRef = useRef<any>(null);

  useEffect(() => {
    if (!assignmentId) return;
    const ch = assignmentChannel(assignmentId);
    ch.subscribe();
    chRef.current = ch;
    return () => { ch.unsubscribe(); };
  }, [assignmentId]);

  async function pushOnce() {
    if (!chRef.current) return;
    await publishSetPage(chRef.current, pageId, pageIndex);
  }

  async function toggleAutoFollow() {
    if (!chRef.current) return;
    const next = !autoFollow;
    setAutoFollow(next);
    await publishAutoFollow(chRef.current, next);
    if (next) await publishSetPage(chRef.current, pageId, pageIndex); // seed
  }

  async function toggleFocus() {
    if (!chRef.current) return;
    const next = !focus;
    setFocus(next);
    await publishFocus(chRef.current, next, lockNav);
  }

  // auto-follow re-push on page change
  useEffect(() => {
    if (autoFollow && chRef.current) publishSetPage(chRef.current, pageId, pageIndex);
  }, [autoFollow, pageId, pageIndex]);

  return (
    <div className={`flex items-center gap-2 p-2 bg-white/80 rounded-xl shadow border ${className ?? ''}`}>
      <button className="px-3 py-1 rounded bg-black text-white" onClick={pushOnce}>Sync to Me</button>
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={autoFollow} onChange={toggleAutoFollow}/> Auto-follow
      </label>
      <span className="mx-1 h-5 w-px bg-gray-300" />
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={lockNav} onChange={() => setLockNav(v=>!v)} disabled={!focus}/> Lock nav
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
