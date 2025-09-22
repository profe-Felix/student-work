// src/components/TeacherSyncBar.tsx
import { useEffect, useRef, useState } from 'react'
import { ensureClassroomChannel, publishAutoFollow, publishFocus, publishSetPage } from '../lib/realtime'

type Props = {
  assignmentId: string
  pageId: string
  pageIndex: number
  className?: string
  /** If you have the storage path for the PDF (e.g. "pdfs/<uuid>.pdf"), pass it so students load it immediately */
  assignmentPdfPath?: string | null
}

export default function TeacherSyncBar({ assignmentId, pageId, pageIndex, className, assignmentPdfPath }: Props) {
  const [autoFollowOn, setAutoFollowOn] = useState(false)
  const [focusOn, setFocusOn] = useState(false)
  const [lockNav, setLockNav] = useState(true)
  const [rangeInput, setRangeInput] = useState('') // e.g. "1-3,5"
  const chRef = useRef<any>(null)

  useEffect(() => {
    const ch = ensureClassroomChannel()
    chRef.current = ch
    return () => { ch.unsubscribe() }
  }, [])

  function parseAllowedPages(text: string): number[] | null {
    const t = (text || '').trim()
    if (!t) return null
    const out = new Set<number>()
    for (const part of t.split(',').map(s => s.trim()).filter(Boolean)) {
      if (/^\d+$/.test(part)) {
        const n = parseInt(part, 10) - 1
        if (n >= 0) out.add(n)
      } else if (/^\d+\s*-\s*\d+$/.test(part)) {
        const [a, b] = part.split('-').map(s => parseInt(s.trim(), 10))
        if (a >= 1 && b >= a) {
          for (let i = a; i <= b; i++) out.add(i - 1)
        }
      }
    }
    return Array.from(out).sort((x, y) => x - y)
  }

  async function pushOnce() {
    if (!chRef.current) return
    await publishSetPage(chRef.current, pageIndex, pageId)
  }

  async function toggleAutoFollow() {
    if (!chRef.current) return
    const next = !autoFollowOn
    setAutoFollowOn(next)
    const allowed = parseAllowedPages(rangeInput)
    await publishAutoFollow(chRef.current, {
      on: next,
      assignmentId,
      assignmentPdfPath: assignmentPdfPath ?? undefined,
      teacherPageIndex: pageIndex,
      allowedPages: allowed ?? null,
    })
    if (next) await publishSetPage(chRef.current, pageIndex, pageId)
  }

  async function toggleFocus() {
    if (!chRef.current) return
    const next = !focusOn
    setFocusOn(next)
    await publishFocus(chRef.current, next, lockNav)
  }

  // Update active page while auto-follow is ON
  useEffect(() => {
    if (autoFollowOn && chRef.current) {
      publishSetPage(chRef.current, pageIndex, pageId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFollowOn, pageIndex, pageId])

  return (
    <div className={`flex items-center gap-2 p-2 bg-white/80 rounded-xl shadow border ${className ?? ''}`}>
      <button className="px-3 py-1 rounded bg-black text-white" onClick={pushOnce}>Sync to Me</button>

      <label className="flex items-center gap-1">
        <input type="checkbox" checked={autoFollowOn} onChange={toggleAutoFollow} /> Auto-follow
      </label>

      <input
        className="border rounded px-2 py-1 ml-2 w-40"
        placeholder="Pages (e.g. 1-3,5)"
        value={rangeInput}
        onChange={e => setRangeInput(e.target.value)}
        title="Allowed pages while Auto-follow is on"
      />

      <span className="mx-1 h-5 w-px bg-gray-300" />

      <label className="flex items-center gap-1">
        <input type="checkbox" checked={lockNav} onChange={() => setLockNav(v => !v)} disabled={!focusOn} /> Lock nav
      </label>

      <button
        className={`px-3 py-1 rounded ${focusOn ? 'bg-red-600 text-white' : 'bg-gray-100'}`}
        onClick={toggleFocus}
      >
        {focusOn ? 'End Focus' : 'Start Focus'}
      </button>
    </div>
  )
}
