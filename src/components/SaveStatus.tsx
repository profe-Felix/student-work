// src/components/SaveStatus.tsx
import { useEffect, useState } from 'react'

export default function SaveStatus() {
  const [count, setCount] = useState(0)
  useEffect(() => {
    const t = setInterval(() => {
      const n = Object.keys(localStorage).filter(k => k.startsWith('outbox:')).length
      setCount(n)
    }, 1500)
    return () => clearInterval(t)
  }, [])
  if (count === 0) return <div aria-live="polite">✓ All changes saved</div>
  return <div aria-live="polite">⟳ Saving… {count} pending</div>
}
