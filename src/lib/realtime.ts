//  src/lib/realtime.ts
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

export function assignmentChannel(assignmentId: string) {
  return supabase.channel(`assign:${assignmentId}`, {
    config: { broadcast: { ack: true }, presence: { key: 'teacher' } },
  });
}

export async function publishSetPage(ch: any, pageId: string, pageIndex: number) {
  const payload: SetPagePayload = { pageId, pageIndex, ts: Date.now() };
  await ch.send({ type: 'broadcast', event: 'SET_PAGE', payload });
}

export async function publishAutoFollow(ch: any, on: boolean) {
  await ch.send({ type: 'broadcast', event: 'AUTO_FOLLOW', payload: { on, ts: Date.now() } });
}

export async function publishFocus(ch: any, on: boolean, lockNav = true) {
  const payload: FocusPayload = { on, lockNav, ts: Date.now() };
  await ch.send({ type: 'broadcast', event: 'FOCUS', payload });
}

export function subscribeToAssignment(
  assignmentId: string,
  handlers: {
    onSetPage?: (p: SetPagePayload) => void;
    onFocus?: (p: FocusPayload) => void;
  }
) {
  const ch = supabase.channel(`assign:${assignmentId}`);
  ch
    .on('broadcast', { event: 'SET_PAGE' }, ({ payload }) => handlers.onSetPage?.(payload as SetPagePayload))
    .on('broadcast', { event: 'FOCUS' }, ({ payload }) => handlers.onFocus?.(payload as FocusPayload))
    .subscribe();
  return ch;
}
