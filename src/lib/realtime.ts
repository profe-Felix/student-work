// src/lib/realtime.ts
// Realtime utilities: legacy-compatible + global assignment handoff.
// - Accept either assignmentId (string) or a RealtimeChannel for publish* helpers
// - Accept loose/legacy param shapes (booleans, numbers, strings)
// - Cleanups use ch.unsubscribe() only (no removeChannel recursion)

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
  role?: 'teacher';                 // optional; default set in setTeacherPresence()
  autoFollow?: boolean;
  allowedPages?: number[] | null;
  teacherPageIndex?: number | null;
  focusOn?: boolean;                // some callers include this in presence
  lockNav?: boolean;                // some callers include this too
  ts?: number;
  [k: string]: any;                 // tolerate unknown legacy fields
};

/** ---------- NEW: Live ink updates (pre-submission co-editing) ---------- */
export type InkUpdate = {
  id: string
  color?: string
  size?: number
  tool: 'pen' | 'highlighter' | 'eraser' | 'eraserObject'
  pts?: Array<{ x: number; y: number; t?: number }>
  done?: boolean
  // optional echo-guard field
  from?: string
  // optional room guard (assignment:page[:studentCode])
  roomKey?: string
}

/** -------------------------------------------------------------------------------------------
 *  Global “class” channel (assignment-agnostic) used to hand students off to another assignment
 *  ----------------------------------------------------------------------------------------- */
export function globalChannel() {
  return supabase.channel('global-class', { config: { broadcast: { ack: true } } })
}

/** Teacher fires this when changing the assignment dropdown. */
export async function publishSetAssignment(assignmentId: string) {
  const ch = globalChannel()
  await ch.subscribe()
  await ch.send({
    type: 'broadcast',
    event: 'set-assignment',
    payload: { assignmentId, ts: Date.now() },
  })
  void ch.unsubscribe()
}

/** Student bootstraps this once and will jump to any new assignmentId the teacher selects. */
export function subscribeToGlobal(onSetAssignment: (assignmentId: string) => void) {
  const ch = globalChannel()
    .on('broadcast', { event: 'set-assignment' }, (msg: any) => {
      const id = msg?.payload?.assignmentId
      if (typeof id === 'string' && id) onSetAssignment(id)
    })
    .subscribe()
  return () => { void ch.unsubscribe() }
}

/** -------------------------------------------------------------------------------------------
 *  Per-assignment channels
 *  ----------------------------------------------------------------------------------------- */
export function assignmentChannel(assignmentId: string) {
  return supabase.channel(`assignment:${assignmentId}`, { config: { broadcast: { ack: true } } })
}

/** ---------- NEW: Room helpers for ink ---------- */
function makeRoomKey(assignmentId: string, pageId: string, studentCode?: string) {
  return studentCode ? `${assignmentId}:${pageId}:${studentCode}` : `${assignmentId}:${pageId}`
}

function makeInkChannelName(assignmentId: string, pageId: string, studentCode?: string) {
  const base = `ink:${assignmentId}:${pageId}`
  return studentCode ? `${base}:${studentCode}` : base
}

/** Per-(assignment,page[,studentCode]) ink channel.
 *  If studentCode is provided, ink is isolated to that *student instance*.
 *  If omitted, it falls back to per-page channel (A_04 sees only A_04).
 */
export function inkChannel(assignmentId: string, pageId: string, studentCode?: string) {
  return supabase.channel(makeInkChannelName(assignmentId, pageId, studentCode), {
    config: { broadcast: { ack: true } },
  })
}

// Type guard for channels
function isRealtimeChannel(x: any): x is RealtimeChannel {
  return !!x && typeof x === 'object'
    && typeof x.subscribe === 'function'
    && typeof x.send === 'function'
    && typeof x.unsubscribe === 'function'
}

/** Helper: allow functions to accept either an assignmentId string OR a RealtimeChannel */
type ChannelOrId = string | RealtimeChannel
function resolveChannel(input: ChannelOrId): { ch: RealtimeChannel; temporary: boolean } {
  if (typeof input === 'string') {
    const ch = assignmentChannel(input)
    return { ch, temporary: true }       // we'll subscribe/send/unsubscribe
  }
  return { ch: input, temporary: false } // assume caller manages the channel
}

/** ---------- Low-level publish/subscribe helpers (very permissive for legacy calls) ---------- */

