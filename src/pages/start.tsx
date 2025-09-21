import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listStudents } from '../lib/db'

const DEFAULT_COUNT = 28

function makeIds(letter: string, count: number) {
  const ids: string[] = []
  for (let i = 1; i <= count; i++) ids.push(`${letter}_${String(i).padStart(2, '0')}`)
  return ids
}

export default function StartPicker() {
  const nav = useNavigate()
  const [letter, setLetter] = useState<string>(() => localStorage.getItem('teacherLetter') || 'A')
  const [count, setCount] = useState<number>(() => Number(localStorage.getItem('rosterCount') || DEFAULT_COUNT))
  const [dbIds, setDbIds] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)

  // union: generated + DB (no dupes), sorted
  const ids = useMemo(() => {
    const base = makeIds(letter, count)
    const fromDb = dbIds ?? []
    const set = new Set<string>([...base, ...fromDb])
    return Array.from(set).sort()
  }, [dbIds, letter, count])

  useEffect(() => {
    localStorage.setItem('teacherLetter', letter)
    localStorage.setItem('rosterCount', String(count))
  }, [letter, count])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const rows = await listStudents(letter)
        if (!cancelled && rows && rows.length) {
          setDbIds(rows.map(r => r.id))
        } else {
          setDbIds([])
        }
      } catch {
        setDbIds([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [letter])

  const pick = (id: string) => {
    localStorage.setItem('currentStudent', id)
    nav(`/student/assignment?student=${encodeURIComponent(id)}`)
  }

  return (
    <div style={{ minHeight: '100vh', background: '#fafafa', padding: 16 }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <h1 style={{ margin: '12px 0' }}>Pick Your Number</h1>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <label>Class letter:</label>
          <select value={letter} onChange={e => setLetter(e.target.value)} style={{ padding: '6px 8px' }}>
            {['A', 'B', 'C', 'D', 'E', 'F'].map(L => <option key={L} value={L}>{L}</option>)}
          </select>

          <label>Count:</label>
          <select value={count} onChange={e => setCount(Number(e.target.value))} style={{ padding: '6px 8px' }}>
            {[20, 22, 24, 26, 28, 30, 32].map(n => <option key={n} value={n}>{n}</option>)}
          </select>

          {loading && <span>Loading roster…</span>}
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(110px, 1fr))', gap:12 }}>
          {ids.map(id => (
            <button key={id} onClick={() => pick(id)}
              style={{ aspectRatio:'1 / 1', background:'#fff', border:'2px solid #e5e7eb',
                       borderRadius:16, fontSize:24, fontWeight:800,
                       boxShadow:'0 4px 10px rgba(0,0,0,0.06)' }}>
              {id}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 16, fontSize: 12, color: '#6b7280' }}>
          Tip: shows all numbers {letter}_01…{letter}_{String(count).padStart(2,'0')}.  
          If a number is new, be sure you’ve **seeded students** or enabled the **insert policy** so saving works.
        </div>
      </div>
    </div>
  )
}
