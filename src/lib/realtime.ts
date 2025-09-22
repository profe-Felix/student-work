// src/lib/realtime.ts
// Realtime utilities: legacy-compatible exports + global assignment handoff.

import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'

/** ---------- Types (kept broad for compatibility) ---------- */
export interface SetPagePayload {
  pageId?: string;         // optional for legacy calls
  pageIndex: number;
  ts?: number;
}
export interface FocusPayload {
  on: boolean;
  lockNav?: boolean;
  ts?: number;
}
export interface AutoFollowPayload {
  on: boolean;
  allowedPages?: number[] | null;
  teacherPageIndex?: number;
  ts?: number;
}
export type TeacherPresenceState = {
  role: 'teacher';
  autoFollow: boolean;
  allowedPages: number[] | null;
  teacherPageIndex: number | null;
  ts?: number;
};

/** -------------------------------------------------------------------------------------------
 *  Global “class” channel (assignment-agnostic) used to hand students off to another assignment
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
  // Do not return a Promise from react effect cleanup:
  void supabase.removeChannel(ch);
}

/** Student bootstraps this once and will jump to any new assignmentId the teacher selects. */
export function subscribeToGlobal(onSetAssignment: (assignmentId: string) => void) {
  const ch = globalChannel()
    .on('broadcast', { event: 'set-assignment' }, (msg: any) => {
      const id = msg?.payload?.assignmentId;
      if (typeof id === 'string' && id) onSetAssignment(id);
    })
    .subscribe();
  // Return a cleanup that does NOT return a promise
  return () => { void supabase.removeChannel(ch); };
}

/** -------------------------------------------------------------------------------------------
 *  Per-assignment channels
 *  ----------------------------------------------------------------------------------------- */
export function assignmentChannel(assignmentId: string) {
  return supabase.channel(`assignment:${assignmentId}`, {
    config: { broadcast: { ack: true } },
  });
}

/** Helper: allow functions to accept either an assignmentId string OR a RealtimeChannel */
type ChannelOrId = string | RealtimeChannel;
function resolveChannel(input: ChannelOrId): { ch: RealtimeChannel; temporary: boolean } {
  if (typeof input === 'string') {
    const ch = assignmentChannel(input);
    return { ch, temporary: true };       // we'll subscribe/send/remove
  }
  return { ch: input, temporary: false }; // assume already subscribed
}

/** ---------- Low-level publish/subscribe helpers (accept extra args for legacy calls) ---------- */

// SET PAGE
export async function publishSetPage(
  assignment: ChannelOrId,
  payload: SetPagePayload,
  // legacy extra args ignored:
  ..._legacy: any[]
) {
  const { ch, temporary } = resolveChannel(assignment);
  if (temporary) { await ch.subscribe(); }
  await ch.send({ type: 'broadcast', event: 'set-page', payload: { ...payload, ts: Date.now() } });
  if (temporary) { void supabase.removeChannel(ch); }
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
  return () => { void supabase.removeChannel(ch); };
}

// FOCUS
export async function publishFocus(
  assignment: ChannelOrId,
  payload: FocusPayload,
  ..._legacy: any[]
) {
  const { ch, temporary } = resolveChannel(assignment);
  if (temporary) { await ch.subscribe(); }
  await ch.send({ type: 'broadcast', event: 'focus', payload: { ...payload, ts: Date.now() } });
  if (temporary) { void supabase.removeChannel(ch); }
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
  return () => { void supabase.removeChannel(ch); };
}

// AUTO-FOLLOW
export async function publishAutoFollow(
  assignment: ChannelOrId,
  payload: AutoFollowPayload,
  ..._legacy: any[]
) {
  const { ch, temporary } = resolveChannel(assignment);
  if (temporary) { await ch.subscribe(); }
  await ch.send({
    type: 'broadcast',
    event: 'auto-follow',
    payload: { ...payload, ts: Date.now() },
  });
  if (temporary) { void supabase.removeChannel(ch); }
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
  return () => { void supabase.removeChannel(ch); };
}

/** ---------- Presence (legacy-expected by TeacherSyncBar) ---------- */
export async function setTeacherPresence(
  assignment: ChannelOrId,
  state: TeacherPresenceState
) {
  const { ch, temporary } = resolveChannel(assignment);
  if (temporary) { await ch.subscribe(); }
  await ch.send({
    type: 'broadcast',
    event: 'presence',
    payload: { ...state, ts: Date.now() },
  });
  if (temporary) { void supabase.removeChannel(ch); }
}

export function subscribeToPresence(
  assignmentId: string,
  onPayload: (payload: TeacherPresenceState) => void
) {
  const ch = assignmentChannel(assignmentId)
    .on('broadcast', { event: 'presence' }, (msg: any) => {
      const p = msg?.payload as TeacherPresenceState;
      if (!p) return;
      onPayload(p);
    })
    .subscribe();
  return () => { void supabase.removeChannel(ch); };
}

/** ---------- High-level convenience: one call to get all three events ---------- */
type AssignmentHandlers = {
  onSetPage?: (p: SetPagePayload) => void;
  onFocus?: (p: FocusPayload) => void;
  onAutoFollow?: (p: AutoFollowPayload) => void;
  onPresence?: (p: TeacherPresenceState) => void;
};

/**
 * subscribeToAssignment(assignmentId, handlers)
 * Legacy-friendly combined subscription that triggers the given callbacks.
 * Returns the underlying channel with an unsubscribe() companion.
 */
export function subscribeToAssignment(assignmentId: string, handlers: AssignmentHandlers) {
  const ch = assignmentChannel(assignmentId)
    .on('broadcast', { event: 'set-page' }, (msg: any) => {
      handlers.onSetPage?.(msg?.payload as SetPagePayload);
    })
    .on('broadcast', { event: 'focus' }, (msg: any) => {
      handlers.onFocus?.(msg?.payload as FocusPayload);
    })
    .on('broadcast', { event: 'auto-follow' }, (msg: any) => {
      handlers.onAutoFollow?.(msg?.payload as AutoFollowPayload);
    })
    .on('broadcast', { event: 'presence' }, (msg: any) => {
      handlers.onPresence?.(msg?.payload as TeacherPresenceState);
    })
    .subscribe();

  // Provide a void-cleanup instead of returning the Promise to satisfy React types
  (ch as any).unsubscribe = () => { void supabase.removeChannel(ch); };
  return ch;
}
