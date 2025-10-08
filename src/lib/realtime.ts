// src/lib/realtime.ts
// Realtime utilities — class-scoped global handoff + legacy compatibility.
// - Global "set-assignment" is class-scoped (so Class A doesn't move Class B)
// - Per-assignment channels keep legacy names (no class in channel) for compatibility
// - All publish* helpers accept either a RealtimeChannel OR ids
// - assignmentChannel is exported (TeacherSyncBar imports it)

import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'

/** ---------- Types ---------- */
export interface SetPagePayload {
  pageId?: string
  pageIndex: number
  ts?: number
}
export interface FocusPayload {
  on: boolean
  lockNav?: boolean
  ts?: number
}
export interface AutoFollowPayload {
  on: boolean
  allowedPages?: number[] | null
  teacherPageIndex?: number
  ts?: number
}
export type TeacherPresenceState = {
  role?: 'teacher'
  autoFollow?: boolean
  allowedPages?: number[] | null
  teacherPageIndex?: number | null
  focusOn?: boolean
  lockNav?: boolean
  ts?: number
  [k: string]: any
}

/** ---------- Live ink updates (pre-submission co-editing) ---------- */
export type InkUpdate = {
  id: string
  color?: string
  size?: number
  tool: 'pen' | 'highlighter' | 'eraser' | 'eraserObject'
  pts?: Array<{ x: number; y: number; t?: number }>
  done?: boolean
  from?: string
  roomKey?: string
}

/** ---------- Channel name helpers ---------- */
// Global (class-scoped) channel for handoff
const globalChan = (cls?: string) => (cls ? `global:${cls}` : 'global-class') // legacy fallback

// Per-assignment channels (KEEP LEGACY NAMES — do not include class so older clients still hear)
const assignmentChan = (assignmentId: string) => `assignment:${assignmentId}`

// Ink rooms (we include class in roomKey so multiple classes don't cross-talk live ink)
const inkChan = (cls: string | undefined, a: string, p: string, s?: string) => {
  const base = cls ? `ink:${cls}:${a}:${p}` : `ink:${a}:${p}` // legacy fallback (no class)
  return s ? `${base}:${s}` : base
}

/** ---------- Small utils ---------- */
function isRealtimeChannel(x: any): x is RealtimeChannel {
  return !!x && typeof x === 'object'
    && typeof x.subscribe === 'function'
    && typeof x.send === 'function'
    && typeof x.unsubscribe === 'function'
}

/** =========================================================================================
 *  GLOBAL (assignment handoff) — class scoped with legacy compatibility
 *  ======================================================================================= */

/**
 * Teacher announces the current assignment for a class.
 *   publishSetAssignment(assignmentId, classCode)   // preferred
 * Legacy:
 *   publishSetAssignment(assignmentId)              // legacy global channel (no class)
 */
export async function publishSetAssignment(assignmentId: string, classCode?: string) {
  const ch = supabase.channel(globalChan(classCode), { config: { broadcast: { ack: true } } })
  await ch.subscribe()
  await ch.send({
    type: 'broadcast',
    event: 'set-assignment',
    payload: { assignmentId, ts: Date.now(), classCode: classCode ?? null },
  })
  void ch.unsubscribe()
}

/**
 * Students listen for assignment handoff.
 *   subscribeToGlobal(classCode, cb)                // preferred
 * Legacy:
 *   subscribeToGlobal(cb)                           // legacy global channel (no class)
 */
export function subscribeToGlobal(a: string | ((id: string) => void), b?: (id: string) => void) {
  const classCode = typeof a === 'string' ? a : undefined
  const handler = (typeof a === 'function' ? a : b) as (id: string) => void
  const ch = supabase
    .channel(globalChan(classCode), { config: { broadcast: { ack: true } } })
    .on('broadcast', { event: 'set-assignment' }, (msg: any) => {
      const id = msg?.payload?.assignmentId
      if (typeof id === 'string' && id) handler(id)
    })
    .subscribe()
  return () => { void ch.unsubscribe() }
}

/** =========================================================================================
 *  PER-ASSIGNMENT (page, focus, auto-follow, presence)
 *  ======================================================================================= */

