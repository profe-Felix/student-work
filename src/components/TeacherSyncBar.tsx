// src/components/TeacherSyncBar.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  publishSetPage,
  publishFocus,
  publishAutoFollow,
  setTeacherPresence,
  controlSetPage,
  controlFocus,
  controlAutoFollow,
  controlPresence,
  teacherPresenceResponder,
  type AutoFollowPayload,
  type FocusPayload,
  type SetPagePayload,
} from '../lib/realtime'

type Props = {
  assignmentId: string
  pageId: string
  pageIndex: number
  className?: string
}

/** Parse a teacher-entered page list string (e.g., "1-3,5,7-8") to 0-based indexes */
function parseAllowedPages(input: string): number[] | null {
  const s = (input || '').trim()
  if (!s) return null
  const out: number[] = []
  for (const part of s.split(',').map(p => p.trim()).filter(Boolean)) {
    if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10)
      if (!Number.isNaN(n) && n > 0) out.push(n - 1)
    } else if (/^\d+\s*-\s*\d+$/.test(part)) {
      const [a, b] = part.split('-').map(x => parseInt(x.trim(), 10))
      if (!Number.isNaN(a) && !Number.isNaN(b) && a > 0 && b > 0) {
        const lo = Math.min(a, b) - 1
        const hi = Math.max(a, b) - 1
        for (let i = lo; i <= hi; i++) out.push(i)
      }
    }
  }
  // de-dupe + sort
  const uniq = Array.from(new Set(out)).sort((x, y) => x - y)
  return uniq.length ? uniq : null
}

export default function TeacherSyncBar({
  assignmentId,
  pageId,
  pageIndex,
  className,
}: Props) {
  // Controls
  const [focusOn, setFocusOn] = useState<boolean>(false)
  const [autoFollow, setAutoFollow] = useState<boolean>(false)
  const [lockNav, setLockNav] = useState<boolean>(false)

  // Freeform page filter input (e.g. "1-3,5")
  const [allowedInput, setAllowedInput] = useState<string>('')

  // Derived allowed pages array (0-based)
  const allowedPages = useMemo<number[] | null>(
    () => parseAllowedPages(allowedInput),
    [allowedInput]
  )

  // Keep a ref snapshot for the presence responder
  const stateRef = useRef({
    focusOn,
    autoFollow,
    lockNav,
    allowedPages,
    pageIndex,
  })
  stateRef.current = { focusOn, autoFollow, lockNav, allowedPages, pageIndex }

  // Helper: broadcast presence snapshot reflecting current controls
  const broadcastPresence = async () => {
    const presence = {
      role: 'teacher' as const,
      autoFollow: stateRef.current.autoFollow,
      allowedPages: stateRef.current.allowedPages ?? null,
      teacherPageIndex: stateRef.current.pageIndex,
      focusOn: stateRef.current.focusOn,
      lockNav: stateRef.current.lockNav,
      ts: Date.now(),
    }
    try {
      await setTeacherPresence(assignmentId, presence)
    } catch {}
    try {
      await controlPresence(presence)
    } catch {}
  }

  // Late-join auto-join: answer "hello" with a presence snapshot
  useEffect(() => {
    if (!assignmentId) return
    const stop = teacherPresenceResponder(assignmentId, () => ({
      autoFollow: stateRef.current.autoFollow,
      focusOn: stateRef.current.focusOn,
      lockNav: stateRef.current.lockNav,
      allowedPages: stateRef.current.allowedPages ?? null,
      teacherPageIndex: stateRef.current.pageIndex,
    }))
    return () => { try { stop?.() } catch {} }
  }, [assignmentId])

  // When pageIndex changes, broadcast page + refresh presence
  useEffect(() => {
    if (!assignmentId) return
    const payload: SetPagePayload = { pageIndex, pageId, ts: Date.now() }
    ;(async () => {
      try { await publishSetPage(assignmentId, payload) } catch {}
      try { await controlSetPage(payload) } catch {}
      try { await broadcastPresence() } catch {}
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentId, pageIndex, pageId])

  // When toggles / allowedPages change, push events + presence
  useEffect(() => {
    if (!assignmentId) return
    ;(async () => {
      const afPayload: AutoFollowPayload = {
        on: autoFollow,
        allowedPages,
        teacherPageIndex: pageIndex,
        ts: Date.now(),
      }
      try { await publishAutoFollow(assignmentId, afPayload) } catch {}
      try { await controlAutoFollow(afPayload) } catch {}

      const fPayload: FocusPayload = { on: focusOn, lockNav, ts: Date.now() }
      try { await publishFocus(assignmentId, fPayload) } catch {}
      try { await controlFocus(fPayload) } catch {}

      await broadcastPresence()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFollow, focusOn, lockNav, allowedPages])

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        background: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: 10,
        padding: 8,
      }}
    >
      <strong>Sync</strong>

      {/* Focus toggle */}
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={focusOn}
          onChange={(e) => setFocusOn(e.target.checked)}
        />
        Focus
      </label>

      {/* Lock Nav (applies when Focus is on) */}
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={lockNav}
          onChange={(e) => setLockNav(e.target.checked)}
          disabled={!focusOn}
        />
        Lock Nav
      </label>

      {/* Auto-follow */}
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={autoFollow}
          onChange={(e) => setAutoFollow(e.target.checked)}
        />
        Auto-follow
      </label>

      {/* Allowed pages input */}
      <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <span style={{ color: '#6b7280' }}>Allowed pages:</span>
        <input
          type="text"
          value={allowedInput}
          onChange={(e) => setAllowedInput(e.target.value)}
          placeholder="e.g. 1-3,5"
          style={{ padding: '4px 6px', border: '1px solid #ddd', borderRadius: 6, width: 140 }}
        />
      </div>

      <span style={{ marginLeft: 'auto', color: '#6b7280', fontSize: 12 }}>
        Page {pageIndex + 1}
      </span>
    </div>
  )
}