// SET PAGE
export async function publishSetPage(
  assignment: ChannelOrId,
  payloadOrPageId: SetPagePayload | number | string,
  maybeIndex?: number,
  ..._legacy: any[]
) {
  let payload: SetPagePayload
  if (typeof payloadOrPageId === 'object') {
    payload = payloadOrPageId as SetPagePayload
  } else if (typeof payloadOrPageId === 'number') {
    payload = { pageIndex: payloadOrPageId }
  } else {
    payload = { pageId: payloadOrPageId, pageIndex: typeof maybeIndex === 'number' ? maybeIndex : 0 }
  }

  const { ch, temporary } = resolveChannel(assignment)
  if (temporary) { await ch.subscribe() }
  await ch.send({ type: 'broadcast', event: 'set-page', payload: { ...payload, ts: Date.now() } })
  if (temporary) { void ch.unsubscribe() }
}

export function subscribeToSetPage(
  assignmentId: string,
  onPayload: (payload: SetPagePayload) => void
) {
  const ch = assignmentChannel(assignmentId)
    .on('broadcast', { event: 'set-page' }, (msg: any) => {
      const p = msg?.payload as SetPagePayload
      if (!p) return
      onPayload(p)
    })
    .subscribe()
  return () => { void ch.unsubscribe() }
}

// FOCUS
export async function publishFocus(
  assignment: ChannelOrId,
  payloadOrOn: FocusPayload | boolean,
  maybeLockNav?: boolean,
  ..._legacy: any[]
) {
  const payload: FocusPayload =
    typeof payloadOrOn === 'boolean'
      ? { on: payloadOrOn, lockNav: !!maybeLockNav }
      : (payloadOrOn as FocusPayload)

  const { ch, temporary } = resolveChannel(assignment)
  if (temporary) { await ch.subscribe() }
  await ch.send({ type: 'broadcast', event: 'focus', payload: { ...payload, ts: Date.now() } })
  if (temporary) { void ch.unsubscribe() }
}

export function subscribeToFocus(
  assignmentId: string,
  onPayload: (payload: FocusPayload) => void
) {
  const ch = assignmentChannel(assignmentId)
    .on('broadcast', { event: 'focus' }, (msg: any) => {
      const p = msg?.payload as FocusPayload
      if (!p) return
      onPayload(p)
    })
    .subscribe()
  return () => { void ch.unsubscribe() }
}

// AUTO-FOLLOW
export async function publishAutoFollow(
  assignment: ChannelOrId,
  payloadOrOn: AutoFollowPayload | boolean,
  maybeAllowed?: number[] | null,
  maybeTeacherIdx?: number,
  ..._legacy: any[]
) {
  const payload: AutoFollowPayload =
    typeof payloadOrOn === 'boolean'
      ? { on: payloadOrOn, allowedPages: maybeAllowed ?? null, teacherPageIndex: typeof maybeTeacherIdx === 'number' ? maybeTeacherIdx : undefined }
      : (payloadOrOn as AutoFollowPayload)

  const { ch, temporary } = resolveChannel(assignment)
  if (temporary) { await ch.subscribe() }
  await ch.send({ type: 'broadcast', event: 'auto-follow', payload: { ...payload, ts: Date.now() } })
  if (temporary) { void ch.unsubscribe() }
}

export function subscribeToAutoFollow(
  assignmentId: string,
  onPayload: (payload: AutoFollowPayload) => void
) {
  const ch = assignmentChannel(assignmentId)
    .on('broadcast', { event: 'auto-follow' }, (msg: any) => {
      const p = msg?.payload as AutoFollowPayload
      if (!p) return
      onPayload(p)
    })
    .subscribe()
  return () => { void ch.unsubscribe() }
}

/** ---------- Presence (legacy-expected by TeacherSyncBar) ---------- */
export async function setTeacherPresence(
  assignment: ChannelOrId,
  state: TeacherPresenceState
) {
  const { ch, temporary } = resolveChannel(assignment)
  if (temporary) { await ch.subscribe() }
  const payload: TeacherPresenceState = {
    role: 'teacher',
    ...state,
    ts: Date.now(),
  }
  await ch.send({ type: 'broadcast', event: 'presence', payload })
  if (temporary) { void ch.unsubscribe() }
}

