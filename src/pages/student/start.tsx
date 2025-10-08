// src/pages/student/start.tsx
import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

export default function StudentStart() {
  const location = useLocation()
  const nav = useNavigate()

  // read ?class= (default 'A')
  const classCode = useMemo(() => {
    const qs = new URLSearchParams(location.search)
    return (qs.get('class') || 'A').toUpperCase()
  }, [location.search])

  // build a basic list of students for the class (A_01 … A_28, or B_01 …)
  const students = useMemo(
    () => Array.from({ length: 28 }, (_, i) => `${classCode}_${String(i + 1).padStart(2, '0')}`),
    [classCode]
  )

  return (
    <div style={{ minHeight:'100vh', background:'#fafafa', padding:16 }}>
      <h2 style={{ marginBottom: 8 }}>Choose your name</h2>
      <div style={{ marginBottom: 12, color:'#374151' }}>
        Class: <strong>{classCode}</strong>
      </div>

      <div
        style={{
          display:'grid',
          gridTemplateColumns:'repeat(auto-fill, minmax(140px, 1fr))',
          gap:10
        }}
      >
        {students.map(sid => (
          <button
            key={sid}
            onClick={() => {
              // navigate to assignment and keep class in the URL
              nav(`/student/assignment?class=${encodeURIComponent(classCode)}&student=${encodeURIComponent(sid)}`)
            }}
            style={{
              padding:'10px 12px',
              background:'#fff',
              border:'1px solid #e5e7eb',
              borderRadius:10,
              textAlign:'left',
              cursor:'pointer'
            }}
          >
            {sid}
          </button>
        ))}
      </div>

      <div style={{ marginTop:16, fontSize:12, color:'#6b7280' }}>
        Tip: You can link or QR to <code>/start?class={classCode}</code> to jump straight to this roster.
      </div>
    </div>
  )
}
