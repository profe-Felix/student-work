// src/lib/realtime.ts
// Realtime utilities (class-scoped with legacy compatibility) — low-traffic edition
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'

/** ---------- Types (unchanged) ---------- */
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
export type ForceSubmitPayload = {
  reason: 'teacher-button' | 'page-change'
  pageIndex?: number
  studentId?: string
  ts?: number
}

/** ---------- Live ink shapes (kept for compatibility) ---------- */
export type InkPoint = { x: number; y: number; t?: number }
export type InkUpdate = {
  id: string
  color?: string
  size?: number
  tool: 'pen' | 'highlighter' | 'eraser' | 'eraserObject'
  pts?: InkPoint[]
  done?: boolean
  from?: string
  roomKey?: string
}

/** ---------- Channel name helpers (unchanged strings) ---------- */
const globalChan = (cls?: string) => (cls ? `global:${cls}` : 'global-class')
const assignmentChan = (cls: string | undefined, a: string) =>
  cls ? `assignment:${cls}:${a}` : `assignment:${a}`
const inkChan = (cls: string | undefined, a: string, p: string, s?: string) => {
  const base = cls ? `ink:${cls}:${a}:${p}` : `ink:${a}:${p}`
  return s ? `${base}:${s}` : base
}

/** =========================================================================================
 *  Channel CACHE (keyed by channel name) — prevents re-subscribe churn & ACKs disabled
 *  ======================================================================================= */
const cache = new Map<string, RealtimeChannel>()

function getChannel(name: string): RealtimeChannel {
  const hit = cache.get(name)
  if (hit) return hit
  const ch = supabase.channel(name, {
    // ↓↓↓ turn off ACKs and self-echo to cut message volume
    config: { broadcast: { ack: false, self: false } }
  })
  cache.set(name, ch)
  return ch
}

function ensureJoined(ch: RealtimeChannel) {
  if ((ch as any).state !== 'joined') ch.subscribe()
}

export function dropChannel(name: string) {
  const ch = cache.get(name)
  if (ch) {
    try { ch.unsubscribe() } catch {}
    cache.delete(name)
  }
}
export function dropAllRealtimeChannels() {
  for (const [k, ch] of cache) {
    try { ch.unsubscribe() } catch {}
    cache.delete(k)
  }
}

/** ---------- Small utils (unchanged) ---------- */
const N = (v: any) => {
  const x = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(x) ? x : 0
}
function normalizeTool(tool: InkUpdate['tool']): 'pen' | 'highlighter' | 'eraser' {
  if (tool === 'eraser' || tool === 'eraserObject' || (tool as any) === 'erase') return 'eraser'
  if (tool === 'highlighter') return 'highlighter'
  return 'pen'
}
function normalizePts(pts?: InkPoint[]): InkPoint[] | undefined {
  if (!Array.isArray(pts)) return undefined
  const out: InkPoint[] = []
  for (const p of pts) {
    if (!p || (typeof p !== 'object')) continue
    const x = N((p as any).x)
    const y = N((p as any).y)
    const tRaw = (p as any).t
    const hasT = typeof tRaw === 'number' && Number.isFinite(tRaw)
    out.push(hasT ? { x, y, t: tRaw } : { x, y })
  }
  return out.length ? out : undefined
}
function normalizeInkUpdate(u: InkUpdate): InkUpdate {
  return { ...u, tool: normalizeTool(u.tool), pts: normalizePts(u.pts) }
}

/** =========================================================================================
 *  GLOBAL (assignment handoff) — class scoped with legacy compatibility
 *  ======================================================================================= */
export async function publishSetAssignment(a: string, b?: string) {
  const classCode = b ? a : undefined
  const assignmentId = b ?? a
  const name = globalChan(classCode)
  const ch = getChannel(name)
  ensureJoined(ch)
  await ch.send({
    type: 'broadcast',
    event: 'set-assignment',
    payload: { assignmentId, ts: Date.now() },
  })
  // no unsubscribe: channel stays warm
}

export function subscribeToGlobal(a: string | ((id: string) => void), b?: (id: string) => void) {
  const classCode = typeof a === 'string' ? a : undefined
  const handler = (typeof a === 'function' ? a : b) as (id: string) => void
  const name = globalChan(classCode)
  const ch = getChannel(name)
    .on('broadcast', { event: 'set-assignment' }, (msg: any) => {
      const id = msg?.payload?.assignmentId
      if (typeof id === 'string' && id) handler(id)
    })
  ensureJoined(ch)
  return () => { /* keep global channel cached; explicit drop via dropChannel(name) if needed */ }
}

