// src/pages/start.tsx
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const makeRoster = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}_${String(i + 1).padStart(2, '0')}`)

function __getRoomId() {
  try {
    const h = typeof window !== 'undefined' ? window.location.hash : '';
    const search = (h && h.includes('?')) ? ('?' + h.split('?')[1]) : (typeof window !== 'undefined' ? window.location.search : '');
    const p = new URLSearchParams(search || '');
    const room = p.get('room') || sessionStorage.getItem('room') || 'default';
    try { sessionStorage.setItem('room', room); } catch {}
    return room;
  } catch { return 'default'; }
}

export default function Start() {
  const nav = useNavigate()

  // Allow picking class letter if you later add more classes (A, B, C…)
  const [klass, setKlass] = useState<string>(() => {
    const saved = localStorage.getItem('currentClass') || 'A'
    return saved
  })
  const [count, setCount] = useState<number>(28)

  const roster = useMemo(() => makeRoster(klass, count), [klass, count])

  const go = (studentId: string) => {
    try { localStorage.setItem('currentStudent', studentId) } catch {}
    try { localStorage.setItem('currentClass', klass) } catch {}
    nav(`/student/assignment?student=${encodeURIComponent(studentId)}&room=${encodeURIComponent(__getRoomId())}`)
  }

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ marginBottom: 12 }}>Pick Student</h2>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label>
          Class:&nbsp;
          <select value={klass} onChange={(e) => setKlass(e.target.value)}>
            {['A','B','C','D','E'].map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>

        <label>
          Count:&nbsp;
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[20, 24, 28, 30, 32].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
          gap: 10
        }}
      >
        {roster.map((id: string) => (
          <button
            key={id}
            onClick={() => go(id)}
            style={{
              padding: '14px 10px',
              borderRadius: 12,
              border: '1px solid #e5e7eb',
              background: '#fff',
              fontSize: 18,
              fontWeight: 700
            }}
          >
            {id}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 16, color: '#6b7280', fontSize: 12 }}>
        Tip: the last picked student persists for quick access.
      </div>
    </div>
  )
}
