// src/components/TeacherSyncBar.tsx
import { useEffect, useRef, useState } from 'react'
import { upsertTeacherState } from '../lib/db'
import {
  publishAutoFollow,
  publishFocus,
  publishSetPage,
  setTeacherPresence,
  publishAllowColors,
  teacherPresenceResponder,
} from '../lib/realtime'

type Props = {
  classCode: string
  assignmentId: string
  pageId: string
  pageIndex: number
  className?: string
}

// "1-3,5,8-9" (1-based) -> [0,1,2,4,7,8] (0-based)
function parseRanges(input: string): number[] {
  const out = new Set<number>()
  const parts = input.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
  for (const p of parts) {
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/)
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10)
      if (isFinite(a) && isFinite(b)) {
        if (a > b) [a, b] = [b, a]
        for (let k = a; k <= b; k++) out.add(k - 1)
      }
    } else {
      const n = parseInt(p, 10)
      if (isFinite(n)) out.add(n - 1)
    }
  }
  return Array.from(out.values()).sort((a, b) => a - b)
}

type Snapshot = {
  pageIndex: number
  autoFollow: boolean
  focusOn: boolean
  lockNav: boolean
  allowedPages: number[] | null
}

export default function TeacherSyncBar({ classCode, assignmentId, pageId, pageIndex, className }: Props) {
  const [autoFollow, setAutoFollow] = useState(false)
  const [focus, setFocus] = useState(false)
  const [lockNav, setLockNav] = useState(true)
  const [rangeText, setRangeText] = useState('')
  const allowedRef = useRef<number[] | null>(null)

  // Allow-colors policy (realtime only; no DB write needed)
  const [allowColors, setAllowColors] = useState<boolean>(true)

  // Last DB-upserted snapshot (used to avoid duplicate writes)
  const lastSavedRef = useRef<Snapshot | null>(null)
  const upsertDebounceRef = useRef<number | null>(null)

  const snapshot = (): Snapshot => ({
    pageIndex,
    autoFollow,
    focusOn: focus,
    lockNav,
    allowedPages: allowedRef.current ?? null,
  })

  const presence = () => ({
    autoFollow,
    allowedPages: allowedRef.current ?? null,
    teacherPageIndex: pageIndex,
    focusOn: focus,
    lockNav,
  })

  const shallowEqualSnap = (a: Snapshot | null, b: Snapshot | null) => {
    if (!a || !b) return false
    if (
      a.pageIndex !== b.pageIndex ||
      a.autoFollow !== b.autoFollow ||
      a.focusOn !== b.focusOn ||
      a.lockNav !== b.lockNav
    ) return false
    const A = a.allowedPages ?? null
    const B = b.allowedPages ?? null
    if (A === null || B === null) return A === B
    if (A.length !== B.length) return false
    for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return false
    return true
  }

  /** Reply to student “hello” with a presence snapshot */
  useEffect(() => {
    if (!assignmentId) return
    const stop = teacherPresenceResponder(classCode, assignmentId, () => presence())
    return () => { try { stop?.() } catch {} }
  }, [classCode, assignmentId, autoFollow, focus, lockNav, pageIndex])

  /** Initial realtime presence on mount */
  useEffect(() => {
    if (!assignmentId) return
    void setTeacherPresence(classCode, assignmentId, presence())
  }, [assignmentId]) // keep mount-only behavior

  /** Keep realtime presence fresh when toggles/page change (NO DB write here) */
  useEffect(() => {
    if (!assignmentId) return
    void setTeacherPresence(classCode, assignmentId, presence())
  }, [classCode, assignmentId, autoFollow, focus, lockNav, pageIndex])

  /** Debounced DB write-through (greatly reduces teacher_state traffic) */
  useEffect(() => {
    if (!assignmentId) return
    const next = snapshot()
    if (shallowEqualSnap(lastSavedRef.current, next)) return

    if (upsertDebounceRef.current) window.clearTimeout(upsertDebounceRef.current)
    upsertDebounceRef.current = window.setTimeout(async () => {
      try {
        await upsertTeacherState({
          classCode,
          assignmentId,
          pageIndex: next.pageIndex,
          focusOn: next.focusOn,
          autoFollow: next.autoFollow,
          allowedPages: next.allowedPages ?? null,
        })
        lastSavedRef.current = next
      } catch {
        // ignore
      }
    }, 600) // debounce DB writes
    return () => { if (upsertDebounceRef.current) window.clearTimeout(upsertDebounceRef.current) }
  }, [classCode, assignmentId, autoFollow, focus, lockNav, pageIndex, rangeText])

  /** When Auto-Follow is ON, rebroadcast page snaps */
  useEffect(() => {
    if (!assignmentId || !pageId) return
    if (autoFollow) void publishSetPage(classCode, assignmentId, pageIndex)
  }, [classCode, assignmentId, pageId, pageIndex, autoFollow])

  /** If Auto-Follow is ON and the teacher edits "Allow pages", live-apply the range (realtime only) */
  const rangeRebroadcastDebounce = useRef<number | null>(null)
  useEffect(() => {
    if (!assignmentId || !autoFollow) return
    const allowed = parseRanges(rangeText)
    allowedRef.current = allowed
    if (rangeRebroadcastDebounce.current) window.clearTimeout(rangeRebroadcastDebounce.current)
    rangeRebroadcastDebounce.current = window.setTimeout(async () => {
      try {
        await setTeacherPresence(classCode, assignmentId, {
          ...presence(),
          allowedPages: allowed ?? null,
        })
        await publishAutoFollow(classCode, assignmentId, true, allowed ?? null, pageIndex)
      } catch {}
    }, 250)
    return () => { if (rangeRebroadcastDebounce.current) window.clearTimeout(rangeRebroadcastDebounce.current) }
  }, [assignmentId, classCode, autoFollow, rangeText, pageIndex, focus, lockNav])

  async function toggleAutoFollow() {
    if (!assignmentId) return
    const next = !autoFollow
    setAutoFollow(next)
    const allowed = next ? parseRanges(rangeText) : null
    allowedRef.current = allowed

    // Realtime snapshot + broadcast
    await setTeacherPresence(classCode, assignmentId, {
      autoFollow: next,
      allowedPages: allowed ?? null,
      teacherPageIndex: pageIndex,
      focusOn: focus,
      lockNav,
    })
    await publishAutoFollow(classCode, assignmentId, next, allowed ?? null, pageIndex)
    if (next) await publishSetPage(classCode, assignmentId, pageIndex)

    // DB write is handled by debounced effect (no immediate upsert here)
  }

  async function toggleFocus() {
    if (!assignmentId) return
    const next = !focus
    setFocus(next)
    const nextLock = next ? lockNav : false

    await setTeacherPresence(classCode, assignmentId, {
      autoFollow,
      allowedPages: allowedRef.current ?? null,
      teacherPageIndex: pageIndex,
      focusOn: next,
      lockNav: nextLock,
    })
    await publishFocus(classCode, assignmentId, next, nextLock)
    // DB write handled by debounced effect
  }

  async function toggleAllowColors() {
    const next = !allowColors
    setAllowColors(next)
    await publishAllowColors(classCode, assignmentId, { allow: next })
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 p-2 bg-white/80 rounded-xl shadow border ${className ?? ''}`}>
      <button
        className={`px-3 py-1 rounded ${autoFollow ? 'bg-black text-white' : 'bg-gray-100'}`}
        onClick={toggleAutoFollow}
        title="While ON, students follow your page. Optionally allow a page range."
      >
        {autoFollow ? 'Sync to Me: ON' : 'Sync to Me: OFF'}
      </button>

      <label className="flex items-center gap-1 text-sm">
        <span className="text-gray-600">Allow pages</span>
        <input
          className="border rounded px-2 py-1"
          placeholder="e.g. 1-3,5"
          value={rangeText}
          onChange={e => setRangeText(e.target.value)}
          disabled={false}
          style={{ minWidth: 120 }}
        />
      </label>

      <span className="mx-1 h-5 w-px bg-gray-300" />

      <label className="flex items-center gap-1 text-sm">
        <input
          type="checkbox"
          checked={lockNav}
          onChange={() => setLockNav(v => !v)}
          disabled={!focus}
        />
        Lock nav
      </label>

      <button
        className={`px-3 py-1 rounded ${focus ? 'bg-red-600 text-white' : 'bg-gray-100'}`}
        onClick={toggleFocus}
      >
        {focus ? 'End Focus' : 'Start Focus'}
      </button>

      <span className="mx-1 h-5 w-px bg-gray-300" />

      <label className="flex items-center gap-2 text-sm">
        <span className="text-gray-600">Allow colors</span>
        <button
          className={`px-3 py-1 rounded ${allowColors ? 'bg-emerald-600 text-white' : 'bg-gray-100'}`}
          onClick={toggleAllowColors}
          title="When OFF, students are forced to draw in black only."
        >
          {allowColors ? 'ON' : 'OFF'}
        </button>
      </label>
    </div>
  )
}