// Exported so TeacherSyncBar can import/use it directly.
export function assignmentChannel(assignmentId: string): RealtimeChannel
export function assignmentChannel(classCode: string, assignmentId: string): RealtimeChannel
export function assignmentChannel(a: string, b?: string): RealtimeChannel {
  const id = (b ? b : a) // keep legacy: ignore class in channel name for compatibility
  return supabase.channel(assignmentChan(id), { config: { broadcast: { ack: true } } })
}

/** Helper: accept either a RealtimeChannel OR ids */
type ChannelInput =
  | RealtimeChannel
  | string // assignmentId (legacy)
  | { assignmentId: string } // explicit object (optional future use)

async function withChannel<T>(
  input: ChannelInput,
  fn: (ch: RealtimeChannel, temporary: boolean) => Promise<T>
): Promise<T> {
  let ch: RealtimeChannel
  let temporary = false
  if (isRealtimeChannel(input)) {
    ch = input
  } else if (typeof input === 'string') {
    ch = assignmentChannel(input)
    temporary = true
    await ch.subscribe()
  } else {
    ch = assignmentChannel(input.assignmentId)
    temporary = true
    await ch.subscribe()
  }
  try {
    return await fn(ch, temporary)
  } finally {
    if (temporary) { void ch.unsubscribe() }
  }
}

/**
 * subscribeToAssignment(assignmentId, handlers)
 * (kept simple — per-assignment channel without class to preserve compatibility)
 */
export function subscribeToAssignment(
  assignmentId: string,
  handlers: {
    onSetPage?: (p: SetPagePayload) => void
    onFocus?: (p: FocusPayload) => void
    onAutoFollow?: (p: AutoFollowPayload) => void
    onPresence?: (p: TeacherPresenceState) => void
  }
) {
  const ch = assignmentChannel(assignmentId)
    .on('broadcast', { event: 'set-page' }, (msg: any) => handlers.onSetPage?.(msg?.payload))
    .on('broadcast', { event: 'focus' }, (msg: any) => handlers.onFocus?.(msg?.payload))
    .on('broadcast', { event: 'auto-follow' }, (msg: any) => handlers.onAutoFollow?.(msg?.payload))
    .on('broadcast', { event: 'presence' }, (msg: any) => handlers.onPresence?.(msg?.payload))
    .on('broadcast', { event: 'presence-snapshot' }, (msg: any) => handlers.onPresence?.(msg?.payload))
    .subscribe()

  return ch
}

/** ---------- publish/subscribe helpers that accept Channel OR ids ---------- */

// SET PAGE
export async function publishSetPage(
  target: ChannelInput,
  payloadOrPageId: SetPagePayload | number | string,
  maybeIndex?: number
) {
  let payload: SetPagePayload
  if (typeof payloadOrPageId === 'object') {
    payload = payloadOrPageId
  } else if (typeof payloadOrPageId === 'number') {
    payload = { pageIndex: payloadOrPageId }
  } else {
    payload = { pageId: payloadOrPageId, pageIndex: typeof maybeIndex === 'number' ? maybeIndex : 0 }
  }

  await withChannel(target, async (ch) => {
    await ch.send({ type: 'broadcast', event: 'set-page', payload: { ...payload, ts: Date.now() } })
  })
}

// FOCUS
export async function publishFocus(
  target: ChannelInput,
  payloadOrOn: FocusPayload | boolean,
  maybeLockNav?: boolean
) {
  const payload: FocusPayload =
    typeof payloadOrOn === 'boolean'
      ? { on: payloadOrOn, lockNav: !!maybeLockNav }
      : payloadOrOn

  await withChannel(target, async (ch) => {
    await ch.send({ type: 'broadcast', event: 'focus', payload: { ...payload, ts: Date.now() } })
  })
}

// AUTO-FOLLOW
export async function publishAutoFollow(
  target: ChannelInput,
  payloadOrOn: AutoFollowPayload | boolean,
  maybeAllowed?: number[] | null,
  maybeTeacherIdx?: number
) {
  const payload: AutoFollowPayload =
    typeof payloadOrOn === 'boolean'
      ? {
          on: payloadOrOn,
          allowedPages: maybeAllowed ?? null,
          teacherPageIndex: typeof maybeTeacherIdx === 'number' ? maybeTeacherIdx : undefined
        }
      : payloadOrOn

  await withChannel(target, async (ch) => {
    await ch.send({ type: 'broadcast', event: 'auto-follow', payload: { ...payload, ts: Date.now() } })
  })
}

