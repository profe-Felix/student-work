// /src/components/TeacherSyncBar.tsx
import { useEffect, useMemo, useState } from 'react'
import {
  publishSetPage,
  controlSetPage,
  publishAutoFollow,
  publishFocus,
  setTeacherPresence,
  controlPresence,
  teacherPresenceResponder,
  type TeacherPresenceState,
} from '../lib/realtime'

type Props = {
  assignmentId: string
  pageId: string
  pageIndex: number
}

export default function TeacherSyncBar({ assignmentId, pageId, pageIndex }: Props) {
  const [autoFollow, setAutoFollow] = useState<boolean>(true)
  const [focusOn, setFocusOn] = useState<boolean>(false)
  const [lockNav, setLockNav] = useState<boolean>(true)
  const [allowedPages, setAllowedPages] = useState<number[] | null>(null)

  const presence: TeacherPresenceState = useMemo(
    () => ({
      role: 'teacher',
      teacherPageIndex: pageIndex ?? 0,
      autoFollow,
      allowedPages,
      focusOn,
      lockNav,
      ts: Date.now(),
    }),
    [pageIndex, autoFollow, allowedPages, focusOn, lockNav]
  )

  // Tell students the page changed (assignment channel) and mirror to control:all
  useEffect(() => {
    if (!assignmentId) return
    publishSetPage(assignmentId, { pageIndex }).catch(() => {})
    controlSetPage({ pageIndex }).catch(() => {})
  }, [assignmentId, pageIndex])

  // Broadcast presence + specific intents when flags/page change
  useEffect(() => {
    if (!assignmentId) return
    setTeacherPresence(assignmentId, presence).catch(() => {})
    controlPresence(presence).catch(() => {}) // mirror globally for late joiners

    publishAutoFollow(assignmentId, {
      on: autoFollow,
      allowedPages,
      teacherPageIndex: pageIndex,
    }).catch(() => {})

    publishFocus(assignmentId, { on: focusOn, lockNav }).catch(() => {})
  }, [assignmentId, presence, autoFollow, allowedPages, focusOn, lockNav, pageIndex])

  // Answer student “hello” with a fresh snapshot
  useEffect(() => {
    if (!assignmentId) return
    const off = teacherPresenceResponder(assignmentId, () => ({
      autoFollow,
      focusOn,
      lockNav,
      allowedPages,
      teacherPageIndex: pageIndex,
    }))
    return () => { try { off() } catch {} }
  }, [assignmentId, autoFollow, focusOn, lockNav, allowedPages, pageIndex])

  return (
    <div style={{
      display: 'flex', gap: 8, alignItems: 'center',
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 8
    }}>
      <strong>Sync</strong>

      <label style={{ display:'inline-flex', gap:6, alignItems:'center' }}>
        <input
          type="checkbox"
          checked={autoFollow}
          onChange={(e) => setAutoFollow(e.target.checked)}
        />
        Auto-follow
      </label>

      <label style={{ display:'inline-flex', gap:6, alignItems:'center' }}>
        <input
          type="checkbox"
          checked={focusOn}
          onChange={(e) => setFocusOn(e.target.checked)}
        />
        Focus
      </label>

      <label style={{ display:'inline-flex', gap:6, alignItems:'center' }}>
        <input
          type="checkbox"
          checked={lockNav}
          onChange={(e) => setLockNav(e.target.checked)}
          disabled={!focusOn}
        />
        Lock Nav
      </label>

      <span style={{ marginLeft: 'auto', color:'#6b7280', fontSize:12 }}>
        Page {pageIndex + 1}
      </span>
    </div>
  )
}
