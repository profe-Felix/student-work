// src/components/TeacherSyncBar.tsx
import { useEffect, useMemo, useState } from 'react'
import {
  publishSetPage,
  publishFocus,
  publishAutoFollow,
  setTeacherPresence,
  controlSetPage,
  controlFocus,
  controlAutoFollow,
  controlPresence,
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

export default function TeacherSyncBar({
  assignmentId,
  pageId,
  pageIndex,
  className,
}: Props) {
  const [focusOn, setFocusOn] = useState<boolean>(false)
  const [autoFollow, setAutoFollow] = useState<boolean>(false)
  const [lockNav, setLockNav] = useState<boolean>(false)
  const [restrictToCurrent, setRestrictToCurrent] = useState<boolean>(false)

  // Allowed pages derived from toggle
  const allowedPages = useMemo<number[] | null>(
    () => (restrictToCurrent ? [pageIndex] : null),
    [restrictToCurrent, pageIndex]
  )

  // Helper: broadcast presence snapshot reflecting current controls
  const broadcastPresence = async () => {
    const presence = {
      role: 'teacher' as const,
      autoFollow,
      allowedPages,
      teacherPageIndex: pageIndex,
      focusOn,
      lockNav,
      ts: Date.now(),
    }
    try {
      await setTeacherPresence(assignmentId, presence)
    } catch {}
    try {
      await controlPresence(presence)
    } catch {}
  }

  // When pageIndex changes (teacher changes page), tell students
  useEffect(() => {
    if (!assignmentId) return
    const payload: SetPagePayload = { pageIndex, pageId, ts: Date.now() }
    ;(async () => {
      try {
        await publishSetPage(assignmentId, payload)
      } catch {}
      try {
        await controlSetPage(payload)
      } catch {}
      // also refresh presence (so late joiners snap correctly)
      try {
        await broadcastPresence()
      } catch {}
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentId, pageIndex, pageId])

  // Whenever toggles change, (1) publish the toggle event and (2) broadcast presence
  useEffect(() => {
    if (!assignmentId) return

    ;(async () => {
      const afPayload: AutoFollowPayload = {
        on: autoFollow,
        allowedPages,
        teacherPageIndex: pageIndex,
        ts: Date.now(),
      }
      try {
        await publishAutoFollow(assignmentId, afPayload)
      } catch {}
      try {
        await controlAutoFollow(afPayload)
      } catch {}

      const fPayload: FocusPayload = { on: focusOn, lockNav, ts: Date.now() }
      try {
        await publishFocus(assignmentId, fPayload)
      } catch {}
      try {
        await controlFocus(fPayload)
      } catch {}

      await broadcastPresence()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFollow, restrictToCurrent, focusOn, lockNav])

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        gap: 8,
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

      {/* Auto-follow (snap to teacher page) */}
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={autoFollow}
          onChange={(e) => setAutoFollow(e.target.checked)}
        />
        Auto-follow
      </label>

      {/* Allowed pages scope: all vs current */}
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={restrictToCurrent}
          onChange={(e) => setRestrictToCurrent(e.target.checked)}
        />
        Only this page
      </label>

      <span style={{ marginLeft: 'auto', color: '#6b7280', fontSize: 12 }}>
        Page {pageIndex + 1}
      </span>
    </div>
  )
}
