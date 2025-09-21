// src/lib/realtime.ts
import { supabase } from './supabaseClient';

export interface SetPagePayload {
  pageId: string;
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
  ts?: number;
}

/**
 * Create a realtime channel for a specific assignment.
 * Channel name is stable so teacher + all students join the same room.
 */
export function assignmentChannel(assignmentId: string) {
  return supabase.channel(`assign:${assignmentId}`, {
    config: { broadcast: { ack: true }, presence: { key: 'user' } },
  });
}

/** Teacher → broadcast a one-time page sync */
export async function publishSetPage(ch: any, pageId: string, pageIndex: number) {
  const payload: SetPagePayload = { pageId, pageIndex, ts: Date.now() };
  await ch.send({ type: 'broadcast', event: 'SET_PAGE', payload });
}

/** Teacher → broadcast auto-follow on/off (students may ignore if unused) */
export async function publishAutoFollow(ch: any, on: boolean) {
  const payload: AutoFollowPayload = { on, ts: Date.now() };
  await ch.send({ type: 'broadcast', event: 'AUTO_FOLLOW', payload });
}

/** Teacher → broadcast focus mode (optionally lock student navigation) */
export async function publishFocus(ch: any, on: boolean, lockNav = true) {
  const payload: FocusPayload = { on, lockNav, ts: Date.now() };
  await ch.send({ type: 'broadcast', event: 'FOCUS', payload });
}

/**
 * Student → subscribe to teacher events for an assignment.
 * Returns the live channel; caller should keep a ref and unsubscribe on unmount.
 */
export function subscribeToAssignment(
  assignmentId: string,
  handlers: {
    onSetPage?: (p: SetPagePayload) => void;
    onFocus?: (p: FocusPayload) => void;
    onAutoFollow?: (p: AutoFollowPayload) => void;
  }
) {
  const ch = assignmentChannel(assignmentId);

  ch
    .on('broadcast', { event: 'SET_PAGE' }, ({ payload }) => {
      handlers.onSetPage?.(payload as SetPagePayload);
    })
    .on('broadcast', { event: 'FOCUS' }, ({ payload }) => {
      handlers.onFocus?.(payload as FocusPayload);
    })
    .on('broadcast', { event: 'AUTO_FOLLOW' }, ({ payload }) => {
      handlers.onAutoFollow?.(payload as AutoFollowPayload);
    })
    .subscribe();

  return ch;
}

/** Helper to safely leave a channel across SDK versions */
export function unsubscribeChannel(ch: any) {
  if (!ch) return;
  if (typeof ch.unsubscribe === 'function') {
    ch.unsubscribe();
  } else if (typeof (supabase as any).removeChannel === 'function') {
    (supabase as any).removeChannel(ch);
  }
}
