// src/components/PlaybackDrawer.tsx
import { useEffect, useRef, useState } from 'react'
import PdfCanvas from './PdfCanvas'

type Props = {
  onClose: () => void
  student: string
  pdfUrl: string
  pageIndex: number
  strokesPayload: { strokes?: { color: string; size: number; tool: 'pen'|'highlighter'; pts: {x:number;y:number}[] }[] }
  audioUrl?: string
}

function drawAll(ctx: CanvasRenderingContext2D, payload: Props['strokesPayload']) {
  ctx.clearRect(0,0, ctx.canvas.width, ctx.canvas.height)
  const strokes = Array.isArray(payload?.strokes) ? payload!.strokes! : []
  for (const s of strokes) {
    if (!Array.isArray(s.pts) || s.pts.length === 0) continue
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = s.size
    ctx.globalAlpha = s.tool === 'highlighter' ? 0.35 : 1
    ctx.strokeStyle = s.color
    ctx.beginPath()
    for (let i = 0; i < s.pts.length; i++) {
      const p = s.pts[i]
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
    ctx.restore()
  }
}

export default function PlaybackDrawer(props: Props) {
  const { onClose, student, pdfUrl, pageIndex, strokesPayload, audioUrl } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [anim, setAnim] = useState<'none'|'replay'>('none')
  const animRef = useRef<number | null>(null)

  // When PDF is ready, sync canvas size
  const onPdfReady = (_pdf: any, canvas: HTMLCanvasElement) => {
    try {
      const w = Math.round(parseFloat(getComputedStyle(canvas).width))
      const h = Math.round(parseFloat(getComputedStyle(canvas).height))
      setSize({ w, h })
      // draw once
      const c = canvasRef.current!
      c.width = w; c.height = h
      const ctx = c.getContext('2d')!
      drawAll(ctx, strokesPayload)
    } catch {}
  }

  // Replay animation
  const startReplay = () => {
    if (!canvasRef.current) return
    cancelReplay()
    const c = canvasRef.current
    const ctx = c.getContext('2d')!
    ctx.clearRect(0,0,c.width,c.height)

    const strokes = Array.isArray(strokesPayload?.strokes) ? strokesPayload!.strokes! : []
    let sIdx = 0, pIdx = 0

    const step = () => {
      // finished
      if (sIdx >= strokes.length) { animRef.current = null; return }
      const s = strokes[sIdx]
      if (!s || !Array.isArray(s.pts) || s.pts.length < 2) { sIdx++; pIdx = 0; animRef.current = requestAnimationFrame(step); return }

      // draw segment by segment
      ctx.save()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = s.size
      ctx.globalAlpha = s.tool === 'highlighter' ? 0.35 : 1
      ctx.strokeStyle = s.color
      ctx.beginPath()
      ctx.moveTo(s.pts[0].x, s.pts[0].y)
      for (let i = 1; i <= pIdx && i < s.pts.length; i++) {
        const p = s.pts[i]
        ctx.lineTo(p.x, p.y)
      }
      ctx.stroke()
      ctx.restore()

      pIdx++
      if (pIdx >= s.pts.length) { sIdx++; pIdx = 0 }
      animRef.current = requestAnimationFrame(step)
    }

    animRef.current = requestAnimationFrame(step)
  }

  const cancelReplay = () => {
    if (animRef.current != null) {
      cancelAnimationFrame(animRef.current)
      animRef.current = null
    }
  }

  useEffect(() => {
    // cleanup on unmount
    return () => cancelReplay()
  }, [])

  useEffect(() => {
    if (!canvasRef.current) return
    const c = canvasRef.current
    c.width = size.w; c.height = size.h
    const ctx = c.getContext('2d')!
    if (anim === 'none') {
      cancelReplay()
      drawAll(ctx, strokesPayload)
    } else {
      startReplay()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, anim, strokesPayload])

  return (
    <div
      style={{
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 'min(900px, 92vw)',
        background: '#fff', borderLeft: '1px solid #e5e7eb', zIndex: 20050,
        boxShadow: '-8px 0 24px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column'
      }}
    >
      {/* Header */}
      <div style={{ padding: 12, borderBottom: '1px solid #e5e7eb', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ fontWeight: 700 }}>Review • {student} • Page {props.pageIndex + 1}</div>
        <button onClick={onClose} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb' }}>Close</button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1.2fr 1fr', minHeight: 0 }}>
        {/* Left: PDF + strokes overlay */}
        <div style={{ position: 'relative', padding: 12, overflow: 'auto', background:'#fafafa' }}>
          <div style={{ position: 'relative', width: `${size.w}px`, margin: '0 auto' }}>
            <div style={{ position: 'relative' }}>
              <PdfCanvas url={pdfUrl} pageIndex={pageIndex} onReady={onPdfReady} />
              <canvas ref={canvasRef}
                style={{ position: 'absolute', inset: 0, width: `${size.w}px`, height: `${size.h}px`, pointerEvents: 'none' }}
                width={size.w} height={size.h}
              />
            </div>
          </div>
        </div>

        {/* Right: controls */}
        <div style={{ padding: 12, borderLeft: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setAnim(a => a === 'replay' ? 'none' : 'replay')}
              style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background:'#f9fafb' }}
            >
              {anim === 'replay' ? 'Stop' : 'Replay'}
            </button>
            <button
              onClick={() => {
                // download strokes JSON
                const blob = new Blob([JSON.stringify(strokesPayload || {strokes:[]})], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `strokes-${student}-p${pageIndex+1}.json`
                a.click()
                URL.revokeObjectURL(url)
              }}
              style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background:'#f9fafb' }}
            >
              Download JSON
            </button>
            <button
              onClick={() => {
                // “inked PDF” quick export: download a PNG of the combined canvas area
                const host = (canvasRef.current?.parentElement as HTMLElement)
                if (!host) return
                // Make a temp canvas and draw PDF area (we only have the strokes canvas; export strokes only)
                const c = document.createElement('canvas')
                c.width = canvasRef.current!.width
                c.height = canvasRef.current!.height
                const ctx = c.getContext('2d')!
                // draw only strokes (for v0). For full inked PDF we’d need to re-draw PDF to canvas.
                ctx.drawImage(canvasRef.current!, 0, 0)
                c.toBlob((blob) => {
                  if (!blob) return
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `inked-${student}-p${pageIndex+1}.png`
                  a.click()
                  URL.revokeObjectURL(url)
                }, 'image/png')
              }}
              style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background:'#f9fafb' }}
            >
              Download PNG
            </button>
          </div>

          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Audio</div>
            {audioUrl
              ? <audio src={audioUrl} controls style={{ width: '100%' }} />
              : <div style={{ color: '#6b7280' }}>No audio</div>
            }
          </div>

          <div style={{ marginTop: 'auto', color: '#6b7280', fontSize: 12 }}>
            v0 — read only. We’ll add teacher comments/grades next.
          </div>
        </div>
      </div>
    </div>
  )
}
