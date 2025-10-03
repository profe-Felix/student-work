// src/pages/SetupChecklist.tsx
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { ASSET_POLICY } from '../lib/assets'

type Row = { ok: boolean; label: string; detail?: string }

export default function SetupChecklist() {
  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    (async () => {
      const checks: Row[] = []
      checks.push({ ok: !!import.meta.env.VITE_SUPABASE_URL, label: 'Env: VITE_SUPABASE_URL' })
      checks.push({ ok: !!import.meta.env.VITE_SUPABASE_ANON_KEY, label: 'Env: VITE_SUPABASE_ANON_KEY' })

      try {
        const { data: buckets } = await supabase.storage.listBuckets()
        for (const [k, cfg] of Object.entries(ASSET_POLICY)) {
          const b = buckets?.some(b => b.name === (cfg as any).bucket) ?? false
          checks.push({ ok: b, label: `Bucket: ${(cfg as any).bucket}`, detail: (cfg as any).access })
        }
      } catch (e:any) {
        checks.push({ ok: false, label: 'Storage: listBuckets failed', detail: String(e?.message || e) })
      }

      const { error: dbErr } = await supabase.from('assignments').select('id').limit(1)
      checks.push({ ok: !dbErr, label: 'Database: can query assignments', detail: dbErr?.message })

      setRows(checks)
    })()
  }, [])

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      <h1>Project Setup Checklist</h1>
      <p>If anything is ❌, run the migration and create buckets accordingly.</p>
      <ul>
        {rows.map((r,i)=>(
          <li key={i} style={{ margin: '8px 0' }}>
            <strong>{r.ok ? '✅' : '❌'} {r.label}</strong>
            {r.detail ? <div style={{ color:'#555' }}>{r.detail}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
