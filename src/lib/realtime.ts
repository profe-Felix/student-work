// src/lib/realtime.ts
// Realtime utilities (class-scoped with legacy compatibility)

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

/** ---------- Live ink updates ---------- */
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
const globalChan = (cls?: string) => (cls ? `global:${cls}` : 'global-class') // legacy fallback
const assignmentChan = (cls: string | undefined, a: string) =>
  cls ? `assignment:${cls}:${a}` : `assignment:${a}` // legacy fallback
const inkChan = (cls: string | undefined, a: string, p: string, s?: string) => {
  const base = cls ? `ink:${cls}:${a}:${p}` : `ink:${a}:${p}` // legacy fallback
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

/** Teacher announces the current assignment for a class.
 *   publishSetAssignment(classCode, assignmentId)
 * Legacy:
 *   publishSetAssignment(assignmentId)
 */
export async function publishSetAssignment(a: string, b?: string) {
  const classCode = b ? a : undefined
  const assignmentId = b ?? a
  const ch = supabase.channel(globalChan(classCode), { config: { broadcast: { ack: true } } })
  await ch.subscribe()
  await ch.send({
    type: 'broadcast',
    event: 'set-assignment',
    payload: { assignmentId, ts: Date.now() },
  })
  void ch.unsubscribe()
}

/** Students listen for assignment handoff.
 *   subscribeToGlobal(classCode, cb)
 * Legacy:
 *   subscribeToGlobal(cb)
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
 *  PER-ASSIGNMENT (page, focus, auto-follow, presence) — class scoped w/ legacy compatibility
 *  ======================================================================================= */

function assignmentChannel(classCode: string | undefined, assignmentId: string) {
  return supabase.channel(assignmentChan(classCode, assignmentId), { config: { broadcast: { ack: true } } })
}

/** subscribeToAssignment(classCode, assignmentId, handlers)
 *  Legacy: subscribeToAssignment(assignmentId, handlers)
 */
export function subscribeToAssignment(
  a: string,
  b: any,
  c?: {
    onSetPage?: (p: SetPagePayload) => void
    onFocus?: (p: FocusPayload) => void
    onAutoFollow?: (p: AutoFollowPayload) => void
    onPresence?: (p: TeacherPresenceState) => void
  }
) {
  const classCode = c ? a : undefined
  const assignmentId = c ? (b as string) : a
  const handlers = (c ?? b) as {
    onSetPage?: (p: SetPagePayload) => void
    onFocus?: (p: FocusPayload) => void
    onAutoFollow?: (p: AutoFollowPayload) => void
    onPresence?: (p: TeacherPresenceState) => void
  }

  const ch = assignmentChannel(classCode, assignmentId)
    .on('broadcast', { event: 'set-page' }, (msg: any) => handlers.onSetPage?.(msg?.payload))
    .on('broadcast', { event: 'focus' }, (msg: any) => handlers.onFocus?.(msg?.payload))
    .on('broadcast', { event: 'auto-follow' }, (msg: any) => handlers.onAutoFollow?.(msg?.payload))
    .on('broadcast', { event: 'presence' }, (msg: any) => handlers.onPresence?.(msg?.payload))
    .on('broadcast', { event: 'presence-snapshot' }, (msg: any) => handlers.onPresence?.(msg?.payload))
    .subscribe()

  return ch
}

/** publishSetPage(classCode, assignmentId, { pageIndex })
 *  Legacy: publishSetPage(assignmentId, { pageIndex }) / publishSetPage(assignmentId, pageIndex)
 */
export async function publishSetPage(
  a: string,
  b: any,
  c?: SetPagePayload | number | string
) {
  const classCode = c !== undefined ? a : undefined
  const assignmentId = c !== undefined ? (b as string) : a
  const payloadOrIndex = (c !== undefined ? c : b) as SetPagePayload | number | string

  let payload: SetPagePayload
  if (typeof payloadOrIndex === 'object') {
    payload = payloadOrIndex
  } else if (typeof payloadOrIndex === 'number') {
    payload = { pageIndex: payloadOrIndex }
  } else {
    payload = { pageId: payloadOrIndex, pageIndex: 0 }
  }

  const ch = assignmentChannel(classCode, assignmentId)
  await ch.subscribe()
  await ch.send({ type: 'broadcast', event: 'set-page', payload: { ...payload, ts: Date.now() } })
  void ch.unsubscribe()
}

/** publishFocus(classCode, assignmentId, payload)
 *  Legacy: publishFocus(assignmentId, payloadOrBoolean)
 */
export async function publishFocus(
  a: string,
  b: any,
  c?: FocusPayload | boolean,
  d?: boolean
) {
  const classCode = c !== undefined ? a : undefined
  const assignmentId = c !== undefined ? (b as string) : a
  const payloadOrOn = (c !== undefined ? c : b) as FocusPayload | boolean
  const maybeLock = d

  const payload: FocusPayload =
    typeof payloadOrOn === 'boolean'
      ? { on: payloadOrOn, lockNav: !!maybeLock }
      : payloadOrOn

  const ch = assignmentChannel(classCode, assignmentId)
  await ch.subscribe()
  await ch.send({ type: 'broadcast', event: 'focus', payload: { ...payload, ts: Date.now() } })
  void ch.unsubscribe()
}

/** publishAutoFollow(classCode, assignmentId, payload)
 *  Legacy: publishAutoFollow(assignmentId, payloadOrBoolean, allowed?, teacherIdx?)
 */
export async function publishAutoFollow(
  a: string,
  b: any,
  c?: AutoFollowPayload | boolean,
  d?: number[] | null,
  e?: number
) {
  const classCode = c !== undefined ? a : undefined
  const assignmentId = c !== undefined ? (b as string) : a
  const payloadOrOn = (c !== undefined ? c : b) as AutoFollowPayload | boolean
  const maybeAllowed = d
  const maybeTeacherIdx = e

  const payload: AutoFollowPayload =
    typeof payloadOrOn === 'boolean'
      ? {
          on: payloadOrOn,
          allowedPages: maybeAllowed ?? null,
          teacherPageIndex: typeof maybeTeacherIdx === 'number' ? maybeTeacherIdx : undefined
        }
      : payloadOrOn

  const ch = assignmentChannel(classCode, assignmentId)
  await ch.subscribe()
  await ch.send({ type: 'broadcast', event: 'auto-follow', payload: { ...payload, ts: Date.now() } })
  void ch.unsubscribe()
}

/** setTeacherPresence(classCode, assignmentId, snapshot)
 *  Legacy: setTeacherPresence(assignmentId, snapshot)
 */
export async function setTeacherPresence(
  a: string,
  b: any,
  c?: TeacherPresenceState
) {
  const classCode = c ? a : undefined
  const assignmentId = c ? (b as string) : a
  const state = (c ?? b) as TeacherPresenceState

  const ch = assignmentChannel(classCode, assignmentId)
  await ch.subscribe()
  const payload: TeacherPresenceState = { role: 'teacher', ...state, ts: Date.now() }
  await ch.send({ type: 'broadcast', event: 'presence', payload })
  void ch.unsubscribe()
}

/** teacherPresenceResponder(classCode, assignmentId, getSnapshot)
 *  Legacy: teacherPresenceResponder(assignmentId, getSnapshot)
 */
export function teacherPresenceResponder(
  a: string,
  b: any,
  c?: () => {
    autoFollow: boolean
    focusOn?: boolean
    lockNav?: boolean
    allowedPages?: number[] | null
    teacherPageIndex?: number
  }
) {
  const classCode = c ? a : undefined
  const assignmentId = c ? (b as string) : a
  const getSnapshot = (c ?? b) as () => {
    autoFollow: boolean
    focusOn?: boolean
    lockNav?: boolean
    allowedPages?: number[] | null
    teacherPageIndex?: number
  }

  const ch = assignmentChannel(classCode, assignmentId)
  ch.on('broadcast', { event: 'hello' }, async () => {
    try {
      const snap = getSnapshot?.() ?? {
        autoFollow: false, focusOn: false, lockNav: false, allowedPages: null, teacherPageIndex: 0
      }
      await ch.send({ type: 'broadcast', event: 'presence-snapshot', payload: { ...snap, ts: Date.now() } })
    } catch { /* ignore */ }
  })
  ch.subscribe()
  return () => { void ch.unsubscribe() }
}

/** =========================================================================================
 *  INK (page or page+student) — class added to room names for isolation
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

/** publishInk({ classCode?, assignmentId, pageId, studentCode? } | RealtimeChannel, update)
 *  Legacy rooms (without class) still work if classCode omitted.
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

/** subscribeToInk — now supports object form (Option A) + legacy signatures.
 *
 * Object form:
 *   subscribeToInk({ classCode?, assignmentId, pageId, studentCode? }, onUpdate)
 *
 * Class-scoped positional:
 *   subscribeToInk(classCode, assignmentId, pageId, onUpdate)
 *
 * Legacy (no class in room name):
 *   subscribeToInk(assignmentId, pageId, onUpdate, studentCode?)
 */
export function subscribeToInk(
  ids: { classCode?: string; assignmentId: string; pageId: string; studentCode?: string },
  onUpdate: (u: InkUpdate) => void
): RealtimeChannel
export function subscribeToInk(
  classCode: string,
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
export function subscribeToInk(a: any, b?: any, c?: any, d?: any): RealtimeChannel {
  // ---- Object form (Option A)
  if (typeof a === 'object' && a && 'assignmentId' in a) {
    const { classCode, assignmentId, pageId, studentCode } =
      a as { classCode?: string; assignmentId: string; pageId: string; studentCode?: string }
    const onUpdate = b as (u: InkUpdate) => void

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

  // ---- Positional handling (kept for compatibility)
  let classCode: string | undefined
  let assignmentId: string
  let pageId: string
  let onUpdate: (u: InkUpdate) => void
  let studentCode: string | undefined

  // 4 args => (classCode, assignmentId, pageId, onUpdate)
  if (typeof d === 'function' && typeof a === 'string' && typeof b === 'string' && typeof c === 'string') {
    classCode = a
    assignmentId = b
    pageId = c
    onUpdate = d
  } else if (typeof c === 'function' && typeof a === 'string' && typeof b === 'string') {
    // 3 args => legacy (assignmentId, pageId, onUpdate) [no classCode]
    classCode = undefined
    assignmentId = a
    pageId = b
    onUpdate = c
  } else if (typeof c === 'string' && typeof b === 'string' && typeof d !== 'string' && typeof d !== 'function') {
    // defensive no-op path
    throw new Error('subscribeToInk: invalid arguments')
  } else {
    // Fallback to previous heuristic (rare edge cases)
    const isLegacy = typeof b === 'string' && typeof c === 'function'
    classCode = isLegacy ? undefined : a
    assignmentId = isLegacy ? a : b
    pageId = isLegacy ? (c as any) : c
    onUpdate = (isLegacy ? d : d) || (typeof c === 'function' ? c : (() => {}))
    if (typeof onUpdate !== 'function') throw new Error('subscribeToInk: onUpdate must be a function')
  }

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
