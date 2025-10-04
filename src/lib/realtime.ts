// Unified realtime API compatible with existing callers

import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'

export type SetPagePayload = { pageIndex: number }
export type FocusPayload = { on: boolean; lockNav?: boolean }
export type AutoFollowPayload = { on: boolean; allowedPages?: number[] | null; teacherPageIndex?: number }
export type TeacherPresenceState = {
  autoFollow: boolean
  allowedPages: number[] | null
  teacherPageIndex: number | null
  focusOn: boolean
  lockNav: boolean
}

export const assignmentChannel = (assignmentId: string): RealtimeChannel =>
  supabase.channel(`assignment:${assignmentId}`, { config: { broadcast: { ack: true } } })

export const globalChannel = (roomId: string): RealtimeChannel =>
  supabase.channel(`global:${roomId}`, { config: { broadcast: { ack: true } } })

export function subscribeToGlobal(roomId: string): RealtimeChannel {
  return globalChannel(roomId)
}

export function subscribeToAssignment(assignmentId: string): () => () => void {
  return () => {
    const ch = assignmentChannel(assignmentId).subscribe()
    return () => { try { ch.unsubscribe() } catch {} }
  }
}

export async function publishSetAssignment(a: any, b?: any, c?: any) {
  const roomId = typeof a === 'object' ? a.roomId : a
  const assignmentId = typeof a === 'object' ? a.assignmentId : b
  const teacherPageIndex = typeof a === 'object' ? a.teacherPageIndex : c
  const ch = globalChannel(roomId)
  await ch.subscribe()
  try {
    await ch.send({ type: 'broadcast', event: 'set-assignment', payload: { assignmentId, teacherPageIndex, ts: Date.now() } })
  } finally { try { await ch.unsubscribe() } catch {} }
}

export async function publishSetPage(a: any, b?: any) {
  const assignmentId = typeof a === 'object' ? a.assignmentId : a
  const pageIndex = typeof a === 'object' ? a.pageIndex : b
  const ch = assignmentChannel(String(assignmentId))
  await ch.subscribe()
  try { await ch.send({ type: 'broadcast', event: 'set-page', payload: { pageIndex, ts: Date.now() } }) }
  finally { try { await ch.unsubscribe() } catch {} }
}

export async function setTeacherPresence(a: any, b?: any) {
  const assignmentId = typeof a === 'object' ? a.assignmentId : a
  const snap: TeacherPresenceState = (typeof a === 'object' ? a.snapshot : b) as TeacherPresenceState
  const ch = assignmentChannel(String(assignmentId))
  await ch.subscribe()
  try { await ch.send({ type: 'broadcast', event: 'presence', payload: { ...snap, ts: Date.now() } }) }
  finally { try { await ch.unsubscribe() } catch {} }
}

export async function publishAutoFollow(a: any, b?: any) {
  const assignmentId = typeof a === 'object' ? a.assignmentId : a
  const payload: AutoFollowPayload = (typeof a === 'object' ? { on: a.on, allowedPages: a.allowedPages ?? null, teacherPageIndex: a.teacherPageIndex ?? null } : b)
  const ch = assignmentChannel(String(assignmentId))
  await ch.subscribe()
  try { await ch.send({ type: 'broadcast', event: 'auto-follow', payload }) }
  finally { try { await ch.unsubscribe() } catch {} }
}

export async function publishFocus(a: any, b?: any) {
  const assignmentId = typeof a === 'object' ? a.assignmentId : a
  const payload: FocusPayload = (typeof a === 'object' ? { on: a.on, lockNav: a.lockNav } : b)
  const ch = assignmentChannel(String(assignmentId))
  await ch.subscribe()
  try { await ch.send({ type: 'broadcast', event: 'focus', payload }) }
  finally { try { await ch.unsubscribe() } catch {} }
}

export async function studentGlobalHello(roomId: string) {
  const ch = globalChannel(roomId)
  await ch.subscribe()
  try { await ch.send({ type: 'broadcast', event: 'hello', payload: { ts: Date.now() } }) }
  finally { try { await ch.unsubscribe() } catch {} }
}