/** =========================================================================================
 *  PER-ASSIGNMENT (page, focus, auto-follow, presence, force-submit, allow-colors)
 *  ======================================================================================= */
function assignmentChannel(classCode: string | undefined, assignmentId: string) {
  return getChannel(assignmentChan(classCode, assignmentId))
}

/** Legacy-compatible signature shim preserved */
export function subscribeToAssignment(
  a: string,
  b: any,
  c?: {
    onSetPage?: (p: SetPagePayload) => void
    onFocus?: (p: FocusPayload) => void
    onAutoFollow?: (p: AutoFollowPayload) => void
    onPresence?: (p: TeacherPresenceState) => void
    onForceSubmit?: (p: ForceSubmitPayload) => void
    /** NEW: color policy handler */
    onAllowColors?: (p: { allow?: boolean }) => void
  }
) {
  const classCode = c ? a : undefined
  const assignmentId = c ? (b as string) : a
  const handlers = (c ?? b) as {
    onSetPage?: (p: SetPagePayload) => void
    onFocus?: (p: FocusPayload) => void
    onAutoFollow?: (p: AutoFollowPayload) => void
    onPresence?: (p: TeacherPresenceState) => void
    onForceSubmit?: (p: ForceSubmitPayload) => void
    onAllowColors?: (p: { allow?: boolean }) => void
  }

  const ch = assignmentChannel(classCode, assignmentId)
    .on('broadcast', { event: 'set-page' }, (msg: any) => handlers.onSetPage?.(msg?.payload))
    .on('broadcast', { event: 'focus' }, (msg: any) => handlers.onFocus?.(msg?.payload))
    .on('broadcast', { event: 'auto-follow' }, (msg: any) => handlers.onAutoFollow?.(msg?.payload))
    .on('broadcast', { event: 'presence' }, (msg: any) => handlers.onPresence?.(msg?.payload))
    .on('broadcast', { event: 'presence-snapshot' }, (msg: any) => handlers.onPresence?.(msg?.payload))
    .on('broadcast', { event: 'force-submit' }, (msg: any) => handlers.onForceSubmit?.(msg?.payload))
    // NEW: teacher color policy
    .on('broadcast', { event: 'set-allow-colors' }, (msg: any) => handlers.onAllowColors?.(msg?.payload))
  ensureJoined(ch)
  return ch
}

export async function publishSetPage(
  a: string,
  b: any,
  c?: SetPagePayload | number | string
) {
  const classCode = c !== undefined ? a : undefined
  const assignmentId = c !== undefined ? (b as string) : a
  const payloadOrIndex = (c !== undefined ? c : b) as SetPagePayload | number | string
  let payload: SetPagePayload
  if (typeof payloadOrIndex === 'object') payload = payloadOrIndex
  else if (typeof payloadOrIndex === 'number') payload = { pageIndex: payloadOrIndex }
  else payload = { pageId: payloadOrIndex, pageIndex: 0 }

  const ch = assignmentChannel(classCode, assignmentId)
  ensureJoined(ch)
  await ch.send({ type: 'broadcast', event: 'set-page', payload: { ...payload, ts: Date.now() } })
}

export async function publishFocus(
  a: string,
  b: any,
  c?: FocusPayload | boolean,
  d?: boolean
) {
  const classCode = c !== undefined ? a : undefined
  const assignmentId = c !== undefined ? (b as string) : a
  const payloadOrOn = (c !== undefined ? c : b) as FocusPayload | boolean
  const payload: FocusPayload =
    typeof payloadOrOn === 'boolean'
      ? { on: payloadOrOn, lockNav: !!d }
      : payloadOrOn

  const ch = assignmentChannel(classCode, assignmentId)
  ensureJoined(ch)
  await ch.send({ type: 'broadcast', event: 'focus', payload: { ...payload, ts: Date.now() } })
}

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
  const payload: AutoFollowPayload =
    typeof payloadOrOn === 'boolean'
      ? {
          on: payloadOrOn,
          allowedPages: d ?? null,
          teacherPageIndex: typeof e === 'number' ? e : undefined
        }
      : payloadOrOn

  const ch = assignmentChannel(classCode, assignmentId)
  ensureJoined(ch)
  await ch.send({ type: 'broadcast', event: 'auto-follow', payload: { ...payload, ts: Date.now() } })
}

