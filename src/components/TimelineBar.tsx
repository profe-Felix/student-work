// src/components/TimelineBar.tsx
import React from 'react'
import type { AudioSeg } from '../types/timeline'

type Props = {
  widthPx: number
  heightPx?: number
  durationMs: number
  audio: AudioSeg[]
  onDelete?: (id: string) => void
}

export default function TimelineBar({ widthPx, heightPx=40, durationMs, audio, onDelete }: Props) {
  const total = Math.max(1, durationMs)
  return (
    <div style={{
      width: widthPx, height: heightPx,
      border: '1px solid #e5e7eb', borderRadius: 8, background:'#fafafa',
      position:'relative', overflow:'hidden'
    }}>
      {audio.map(seg => {
        const startPct = Math.max(0, Math.min(100, (seg.startMs / total) * 100))
        const endPct = Math.max(startPct, Math.min(100, ((seg.startMs + seg.durationMs) / total) * 100))
        const left = `${startPct}%`
        const width = `${Math.max(0.75, endPct - startPct)}%`
        return (
          <div key={seg.id} title={`${Math.round(seg.startMs/1000)}s → ${Math.round((seg.startMs+seg.durationMs)/1000)}s`}
            style={{
              position:'absolute', left, top:4, width, height: heightPx-8,
              background:'#dbeafe', border:'1px solid #93c5fd', borderRadius:6,
              display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, color:'#1e40af'
            }}>
            <span style={{ pointerEvents:'none' }}>audio</span>
            {onDelete && (
              <button onClick={()=>onDelete(seg.id)} style={{
                position:'absolute', right:4, top:4, border:'none', background:'transparent', color:'#1e3a8a', cursor:'pointer'
              }}>✕</button>
            )}
          </div>
        )
      })}
    </div>
  )
}
