// src/lib/rtMeter.ts
// Lightweight realtime usage meter for Supabase Realtime.
// Counts outbound .send() and inbound .on(...) callback invocations per channel/topic.

import { supabase } from './db'

type Row = {
  ts: number
  dir: 'out' | 'in'
  topic: string
  event: string
  note?: string
}

const STORE_KEY = '__rt_meter__v1'
const state: { rows: Row[]; enabled: boolean; patched: boolean } = {
  rows: [],
  enabled: false,
  patched: false,
}

function push(row: Row) {
  state.rows.push(row)
  // keep it bounded so dev sessions don’t balloon
  if (state.rows.length > 5000) state.rows.splice(0, state.rows.length - 5000)
}

function safeEventName(ev: any): string {
  if (!ev) return 'unknown'
  if (typeof ev === 'string') return ev
  if (typeof ev === 'object') {
    // supabase .send({ type:'broadcast', event:'set-page', payload: ... })
    if ((ev as any).event) return String((ev as any).event)
    if ((ev as any).type) return String((ev as any).type)
  }
  return String(ev)
}

function wrapChannel(ch: any, topic: string) {
  if (!ch || (ch as any).__rt_patched) return ch
  ;(ch as any).__rt_patched = true

  // wrap send() to log outbound broadcasts
  const origSend = ch.send?.bind(ch)
  if (origSend) {
    ch.send = async (envelope: any) => {
      try {
        const ev = safeEventName(envelope?.event || envelope)
        push({ ts: Date.now(), dir: 'out', topic, event: ev })
      } catch {}
      return origSend(envelope)
    }
  }

  // wrap on() to wrap the user's callback for inbound counts
  const origOn = ch.on?.bind(ch)
  if (origOn) {
    ch.on = (filter: any, cb: (payload: any) => void) => {
      // supabase’s overloads allow (type, filter?, cb). Normalize a bit:
      let eventName = 'unknown'
      let tableNote = ''

      if (typeof filter === 'string') {
        eventName = filter
      } else if (filter && typeof filter === 'object') {
        // broadcast: { event: 'set-page' }
        if (filter.event) eventName = String(filter.event)
        // postgres: { event:'*', schema:'public', table:'artifacts', filter:'...' }
        if (filter.table) {
          eventName = 'postgres_changes'
          tableNote = `${filter.schema || 'public'}.${filter.table}`
        }
      }

      const wrapped = (payload: any) => {
        try {
          const ev =
            eventName === 'broadcast'
              ? safeEventName(payload?.event || payload?.type || 'broadcast')
              : eventName
          push({ ts: Date.now(), dir: 'in', topic, event: ev, note: tableNote })
        } catch {}
        return cb(payload)
      }

      // Some overloads are (type, filter, cb). If first arg was string, second is filter.
      if (arguments.length === 3 && typeof arguments[0] === 'string') {
        const typeArg = arguments[0]
        const filterArg = arguments[1]
        const cbArg = arguments[2]
        return origOn(typeArg, filterArg, wrapped)
      }
      return origOn(filter, wrapped)
    }
  }

  // wrap subscribe() / unsubscribe() to track joins/leaves (helps spot resub storms)
  const origSub = ch.subscribe?.bind(ch)
  if (origSub) {
    ch.subscribe = (...args: any[]) => {
      push({ ts: Date.now(), dir: 'out', topic, event: 'subscribe' })
      return origSub(...args)
    }
  }
  const origUnsub = ch.unsubscribe?.bind(ch)
  if (origUnsub) {
    ch.unsubscribe = (...args: any[]) => {
      push({ ts: Date.now(), dir: 'out', topic, event: 'unsubscribe' })
      return origUnsub(...args)
    }
  }

  return ch
}

export function enableRealtimeMeter() {
  if (state.enabled) return
  state.enabled = true

  if (state.patched) return
  state.patched = true

  try {
    // Patch supabase.channel(...) so every new channel is wrapped.
    const origChannel = (supabase as any).channel?.bind(supabase)
    if (origChannel) {
      ;(supabase as any).channel = (topic: string, opts?: any) => {
        const ch = origChannel(topic, opts)
        return wrapChannel(ch, topic)
      }
    }

    // Also wrap any channels that might have been created before meter enabled
    const rt: any = (supabase as any).realtime
    const active = rt?.channels || []
    active.forEach((ch: any) => {
      if (ch?.topic) wrapChannel(ch, ch.topic)
    })
  } catch (e) {
    // no-op
  }
}

export function logRealtimeUsage(title = 'Realtime usage') {
  // persist a snapshot to window for debugging
  ;(window as any)[STORE_KEY] = state.rows.slice()

  const rows = state.rows.map((r) => ({
    time: new Date(r.ts).toLocaleTimeString(),
    dir: r.dir,
    topic: r.topic,
    event: r.event,
    note: r.note || '',
  }))

  // Group for a compact table
  const key = (r: any) => `${r.dir}|${r.topic}|${r.event}|${r.note}`
  const grouped: Record<string, { dir: string; topic: string; event: string; note: string; count: number }> = {}
  for (const r of rows) {
    const k = key(r)
    if (!grouped[k]) grouped[k] = { dir: r.dir, topic: r.topic, event: r.event, note: r.note, count: 0 }
    grouped[k].count++
  }
  const table = Object.values(grouped).sort((a, b) => b.count - a.count)

  // pretty print
  // eslint-disable-next-line no-console
  console.groupCollapsed(title)
  // eslint-disable-next-line no-console
  console.table(table)
  // eslint-disable-next-line no-console
  console.groupEnd()

  return table
}