export async function broadcastForceSubmit(
  a: string,
  b: any,
  c?: ForceSubmitPayload
) {
  const classCode = c ? a : undefined
  const assignmentId = c ? (b as string) : a
  const payload = (c ?? b) as ForceSubmitPayload

  const ch = assignmentChannel(classCode, assignmentId)
  ensureJoined(ch)
  await ch.send({ type: 'broadcast', event: 'force-submit', payload: { ...payload, ts: Date.now() } })
}

export async function setTeacherPresence(
  a: string,
  b: any,
  c?: TeacherPresenceState
) {
  const classCode = c ? a : undefined
  const assignmentId = c ? (b as string) : a
  const state = (c ?? b) as TeacherPresenceState
  const ch = assignmentChannel(classCode, assignmentId)
  ensureJoined(ch)
  const payload: TeacherPresenceState = { role: 'teacher', ...state, ts: Date.now() }
  await ch.send({ type: 'broadcast', event: 'presence', payload })
}

/** Respond to 'hello' with a presence snapshot (unchanged API) */
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
  const getSnapshot = (c ?? b)!
  const ch = assignmentChannel(classCode, assignmentId)
    .on('broadcast', { event: 'hello' }, async () => {
      try {
        const snap = getSnapshot?.() ?? {
          autoFollow: false, focusOn: false, lockNav: false, allowedPages: null, teacherPageIndex: 0
        }
        await ch.send({ type: 'broadcast', event: 'presence-snapshot', payload: { ...snap, ts: Date.now() } })
      } catch {/* ignore */}
    })
  ensureJoined(ch)
  return () => { /* keep channel warm; call dropChannel if you truly leave */ }
}

/** ---------- NEW: Allow-colors publisher ---------- */
export async function publishAllowColors(
  a: string,
  b: any,
  c?: { allow: boolean }
) {
  const classCode = c ? a : undefined
  const assignmentId = c ? (b as string) : a
  const payload = (c ?? b) as { allow: boolean }
  const ch = assignmentChannel(classCode, assignmentId)
  ensureJoined(ch)
  await ch.send({ type: 'broadcast', event: 'set-allow-colors', payload })
}

/** =========================================================================================
 *  INK fan-out — HARD DISABLED without breaking imports
 *  We export the same functions, but they no-op (no subscribe, no send).
 *  This removes the per-point realtime flood while letting code compile.
 *  ======================================================================================= */
export async function publishInk(
  _inkChOrIds:
    | RealtimeChannel
    | { classCode?: string; assignmentId: string; pageId: string; studentCode?: string },
  _update: InkUpdate
) {
  // intentionally NO-OP (live ink disabled)
  return
}

/** Returns a channel object that is never joined; callers can still call .unsubscribe() safely. */
export function subscribeToInk(
  ids: { classCode?: string; assignmentId: string; pageId: string; studentCode?: string },
  _onUpdate: (u: InkUpdate) => void
): RealtimeChannel
export function subscribeToInk(
  classCode: string,
  assignmentId: string,
  pageId: string,
  _onUpdate: (u: InkUpdate) => void
): RealtimeChannel
export function subscribeToInk(
  assignmentId: string,
  pageId: string,
  _onUpdate: (u: InkUpdate) => void,
  studentCode?: string
): RealtimeChannel
export function subscribeToInk(a: any, b?: any, c?: any, d?: any): RealtimeChannel {
  // derive room name exactly as before, but DO NOT subscribe to avoid traffic
  let name: string
  let sc: string | undefined = undefined

  if (typeof a === 'object' && a && 'assignmentId' in a) {
    const { classCode, assignmentId, pageId, studentCode } = a
    sc = studentCode
    name = inkChan(classCode, assignmentId, pageId, studentCode)
  } else if (typeof d === 'function' && typeof a === 'string' && typeof b === 'string' && typeof c === 'string') {
    // (classCode, assignmentId, pageId, onUpdate)
    name = inkChan(a as string, b as string, c as string, undefined)
  } else if (typeof c === 'function' && typeof a === 'string' && typeof b === 'string') {
    // legacy (assignmentId, pageId, onUpdate)
    name = inkChan(undefined, a as string, b as string, undefined)
  } else {
    // fallback (assignmentId, pageId, onUpdate, studentCode?)
    sc = typeof d === 'string' ? d : undefined
    name = inkChan(undefined, String(a), String(b), sc)
  }

  const ch = getChannel(name)
  // IMPORTANT: we don't .on(...) and don't join — zero realtime cost
  return ch
}
