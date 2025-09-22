// src/lib/realtime.ts
import { supabase } from './supabaseClient'

/** Events & payloads shared between teacher and students */
export interface SetPagePayload {
  pageIndex: number
  pageId?: string
  ts?: number
}

export interface AutoFollowPayload {
  on: boolean
  /** Active assignment context the teacher wants students on */
  assignmentId?: string
  /** Storage path like "pdfs/<uuid>.pdf" for the active assignment PDF */
  assignmentPdfPath?: string
  /** Teacher's current page index */
  teacherPageIndex?: number
  /** Allowed page indexes for navigation; null/undefined = free roam */
  allowedPages?: number[] | null
  ts?: number
}

export interface FocusPayload {
  on: boolean
  lockNav?: boolean
  ts?: number
}

/** A single, always-on channel every client joins */
const CLASSROOM_TOPIC = 'classroom'

export function classroomChannel() {
  return supabase.channel(CLASSROOM_TOPIC, {
    config: { broadcast: { ack: true }, presence: { key: 'user' } },
  })
}

/** Teacher: start the classroom channel */
export function ensureClassroomChannel() {
  const ch = classroomChannel()
  ch.subscribe()
  return ch
}

/** Teacher: emit events */
export async function publishSetPage(ch: any, pageIndex: number, pageId?: string) {
  const payload: SetPagePayload = { pageIndex, pageId, ts: Date.now() }
  await ch.send({ type: 'broadcast', event: 'SET_PAGE', payload })
}

export async function publishAutoFollow(ch: any, data: Omit<AutoFollowPayload, 'ts'>) {
  const payload: AutoFollowPayload = { ...data, ts: Date.now() }
  await ch.send({ type: 'broadcast', event: 'AUTO_FOLLOW', payload })
}

export async function publishFocus(ch: any, on: boolean, lockNav = true) {
  const payload: FocusPayload = { on, lockNav, ts: Date.now() }
  await ch.send({ type: 'broadcast', event: 'FOCUS', payload })
}

/** Student: subscribe */
export function subscribeToClassroom(handlers: {
  onSetPage?: (p: SetPagePayload) => void
  onAutoFollow?: (p: AutoFollowPayload) => void
  onFocus?: (p: FocusPayload) => void
}) {
  const ch = classroomChannel()
  ch
    .on('broadcast', { event: 'SET_PAGE' }, ({ payload }) => handlers.onSetPage?.(payload as SetPagePayload))
    .on('broadcast', { event: 'AUTO_FOLLOW' }, ({ payload }) => handlers.onAutoFollow?.(payload as AutoFollowPayload))
    .on('broadcast', { event: 'FOCUS' }, ({ payload }) => handlers.onFocus?.(payload as FocusPayload))
    .subscribe()
  return ch
}
