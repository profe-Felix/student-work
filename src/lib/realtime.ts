//  src/lib/realtime.ts
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
  pdfPath?: string;        // include so students can render immediately without DB reads
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
  role?: 'teacher';
  autoFollow?: boolean;
  allowedPages?: number[] | null;
  teacherPageIndex?: number | null;
  focusOn?: boolean;
  lockNav?: boolean;
  ts?: number;
  [k: string]: any;
};

/** ---------- Live ink updates (pre-submission co-editing) ---------- */
export type InkUpdate = {
  id: string
  color?: string
  size?: number
  tool: 'pen' | 'highlighter' | 'eraser' | 'eraserObject'
  pts?: Array<{ x: number; y: number; t?: number }>
  done?: boolean
  from?: string
}

/** -------------------------------------------------------------------------------------------
 *  Global “class” channel (assignment-agnostic) used to hand students off to another assignment
 *  ----------------------------------------------------------------------------------------- */
export function globalChannel() {
  // IMPORTANT: ack:false -> use WebSocket broadcast (no REST => no CORS) and self:false to avoid echo
  return supabase.channel('global-class', { config: { broadcast: { ack: false, self: false } } })
}

/** Teacher fires this when changing the assignment dropdown. */
export async function publishSetAssignment(assignmentId: string) {
  if (!assignmentId) return
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

/** ---------- Student asks; teacher answers (late join autosync) ---------- */
/** Student: request the current assignment on the global channel */
export async function requestAssignment() {
  const ch = globalChannel()
  await ch.subscribe()
  await ch.send({
    type: 'broadcast',
    event: 'request-assignment',
    payload: { ts: Date.now() }
  })
  void ch.unsubscribe()
}

/** Teacher: respond to 'request-assignment' by re-broadcasting current assignmentId */
export function respondToAssignmentRequests(getAssignmentId: () => string) {
  const ch = globalChannel()
    .on('broadcast', { event: 'request-assignment' }, async () => {
      const id = (getAssignmentId?.() || '').trim()
      if (!id) return
      try {
        await ch.send({
          type: 'broadcast',
          event: 'set-assignment',
          payload: { assignmentId: id, ts: Date.now() },
        })
      } catch { /* ignore */ }
    })
    .subscribe()
  return () => { void ch.unsubscribe() }
}

/** -------------------------------------------------------------------------------------------
 *  Per-assignment channels
 *  ----------------------------------------------------------------------------------------- */
export function assignmentChannel(assignmentId: string) {
  return supabase.channel(`assignment:${assignmentId}`, { config: { broadcast: { ack: false, self: false } } })
}

/** ---------- Per-(assignment,page) ink channel ---------- */
export function inkChannel(assignmentId: string, pageId: string) {
  return supabase.channel(`ink:${assignmentId}:${pageId}`, { config: { broadcast: { ack: false, self: false } } })
}

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
    return { ch, temporary: true }
  }
  return { ch: input, temporary: false }
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

export function subscribeToAssignment(assignmentId: string, handlers: AssignmentHandlers) {
  const ch = assignmentChannel(assignmentId)
    .on('broadcast', { event: 'set-page' }, (msg: any) => handlers.onSetPage?.(msg?.payload))
    .on('broadcast', { event: 'focus' }, (msg: any) => handlers.onFocus?.(msg?.payload))
    .on('broadcast', { event: 'auto-follow' }, (msg: any) => handlers.onAutoFollow?.(msg?.payload))
    .on('broadcast', { event: 'presence' }, (msg: any) => handlers.onPresence?.(msg?.payload))
    .subscribe()
  return ch // caller may ch.unsubscribe()
}

/** ---------- Ink publish/subscribe helpers ---------- */
export async function publishInk(
  inkChOrIds: RealtimeChannel | { assignmentId: string; pageId: string },
  update: InkUpdate
) {
  if (!update || !update.id || !update.tool) return
  let ch: RealtimeChannel | null
  let temporary = false

  if (isRealtimeChannel(inkChOrIds)) {
    ch = inkChOrIds
  } else {
    const { assignmentId, pageId } = inkChOrIds
    ch = inkChannel(assignmentId, pageId)
    temporary = true
    await ch.subscribe()
  }

  await ch.send({ type: 'broadcast', event: 'ink', payload: { ...update } })
  if (temporary) { void ch.unsubscribe() }
}

export function subscribeToInk(
  assignmentId: string,
  pageId: string,
  onUpdate: (u: InkUpdate) => void
) {
  const ch = inkChannel(assignmentId, pageId)
    .on('broadcast', { event: 'ink' }, (msg: any) => {
      const u = msg?.payload as InkUpdate
      if (!u || !u.id || !u.tool) return
      if ((!Array.isArray(u.pts) || u.pts.length === 0) && !u.done) return
      onUpdate(u)
    })
    .subscribe()
  return ch
}

// --- Presence responder: teacher answers "hello" with a presence snapshot ---
// Include page/pdf so students can hydrate immediately.
export type PresenceSnapshot = {
  assignmentId?: string;
  pageId?: string;
  pdfPath?: string;
  autoFollow?: boolean;
  focusOn?: boolean;
  lockNav?: boolean;
  allowedPages?: number[] | null;
  teacherPageIndex?: number;
};