// PRESENCE
export async function setTeacherPresence(
  target: ChannelInput,
  state: TeacherPresenceState
) {
  const payload: TeacherPresenceState = { role: 'teacher', ...state, ts: Date.now() }
  await withChannel(target, async (ch) => {
    await ch.send({ type: 'broadcast', event: 'presence', payload })
  })
}

/** ---------- Presence snapshot responder ---------- */
export type PresenceSnapshot = {
  autoFollow: boolean
  focusOn?: boolean
  lockNav?: boolean
  allowedPages?: number[] | null
  teacherPageIndex?: number
}

export function teacherPresenceResponder(
  assignmentId: string,
  getSnapshot: () => PresenceSnapshot
) {
  const ch = assignmentChannel(assignmentId)

  ch.on('broadcast', { event: 'hello' }, async () => {
    try {
      const snap = getSnapshot?.() ?? {
        autoFollow: false,
        focusOn: false,
        lockNav: false,
        allowedPages: null,
        teacherPageIndex: 0,
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

/** =========================================================================================
 *  INK (page or page+student) — we include class in the roomKey to avoid cross-class echo
 *  ======================================================================================= */

function makeRoomKey(classCode: string | undefined, assignmentId: string, pageId: string, studentCode?: string) {
  return studentCode
    ? `${classCode ?? 'legacy'}:${assignmentId}:${pageId}:${studentCode}`
    : `${classCode ?? 'legacy'}:${assignmentId}:${pageId}`
}

function inkChannel(classCode: string | undefined, assignmentId: string, pageId: string, studentCode?: string) {
  return supabase.channel(inkChan(classCode, assignmentId, pageId, studentCode), {
    config: { broadcast: { ack: true } },
  })
}

/**
 * publishInk({ classCode?, assignmentId, pageId, studentCode? } | RealtimeChannel, update)
 * Legacy rooms (without class) still work if classCode omitted.
 */
export async function publishInk(
  inkChOrIds:
    | RealtimeChannel
    | { classCode?: string; assignmentId: string; pageId: string; studentCode?: string },
  update: InkUpdate
) {
  if (!update || !update.id || !update.tool) return

  let ch: RealtimeChannel | null
  let temporary = false
  let roomKey: string | undefined

  if (isRealtimeChannel(inkChOrIds)) {
    ch = inkChOrIds
  } else {
    const { classCode, assignmentId, pageId, studentCode } = inkChOrIds
    ch = inkChannel(classCode, assignmentId, pageId, studentCode)
    temporary = true
    roomKey = makeRoomKey(classCode, assignmentId, pageId, studentCode)
    await ch.subscribe()
  }

  const payload = roomKey ? { ...update, roomKey } : { ...update }
  await ch.send({ type: 'broadcast', event: 'ink', payload })
  if (temporary) { void ch.unsubscribe() }
}

/**
 * subscribeToInk(classCode, assignmentId, pageId, onUpdate, studentCode?)
 * Legacy:
 *   subscribeToInk(assignmentId, pageId, onUpdate, studentCode?)
 */
export function subscribeToInk(
  a: string,
  b: string | ((u: InkUpdate) => void),
  c: ((u: InkUpdate) => void) | string,
  d?: string
): RealtimeChannel {
  // Detect whether first arg is classCode or assignmentId (legacy)
  const legacy = typeof b === 'string' && typeof c !== 'function'
  const classCode = legacy ? undefined : a
  const assignmentId = legacy ? a : (b as string)
  const pageId = legacy ? (b as string) : (c as any as string)
  const onUpdate = (legacy ? (c as any as (u: InkUpdate) => void) : (d as any as (u: InkUpdate) => void))
  const studentCode = legacy ? d : undefined

  const roomKey = makeRoomKey(classCode, assignmentId, pageId, studentCode)
  const ch = inkChannel(classCode, assignmentId, pageId, studentCode)
    .on('broadcast', { event: 'ink' }, (msg: any) => {
      const u = msg?.payload as InkUpdate
      if (!u || !u.id || !u.tool) return
      if ((!Array.isArray(u.pts) || u.pts.length === 0) && !u.done) return
      if (u.roomKey && u.roomKey !== roomKey) return
      onUpdate(u)
    })
    .subscribe()
  return ch
}