export function subscribeToPresence(
  assignmentId: string,
  onPayload: (payload: TeacherPresenceState) => void
) {
  const ch = assignmentChannel(assignmentId)
    .on('broadcast', { event: 'presence' }, (msg: any) => {
      const p = msg?.payload as TeacherPresenceState
      if (!p) return
      onPayload(p)
    })
    .subscribe()
  return () => { void ch.unsubscribe() }
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
 * Returns the underlying channel (caller can .unsubscribe() when done).
 */
export function subscribeToAssignment(assignmentId: string, handlers: AssignmentHandlers) {
  const ch = assignmentChannel(assignmentId)
    .on('broadcast', { event: 'set-page' }, (msg: any) => handlers.onSetPage?.(msg?.payload))
    .on('broadcast', { event: 'focus' }, (msg: any) => handlers.onFocus?.(msg?.payload))
    .on('broadcast', { event: 'auto-follow' }, (msg: any) => handlers.onAutoFollow?.(msg?.payload))
    .on('broadcast', { event: 'presence' }, (msg: any) => handlers.onPresence?.(msg?.payload))
    .subscribe()

  return ch
}

/** ---------- NEW: Ink publish/subscribe helpers (SCOPED) ---------- */
/**
 * Publish a live ink update into a room.
 * Accepts either:
 *   - a RealtimeChannel created by inkChannel(assignmentId, pageId, studentCode)
 *   - an ids object: { assignmentId, pageId, studentCode? }
 *
 * If studentCode is provided, the event goes only to that *student instance* room.
 * If omitted, it falls back to per-(assignment,page) room.
 */
export async function publishInk(
  inkChOrIds: RealtimeChannel | { assignmentId: string; pageId: string; studentCode?: string },
  update: InkUpdate
) {
  if (!update || !update.id || !update.tool) return

  let ch: RealtimeChannel | null
  let temporary = false
  let roomKey: string | undefined

  if (isRealtimeChannel(inkChOrIds)) {
    ch = inkChOrIds
  } else {
    const { assignmentId, pageId, studentCode } = inkChOrIds
    ch = inkChannel(assignmentId, pageId, studentCode)
    temporary = true
    roomKey = makeRoomKey(assignmentId, pageId, studentCode)
    await ch.subscribe()
  }

  const payload = roomKey ? { ...update, roomKey } : { ...update }
  await ch.send({ type: 'broadcast', event: 'ink', payload })
  if (temporary) { void ch.unsubscribe() }
}

/**
 * Subscribe to an ink stream for a page (and optionally studentCode).
 * Overloads keep legacy callers working:
 *   subscribeToInk(assignmentId, pageId, onUpdate)                  // per page
 *   subscribeToInk(assignmentId, pageId, onUpdate, studentCode)     // per student instance
 */
export function subscribeToInk(
  assignmentId: string,
  pageId: string,
  onUpdate: (u: InkUpdate) => void
): RealtimeChannel
export function subscribeToInk(
  assignmentId: string,
  pageId: string,
  onUpdate: (u: InkUpdate) => void,
  studentCode?: string
): RealtimeChannel
export function subscribeToInk(
  assignmentId: string,
  pageId: string,
  onUpdate: (u: InkUpdate) => void,
  studentCode?: string
) {
  const roomKey = makeRoomKey(assignmentId, pageId, studentCode)
  const ch = inkChannel(assignmentId, pageId, studentCode)
    .on('broadcast', { event: 'ink' }, (msg: any) => {
      const u = msg?.payload as InkUpdate
      if (!u || !u.id || !u.tool) return
      // allow empty pts if this is a terminal "done" update
      if ((!Array.isArray(u.pts) || u.pts.length === 0) && !u.done) return
      // Guard against stragglers from other rooms (in case of late events)
      if (u.roomKey && u.roomKey !== roomKey) return
      onUpdate(u)
    })
    .subscribe()
  return ch
}

// --- Presence responder: teacher answers "hello" with a presence snapshot ---
export type PresenceSnapshot = {
  autoFollow: boolean;
  focusOn?: boolean;
  lockNav?: boolean;
  allowedPages?: number[] | null;
  teacherPageIndex?: number;
};

export function teacherPresenceResponder(
  assignmentId: string,
  getSnapshot: () => PresenceSnapshot
) {
  const ch = assignmentChannel(assignmentId);

  ch.on('broadcast', { event: 'hello' }, async () => {
    try {
      const snap = getSnapshot?.() ?? {
        autoFollow: false,
        focusOn: false,
        lockNav: false,
        allowedPages: null,
        teacherPageIndex: 0,
      };
      await ch.send({
        type: 'broadcast',
        event: 'presence-snapshot',
        payload: { ...snap, ts: Date.now() },
      });
    } catch {
      // ignore errors; channel may be closing or snapshot unavailable
    }
  });

  ch.subscribe();
  return () => { void ch.unsubscribe(); };
}
