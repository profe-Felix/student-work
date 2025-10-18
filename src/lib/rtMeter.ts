// Simple realtime meter: wraps supabase.channel to count sends/receives per channel::event

import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './db' // NOTE: same place you already import supabase from in pages

type Cnt = { sent: number; recv: number }
const counters: Record<string, Cnt> = {}

let originalChannel: typeof supabase.channel | null = null

function bump(key: string, kind: 'sent' | 'recv') {
  counters[key] ??= { sent: 0, recv: 0 }
  counters[key][kind]++
}

/** Enable metering (idempotent). Wraps supabase.channel */
export function enableRealtimeMeter() {
  if (originalChannel) return
  originalChannel = supabase.channel.bind(supabase)

  ;(supabase as any).channel = (topic: string, opts?: any): RealtimeChannel => {
    const ch = originalChannel!(topic, opts)

    const origSend = ch.send.bind(ch)
    const origOn = ch.on.bind(ch)

    ;(ch as any).send = async (msg: any) => {
      const event = msg?.event ?? msg?.type ?? 'unknown'
      bump(`${topic} :: ${event}`, 'sent')
      return origSend(msg)
    }

    ;(ch as any).on = (type: any, filter: any, cb: any) => {
      const event = (filter?.event || type?.event || type) ?? 'unknown'
      return origOn(type, filter, (payload: any) => {
        bump(`${topic} :: ${event}`, 'recv')
        cb(payload)
      })
    }

    return ch
  }
}

/** Disable metering and restore the original supabase.channel */
export function disableRealtimeMeter() {
  if (!originalChannel) return
  ;(supabase as any).channel = originalChannel
  originalChannel = null
}

/** Get current counters as an array (sorted by total desc) */
export function getRealtimeUsage() {
  return Object.entries(counters)
    .map(([k, v]) => ({ channel_event: k, sent: v.sent, recv: v.recv, total: v.sent + v.recv }))
    .sort((a, b) => b.total - a.total)
}

/** Console-table the current counters (also returns them) */
export function logRealtimeUsage(label = 'Realtime usage') {
  const rows = getRealtimeUsage()
  console.group(label)
  console.table(rows)
  console.groupEnd()
  return rows
}