export function teacherPresenceResponder(
  assignmentId: string,
  getSnapshot: () => PresenceSnapshot
) {
  const ch = assignmentChannel(assignmentId)
  ch.on('broadcast', { event: 'hello' }, async () => {
    try {
      const base = getSnapshot?.() ?? {}
      const snap: PresenceSnapshot = {
        assignmentId,                   // always include—helps students persist cache
        autoFollow: !!base.autoFollow,
        focusOn: !!base.focusOn,
        lockNav: !!base.lockNav,
        allowedPages: base.allowedPages ?? null,
        teacherPageIndex: typeof base.teacherPageIndex === 'number' ? base.teacherPageIndex : 0,
        pageId: base.pageId,
        pdfPath: base.pdfPath,
      }
      await ch.send({
        type: 'broadcast',
        event: 'presence-snapshot',
        payload: { ...snap, ts: Date.now() },
      })
    } catch { /* ignore */ }
  })
  ch.subscribe()
  return () => { void ch.unsubscribe() }
}

// --- Ink (live stroke) helpers ------------------------------------------------
export function inkChannelKey(assignmentId: string, pageId: string) {
  return `ink:${assignmentId}:${pageId}`
}
export function openInkChannel(assignmentId: string, pageId: string) {
  // IMPORTANT: ack:false here too
  return supabase.channel(inkChannelKey(assignmentId, pageId), { config: { broadcast: { ack: false, self: false } } })
}

// --- Student "hello" -> Teacher presence snapshot handshake -------------------
export function subscribePresenceSnapshot(
  assignmentId: string,
  onSnapshot: (p: TeacherPresenceState) => void
) {
  const ch = assignmentChannel(assignmentId)
    .on('broadcast', { event: 'presence-snapshot' }, (msg: any) => {
      const p = msg?.payload as TeacherPresenceState
      if (p) onSnapshot(p)
    })
    .subscribe()
  return () => { void ch.unsubscribe() }
}

export async function studentHello(assignmentId: string) {
  const ch = assignmentChannel(assignmentId)
  await ch.subscribe()
  await ch.send({ type: 'broadcast', event: 'hello', payload: { ts: Date.now() } })
  void ch.unsubscribe()
}

/** -------------------------------------------------------------------------------------------
 *  CONTROL CHANNEL: simple, live-strokes-style broadcast for teacher → all students
 *  Everyone subscribes to control:all. Teacher broadcasts here in addition to assignment channel.
 *  Events: set-assignment, set-page, focus, auto-follow, presence
 *  ----------------------------------------------------------------------------------------- */

type ControlHandlers = {
  onSetAssignment?: (assignmentId: string) => void;
  onSetPage?: (p: SetPagePayload) => void;
  onFocus?: (p: FocusPayload) => void;
  onAutoFollow?: (p: AutoFollowPayload) => void;
  onPresence?: (p: TeacherPresenceState) => void;
};

export function controlAllChannel() {
  return supabase.channel('control:all', { config: { broadcast: { ack: false, self: false } } })
}

/** Student: subscribe once, apply teacher commands immediately (no assignment needed). */
export function subscribeToControl(handlers: ControlHandlers) {
  const ch = controlAllChannel()
    .on('broadcast', { event: 'set-assignment' }, (msg: any) => {
      const id = msg?.payload?.assignmentId
      if (typeof id === 'string' && id) handlers.onSetAssignment?.(id)
    })
    .on('broadcast', { event: 'set-page' }, (msg: any) => {
      const p = msg?.payload as SetPagePayload
      if (p && typeof p.pageIndex === 'number') handlers.onSetPage?.(p)
    })
    .on('broadcast', { event: 'focus' }, (msg: any) => {
      const p = msg?.payload as FocusPayload
      if (p) handlers.onFocus?.(p)
    })
    .on('broadcast', { event: 'auto-follow' }, (msg: any) => {
      const p = msg?.payload as AutoFollowPayload
      if (p) handlers.onAutoFollow?.(p)
    })
    .on('broadcast', { event: 'presence' }, (msg: any) => {
      const p = msg?.payload as TeacherPresenceState
      if (p) handlers.onPresence?.(p)
    })
    .subscribe()

  return () => { void ch.unsubscribe() }
}

/** Teacher: broadcast to control:all (mirrors the per-assignment messages you already send). */
export async function controlSetAssignment(assignmentId: string) {
  if (!assignmentId) return
  const ch = controlAllChannel()
  await ch.subscribe()
  await ch.send({ type: 'broadcast', event: 'set-assignment', payload: { assignmentId, ts: Date.now() } })
  void ch.unsubscribe()
}
export async function controlSetPage(payload: SetPagePayload) {
  const ch = controlAllChannel()
  await ch.subscribe()
  await ch.send({ type: 'broadcast', event: 'set-page', payload: { ...payload, ts: Date.now() } })
  void ch.unsubscribe()
}
export async function controlFocus(payload: FocusPayload) {
  const ch = controlAllChannel()
  await ch.subscribe()
  await ch.send({ type: 'broadcast', event: 'focus', payload: { ...payload, ts: Date.now() } })
  void ch.unsubscribe()
}
export async function controlAutoFollow(payload: AutoFollowPayload) {
  const ch = controlAllChannel()
  await ch.subscribe()
  await ch.send({ type: 'broadcast', event: 'auto-follow', payload: { ...payload, ts: Date.now() } })
  void ch.unsubscribe()
}
export async function controlPresence(payload: TeacherPresenceState) {
  const ch = controlAllChannel()
  await ch.subscribe()
  await ch.send({ type: 'broadcast', event: 'presence', payload: { ...payload, ts: Date.now() } })
  void ch.unsubscribe()
}
