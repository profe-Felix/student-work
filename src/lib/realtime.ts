// src/lib/realtime.ts (reconstructed minimal, consistent API)

import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'

// ---------- Types expected by callers ----------
export type SetPagePayload = { pageIndex: number }
export type FocusPayload = { on: boolean }
export type AutoFollowPayload = { on: boolean; allowedPages?: number[] | null; teacherPageIndex?: number }
export type TeacherPresenceState = {
  autoFollow: boolean
  allowedPages: number[] | null
  teacherPageIndex: number | null
  focusOn: boolean
  lockNav: boolean
}

// ---------- Channels ----------
export const assignmentChannel = (assignmentId: string): RealtimeChannel =>
  supabase.channel(`assignment:${assignmentId}`, { config: { broadcast: { ack: true } } })

export const globalChannel = (roomId: string): RealtimeChannel =>
  supabase.channel(`global:${roomId}`, { config: { broadcast: { ack: true } } })

// Back-compat helpers used by student code (they just return a channel and subscribe)
export function subscribeToAssignment(assignmentId: string): RealtimeChannel {
  return assignmentChannel(assignmentId)
}
export function subscribeToGlobal(roomId: string): RealtimeChannel {
  return globalChannel(roomId)
}

// ---------- Broadcast helpers ----------
export async function publishSetAssignment(roomId: string, assignmentId: string, teacherPageIndex: number) {
  const ch = globalChannel(roomId)
  await ch.subscribe()
  try {
    await ch.send({ type: 'broadcast', event: 'set-assignment', payload: { assignmentId, teacherPageIndex, ts: Date.now() } })
  } finally {
    try { await ch.unsubscribe() } catch {}
  }
}

export async function publishSetPage(chOrId: string | RealtimeChannel, pageIndex: number) {
  if (typeof chOrId === 'string') {
    const ch = assignmentChannel(chOrId)
    await ch.subscribe()
    try { await ch.send({ type: 'broadcast', event: 'set-page', payload: { pageIndex, ts: Date.now() } }) }
    finally { try { await ch.unsubscribe() } catch {} }
    return
  }
  await chOrId.send({ type: 'broadcast', event: 'set-page', payload: { pageIndex, ts: Date.now() } })
}

export async function setTeacherPresence(chOrId: string | RealtimeChannel, snap: TeacherPresenceState) {
  const payload = { ...snap, ts: Date.now() }
  if (typeof chOrId === 'string') {
    const ch = assignmentChannel(chOrId)
    await ch.subscribe()
    try { await ch.send({ type: 'broadcast', event: 'presence', payload }) }
    finally { try { await ch.unsubscribe() } catch {} }
    return
  }
  await chOrId.send({ type: 'broadcast', event: 'presence', payload })
}

// ---------- Student hello helper ----------
export function studentGlobalHello(roomId: string) {
  const ch = globalChannel(roomId)
  ch.subscribe()
    .then(() => ch.send({ type: 'broadcast', event: 'hello', payload: { ts: Date.now() } }))
    .finally(() => { try { ch.unsubscribe() } catch {} })
}
