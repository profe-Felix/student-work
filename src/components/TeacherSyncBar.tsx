import React from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { publishFocus, setTeacherPresence } from '../../lib/realtime';

type Props = {
  chRef: React.MutableRefObject<RealtimeChannel | null>;
  pageIndex: number;
  autoFollow: boolean;
  focus: boolean;
  lockNav: boolean;
  allowedRef: React.MutableRefObject<number[] | null>;
  setFocus: (v: boolean) => void;
  setLockNav: (v: boolean) => void;
};

export default function TeacherSyncBar({
  chRef,
  pageIndex,
  autoFollow,
  focus,
  lockNav,
  allowedRef,
  setFocus,
  setLockNav,
}: Props) {
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

  // Minimal placeholder UI to avoid JSX/closing-tag issues; keeps behavior callable from parent if needed.
  return null;
}
