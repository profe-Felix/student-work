// src/pages/start.tsx
import React, { useMemo } from 'react'
import { useLocation, useNavigate, Link } from 'react-router-dom'

export default function Start() {
  const location = useLocation()
  const navigate = useNavigate()
  
  // Preserve lesson deep-link params (?name=...&page=...)
  const lessonParams = useMemo(() => {
    const qs = new URLSearchParams(location.search)
    const name = qs.get('name')
    const page = qs.get('page')
    const parts: string[] = []
    if (name) parts.push(`name=${encodeURIComponent(name)}`)
    if (page) parts.push(`page=${encodeURIComponent(page)}`)
    return parts.length ? `&${parts.join('&')}` : ''
  }, [location.search])

  // Read class from the URL; default to 'A'
  const classCode = useMemo(() => {
    const qs = new URLSearchParams(location.search)
    return (qs.get('class') || 'A').toUpperCase()
  }, [location.search])

  // Build student ids for this class (A_01..A_28, B_01..B_28, etc.)
  const students = useMemo(
    () => Array.from({ length: 28 }, (_, i) => `${classCode}_${String(i + 1).padStart(2, '0')}`),
    [classCode]
  )

  const setClassInQuery = (next: string) => {
    const qs = new URLSearchParams(location.search)
    if (next) qs.set('class', next.toUpperCase())
    else qs.delete('class')
    navigate({ pathname: '/start', search: `?${qs.toString()}` }, { replace: true })
  }

  return (
    <div style={{ padding: 16, minHeight: '100vh', background: '#fafafa' }}>
      <h2>Choose Your Class & Student</h2>

      <div style={{
        margin: '10px 0 16px', padding: 12, background: '#fff',
        border: '1px solid #e5e7eb', borderRadius: 10, display: 'flex',
        gap: 8, alignItems: 'center', flexWrap: 'wrap'
      }}>
        <label style={{ fontSize: 14 }}>Class code:</label>
        <input
          value={classCode}
          onChange={(e) => setClassInQuery(e.target.value)}
          style={{ padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 8, minWidth: 80 }}
        />
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          Tip: share <code style={{ background:'#f3f4f6', padding:'2px 6px', borderRadius:6 }}>
          {`${window.location.origin}${window.location.pathname}#/start?class=${encodeURIComponent(classCode)}`}
          </code>
        </span>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
        gap: 10
      }}>
        {students.map((sid) => {
        const url = `#/student/assignment?student=${encodeURIComponent(sid)}&class=${encodeURIComponent(classCode)}${lessonParams}`
        return (
          <Link
            key={sid}
            to={`/student/assignment?student=${encodeURIComponent(sid)}&class=${encodeURIComponent(classCode)}${lessonParams}`}

              style={{
                border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff',
                padding: 12, textDecoration: 'none', color: '#111', textAlign: 'center'
              }}
              title={url}
              onClick={() => {
                try { localStorage.setItem('currentStudent', sid) } catch {}
              }}
            >
              {sid}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
