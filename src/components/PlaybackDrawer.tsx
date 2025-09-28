// src/components/PlaybackDrawer.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import PdfCanvas from './PdfCanvas'

export type Props = {
  onClose: () => void
  student: string
  pdfUrl: string
  pageIndex: number
  strokesPayload: any
  audioUrl?: string
}

type Size = { w: number; h: number }

export default function PlaybackDrawer({
  onClose,
  student,
  pdfUrl,
  pageIndex,
  strokesPayload,
  audioUrl,
}: Props) {
  const [size, setSize] = useState<Size>({ w: 800, h: 600 })
  const [anim, setAnim] = useState<'none' | 'replay'>('none')

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animRef = useRef<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Normalize payload (back-compat)
  const normalized = useMemo(() => {
    const payload = strokesPayload || {}
    if (payload && Array.isArray(payload.strokes)) return payload as { strokes: any[] }
    // Some older artifacts may store strokes directly
    if (Array.isArray(payload)) return { strokes: payload }
    return { strokes: [] as any[] }
  }, [strokesPayload])

  // Render all strokes immediately (static)
  function drawAll(ctx: CanvasRenderingContext2D, W: number, H: number) {
    ctx.clearRect(0, 0, W, H)
    const strokes = normalized.strokes || []
    for (const s of strokes) {
      const pts = s.points || []
      if (!pts.length) continue
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = s.color || '#111'
      ctx.lineWidth = s.size || 4
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y)
      }
      ctx.stroke()
    }
  }

  // Replay animation (time-based if t exists; otherwise segment-by-segment)
  function startReplay() {
    if (!canvasRef.current) return
    const ctx = canvasRef.current.getContext('2d')
    if (!ctx) return

    const W = canvasRef.current.width
    const H = canvasRef.current.height
    const strokes = normalized.strokes || []

    // Build a timeline of segments
    type Seg = { x0: number; y0: number; x1: number; y1: number; color: string; size: number; t: number }
    const segs: Seg[] = []
    for (const s of strokes) {
      const pts = s.points || []
      if (pts.length < 2) continue
      const hasT = typeof pts[0]?.t === 'number'
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1]
        const p1 = pts[i]
        const t = hasT ? p1.t : i * 12 // ~12ms fallback
        segs.push({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y, color: s.color || '#111', size: s.size || 4, t })
      }
    }
    segs.sort((a, b) => a.t - b.t)

    ctx.clearRect(0, 0, W, H)
    let start: number | null = null
    let idx = 0

    const step = (ts: number) => {
      if (start == null) start = ts
      const elapsed = ts - start

      while (idx < segs.length && segs[idx].t <= elapsed) {
        const seg = segs[idx]
        ctx.strokeStyle = seg.color
        ctx.lineWidth = seg.size
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        ctx.moveTo(seg.x0, seg.y0)
        ctx.lineTo(seg.x1, seg.y1)
        ctx.stroke()
        idx++
      }

      if (idx < segs.length && animRef.current != null) {
        animRef.current = requestAnimationFrame(step)
      } else {
        animRef.current = null
        setAnim('none')
      }
    }

    animRef.current = requestAnimationFrame(step)
  }

  function cancelReplay() {
    if (animRef.current != null) {
      cancelAnimationFrame(animRef.current)
      animRef.current = null
    }
  }

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (animRef.current != null) cancelAnimationFrame(animRef.current)
    }
  }, [])

  // When switching to replay: clear and animate; when stopping: redraw static
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return

    if (anim === 'replay') {
      ctx.clearRect(0, 0, c.width, c.height)
      // Sync audio to 0 if present
      if (audioRef.current) {
        try { audioRef.current.currentTime = 0; audioRef.current.play().catch(() => {}) } catch {}
      }
      startReplay()
    } else {
      cancelReplay()
      drawAll(ctx, c.width, c.height)
      // Stop audio if playing
      if (audioRef.current) {
        try { audioRef.current.pause() } catch {}
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anim, size.w, size.h, normalized])

  // PdfCanvas tells us its actual pixel size; sync overlay canvas to match 1:1
  function onPdfReady(info: { width?: number; height?: number; cssWidth?: number; cssHeight?: number }) {
    // Prefer device pixel width/height if provided; fall back to css
    const w = info.width ?? info.cssWidth ?? 800
    const h = info.height ?? info.cssHeight ?? 600
    setSize({ w, h })

    // Also immediately draw static strokes on the fresh canvas
    requestAnimationFrame(() => {
      const c = canvasRef.current
      if (!c) return
      c.width = w
      c.height = h
      const ctx = c.getContext('2d')
      if (!ctx) return
      drawAll(ctx, w, h)
    })
  }

  // Download strokes JSON
  function downloadStrokes() {
    const blob = new Blob([JSON.stringify(normalized)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${student || 'student'}_strokes.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(17,24,39,0.55)',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      {/* Panel */}
      <div
        style={{
          background: '#fff',
          width: 'min(1200px, 96vw)',
          height: 'min(92vh, 980px)',
          margin: '2vh auto',
          borderRadius: 12,
          boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: 12,
            borderBottom: '1px solid #e5e7eb',
            background: '#f9fafb',
          }}
        >
          <strong style={{ fontSize: 14 }}>Preview — {student || 'Student'}</strong>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              onClick={() => setAnim(a => (a === 'replay' ? 'none' : 'replay'))}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}
            >
              {anim === 'replay' ? 'Stop Replay' : 'Replay'}
            </button>
            <button
              onClick={downloadStrokes}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}
              title="Download strokes JSON"
            >
              Download
            </button>
            <button
              onClick={onClose}
              style={{
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid #e5e7eb',
                background: '#fff',
              }}
            >
              Close
            </button>
          </div>
        </div>

        {/* Top toolbar (moved from right side) */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: 12,
            borderBottom: '1px solid #e5e7eb',
          }}
        >
          {audioUrl ? (
            <audio ref={audioRef} controls src={audioUrl} style={{ width: 'min(600px, 100%)' }} />
          ) : (
            <span style={{ fontSize: 12, color: '#6b7280' }}>No audio</span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>
            Page {pageIndex + 1}
          </span>
        </div>

        {/* Content: PDF uses the full width; controls are above */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#fafafa' }}>
          <div style={{ position: 'relative', width: `${size.w}px`, margin: '12px auto' }}>
            <div style={{ position: 'relative' }}>
              <PdfCanvas url={pdfUrl} pageIndex={pageIndex} onReady={onPdfReady} />
              <canvas
                ref={canvasRef}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: `${size.w}px`,
                  height: `${size.h}px`,
                  pointerEvents: 'none',
                }}
                width={size.w}
                height={size.h}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
