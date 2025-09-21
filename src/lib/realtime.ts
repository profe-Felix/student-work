// src/lib/realtime.ts
import { supabase } from './supabaseClient';

export function assignmentChannel(assignmentId: string) {
  return supabase.channel(`assign:${assignmentId}`, {
    config: { broadcast: { ack: true }, presence: { key: 'teacher' } },
  });
}

export async function publishSetPage(ch: any, pageId: string, pageIndex: number) {
  await ch.send({ type: 'broadcast', event: 'SET_PAGE', payload: { pageId, pageIndex, ts: Date.now() } });
}

export async function publishAutoFollow(ch: any, on: boolean) {
  await ch.send({ type: 'broadcast', event: 'AUTO_FOLLOW', payload: { on, ts: Date.now() } });
}

export async function publishFocus(ch: any, on: boolean, lockNav = true) {
  await ch.send({ type: 'broadcast', event: 'FOCUS', payload: { on, lockNav, ts: Date.now() } });
}

/** Student-side hook to subscribe to teacher sync */
export function subscribeToAssignment(assignmentId: string, handlers: {
  onSetPage?: (p: {pageId: string; pageIndex: number}) => void;
  onFocus?: (p: {on: boolean; lockNav?: boolean}) => void;
}) {
  const ch = supabase.channel(`assign:${assignmentId}`);
  ch
    .on('broadcast', { event: 'SET_PAGE' }, ({ payload }) => handlers.onSetPage?.(payload))
    .on('broadcast', { event: 'FOCUS' }, ({ payload }) => handlers.onFocus?.(payload))
    .subscribe();
  return ch;
}
