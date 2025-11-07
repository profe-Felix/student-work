//src/components/TeacherSyncBar.tsx
import { useEffect, useRef, useState } from 'react'
import {
  publishAutoFollow,
  publishFocus,
  publishSetPage,
  setTeacherPresence,
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

export default function TeacherSyncBar({ classCode, assignmentId, pageId, pageIndex, className }: Props) {
  const [autoFollow, setAutoFollow] = useState(false)
  const [focus, setFocus] = useState(false)
  const [lockNav, setLockNav] = useState(true)
  const [rangeText, setRangeText] = useState('')
  const allowedRef = useRef<number[] | null>(null)

  // Broadcast initial presence on mount (class-scoped)
  useEffect(() => {
    if (!assignmentId) return
    void setTeacherPresence(classCode, assignmentId, {
      autoFollow,
      allowedPages: allowedRef.current ?? null,
      teacherPageIndex: pageIndex,
      focusOn: focus,
      lockNav,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentId])

  // Rebroadcast presence when toggles/pageIndex change
  useEffect(() => {
    if (!assignmentId) return
    void setTeacherPresence(classCode, assignmentId, {
      autoFollow,
      allowedPages: allowedRef.current ?? null,
      teacherPageIndex: pageIndex,
      focusOn: focus,
      lockNav,
    })
  }, [classCode, assignmentId, autoFollow, focus, lockNav, pageIndex])

  // When auto-follow is ON, rebroadcast current page on change (snappy)
  useEffect(() => {
    if (!assignmentId || !pageId) return
    if (autoFollow) {
      void publishSetPage(classCode, assignmentId, pageIndex)
    }
  }, [classCode, assignmentId, pageId, pageIndex, autoFollow])

  async function toggleAutoFollow() {
    if (!assignmentId) return
    const next = !autoFollow
    setAutoFollow(next)

    const allowed = next ? parseRanges(rangeText) : null
    allowedRef.current = allowed

    // presence first — so late joiners snap immediately
    await setTeacherPresence(classCode, assignmentId, {
      autoFollow: next,
      allowedPages: allowed ?? null,
      teacherPageIndex: pageIndex,
      focusOn: focus,
      lockNav,
    })

    // then broadcast to live clients
    await publishAutoFollow(classCode, assignmentId, next, allowed ?? null, pageIndex)
    if (next) {
      await publishSetPage(classCode, assignmentId, pageIndex)
    }
  }

  async function toggleFocus() {
    if (!assignmentId) return
    const next = !focus
    setFocus(next)
    await setTeacherPresence(classCode, assignmentId, {
      autoFollow,
      allowedPages: allowedRef.current ?? null,
      teacherPageIndex: pageIndex,
      focusOn: next,
      lockNav,
    })
    await publishFocus(classCode, assignmentId, next, lockNav)
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
          disabled={autoFollow}
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
    </div>
  )
}
