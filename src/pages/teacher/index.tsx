// src/pages/teacher/index.tsx
import { useEffect, useMemo, useState } from 'react'
import {
  supabase,
  listAssignments, listPages, listLatestByPage,
  type AssignmentRow, type PageRow, getAudioUrl
} from '../../lib/db'

export default function TeacherPage(){
  const [assignments, setAssignments] = useState<AssignmentRow[]>([])
  const [assignmentId, setAssignmentId] = useState<string>('')
  const [pages, setPages] = useState<PageRow[]>([])
  const [pageId, setPageId] = useState<string>('')

  const [rows, setRows] = useState<Awaited<ReturnType<typeof listLatestByPage>>>([])
  const [loading, setLoading] = useState(false)

  // load assignments
  useEffect(() => {
    ;(async ()=>{
      try{
        const a = await listAssignments()
        setAssignments(a)
        if (a.length && !assignmentId) setAssignmentId(a[0].id)
      }catch(e){ console.error(e) }
    })()
  }, [])

  // load pages for assignment
  useEffect(() => {
    if (!assignmentId) return
    ;(async ()=>{
      try{
        const p = await listPages(assignmentId)
        setPages(p)
        if (p.length) setPageId(p[0].id)
      }catch(e){ console.error(e) }
    })()
  }, [assignmentId])

  // load latest per student for page
  useEffect(() => {
    if (!assignmentId || !pageId) return
    setLoading(true)
    ;(async ()=>{
      try{
        const data = await listLatestByPage(assignmentId, pageId)
        setRows(data)
      }catch(e){ console.error(e) }
      finally{ setLoading(false) }
    })()
  }, [assignmentId, pageId])

  const currentAssignmentTitle = useMemo(() => {
    return assignments.find(a => a.id === assignmentId)?.title ?? ''
  }, [assignments, assignmentId])

  return (
    <div style={{ padding:16 }}>
      <h2 style={{ marginBottom:12 }}>Teacher Dashboard</h2>

      <div style={{ display:'flex', gap:8, marginBottom:12 }}>
        <select value={assignmentId} onChange={e=>setAssignmentId(e.target.value)}>
          <option value="" disabled>Choose assignment…</option>
          {assignments.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
        </select>

        <select value={pageId} onChange={e=>setPageId(e.target.value)} disabled={!pages.length}>
          {pages.length === 0 && <option value="">No pages</option>}
          {pages.map(p => (
            <option key={p.id} value={p.id}>Page {p.page_index + 1}</option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom:8, color:'#6b7280' }}>
        {currentAssignmentTitle && <>Showing latest work for <strong>{currentAssignmentTitle}</strong></>}
      </div>

      {loading ? <div>Loading…</div> : (
        <div style={{
          display:'grid',
          gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))',
          gap:12
        }}>
          {rows.length === 0 && (
            <div style={{ color:'#6b7280' }}>No work yet.</div>
          )}
          {rows.map(r => {
            const audio = getAudioUrl(r.audio_url)
            const hasInk = !!(r.strokes_json && Array.isArray(r.strokes_json.strokes) && r.strokes_json.strokes.length)
            return (
              <div key={r.submission_id} style={{
                border:'1px solid #e5e7eb', borderRadius:12, padding:10, background:'#fff'
              }}>
                <div style={{ fontWeight:700, marginBottom:6 }}>{r.student_id}</div>
                <div style={{ fontSize:12, color:'#6b7280', marginBottom:8 }}>
                  {new Date(r.created_at).toLocaleString()}
                </div>
                <div style={{
                  height:120, border:'1px dashed #e5e7eb', borderRadius:8,
                  display:'flex', alignItems:'center', justifyContent:'center',
                  background: hasInk ? '#f0f9ff' : '#f9fafb'
                }}>
                  {hasInk ? '✏️ Strokes present' : '— No strokes —'}
                </div>
                {audio && (
                  <audio src={audio} controls style={{ width:'100%', marginTop:8 }} />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
