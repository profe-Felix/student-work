// src/lib/realtime.ts
// Centralized realtime helpers, plus a tiny global channel to handoff assignment switches.

import { supabase } from './supabaseClient';

/** ---------- Types you were already using (kept here so other files keep compiling) ---------- */
export interface SetPagePayload {
  pageId: string;         // DB pages.id (uuid)
  pageIndex: number;      // zero-based page index
  ts?: number;
}
export interface FocusPayload {
  on: boolean;
  lockNav?: boolean;
  ts?: number;
}
export interface AutoFollowPayload {
  on: boolean;
  allowedPages?: number[] | null; // zero-based allowed page indexes
  teacherPageIndex?: number;      // teacher's current page
  ts?: number;
}
export type TeacherPresenceState = {
  role: 'teacher';
  autoFollow: boolean;
  allowedPages: number[] | null;
  teacherPageIndex: number | null;
};

/** -------------------------------------------------------------------------------------------
 *  Global “class” channel (assignment-agnostic) used *only* to tell students to switch
 *  to a different assignmentId.
 *  ----------------------------------------------------------------------------------------- */
export function globalChannel() {
  return supabase.channel('global-class', {
    config: { broadcast: { ack: true } },
  });
}

/** Teacher fires this when changing the assignment dropdown. */
export async function publishSetAssignment(assignmentId: string) {
  const ch = globalChannel();
  await ch.subscribe();
  await ch.send({
    type: 'broadcast',
    event: 'set-assignment',
    payload: { assignmentId, ts: Date.now() },
  });
  await supabase.removeChannel(ch);
}

/** Student bootstraps this once and will jump to any new assignmentId the teacher selects. */
export function subscribeToGlobal(onSetAssignment: (assignmentId: string) => void) {
  const ch = globalChannel()
    .on('broadcast', { event: 'set-assignment' }, (msg: any) => {
      const id = msg?.payload?.assignmentId;
      if (typeof id === 'string' && id) onSetAssignment(id);
    })
    .subscribe();
  return () => supabase.removeChannel(ch);
}

/** -------------------------------------------------------------------------------------------
 *  (Optional) Per-assignment channel helpers — keep these if your app uses them elsewhere.
 *  They’re generic and safe to include even if you don’t use every event.
 *  ----------------------------------------------------------------------------------------- */
export function assignmentChannel(assignmentId: string) {
  return supabase.channel(`assignment:${assignmentId}`, {
    config: { broadcast: { ack: true } },
  });
}

/** ----- Set Page ----- */
export async function publishSetPage(assignmentId: string, payload: SetPagePayload) {
  const ch = assignmentChannel(assignmentId);
  await ch.subscribe();
  await ch.send({ type: 'broadcast', event: 'set-page', payload: { ...payload, ts: Date.now() } });
  await supabase.removeChannel(ch);
}
export function subscribeToSetPage(
  assignmentId: string,
  onPayload: (payload: SetPagePayload) => void
) {
  const ch = assignmentChannel(assignmentId)
    .on('broadcast', { event: 'set-page' }, (msg: any) => {
      const p = msg?.payload as SetPagePayload;
      if (!p) return;
      onPayload(p);
    })
    .subscribe();
  return () => supabase.removeChannel(ch);
}

/** ----- Focus (teacher “eyes on me”) ----- */
export async function publishFocus(assignmentId: string, payload: FocusPayload) {
  const ch = assignmentChannel(assignmentId);
  await ch.subscribe();
  await ch.send({ type: 'broadcast', event: 'focus', payload: { ...payload, ts: Date.now() } });
  await supabase.removeChannel(ch);
}
export function subscribeToFocus(
  assignmentId: string,
  onPayload: (payload: FocusPayload) => void
) {
  const ch = assignmentChannel(assignmentId)
    .on('broadcast', { event: 'focus' }, (msg: any) => {
      const p = msg?.payload as FocusPayload;
      if (!p) return;
      onPayload(p);
    })
    .subscribe();
  return () => supabase.removeChannel(ch);
}

/** ----- Auto-follow (optionally gate pages) ----- */
export async function publishAutoFollow(assignmentId: string, payload: AutoFollowPayload) {
  const ch = assignmentChannel(assignmentId);
  await ch.subscribe();
  await ch.send({
    type: 'broadcast',
    event: 'auto-follow',
    payload: { ...payload, ts: Date.now() },
  });
  await supabase.removeChannel(ch);
}
export function subscribeToAutoFollow(
  assignmentId: string,
  onPayload: (payload: AutoFollowPayload) => void
) {
  const ch = assignmentChannel(assignmentId)
    .on('broadcast', { event: 'auto-follow' }, (msg: any) => {
      const p = msg?.payload as AutoFollowPayload;
      if (!p) return;
      onPayload(p);
    })
    .subscribe();
  return () => supabase.removeChannel(ch);
}
