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

type PtT = { x:number; y:number; t:number }
type DrawOp = { type:'draw'; color:string; size:number; tool?:'pen'|'highlighter'; pts:PtT[]; t0:number; t1:number }
type EraseOp = { type:'erase'; radius:number; mode?:'soft'|'object'; pts:PtT[]; t0:number; t1:number }
type Op = DrawOp | EraseOp

type OverlaySize = { cssW:number; cssH:number; dpr:number }

const N = (v:any)=> Number.isFinite(+v) ? +v : 0

function parseOps(payload:any): { w:number; h:number; ops:Op[] } {
  let raw = payload
  try { if (typeof raw === 'string') raw = JSON.parse(raw) } catch {}
  const w = N(raw?.w ?? raw?.canvasWidth ?? raw?.width)
  const h = N(raw?.h ?? raw?.canvasHeight ?? raw?.height)
  const opsIn = Array.isArray(raw?.ops) ? raw.ops : []

  // Normalize: keep only draw/erase with numeric times; shift timeline so t0>=0
  let minT = Infinity, maxT = 0
  const cleaned: Op[] = []

  for (const o of opsIn) {
    if (!o || (o.type !== 'draw' && o.type !== 'erase')) continue
    const pts = Array.isArray(o.pts) ? o.pts.map((p:any)=>({ x:N(p.x), y:N(p.y), t:N(p.t) })) : []
    if (pts.length === 0) continue
    const t0 = Math.min(...pts.map(p=>p.t))
    const t1 = Math.max(...pts.map(p=>p.t))
    if (!isFinite(t0) || !isFinite(t1)) continue

    if (o.type === 'draw') {
      cleaned.push({ type:'draw', color: o.color || '#111', size:N(o.size || 4), tool:o.tool, pts, t0, t1 })
    } else {
      cleaned.push({ type:'erase', radius:N(o.radius || o.size || 10), mode:o.mode || 'soft', pts, t0, t1 })
    }
    if (t0 < minT) minT = t0
    if (t1 > maxT) maxT = t1
  }

  if (!isFinite(minT)) minT = 0
  const shift = minT
  const normalized = cleaned.map(op => ({
    ...op,
    pts: op.pts.map(p => ({ ...p, t: p.t - shift })),
    t0: op.t0 - shift,
    t1: op.t1 - shift,
  })) as Op[]

  return { w, h, ops: normalized.sort((a,b)=>a.t0 - b.t0) }
}

export default function PlaybackDrawer({
  onClose, student, pdfUrl, pageIndex, strokesPayload, audioUrl
}: Props) {
  const [overlay, setOverlay] = useState<OverlaySize>({
    cssW: 800, cssH: 600, dpr: window.devicePixelRatio || 1
  })
  const pdfCssRef = useRef<{ w:number; h:number }>({ w: 800, h: 600 })
  const overlayRef = useRef<HTMLCanvasElement|null>(null)
  const pdfHostRef = useRef<HTMLDivElement|null>(null)
  const audioRef = useRef<HTMLAudioElement|null>(null)
  const rafRef = useRef<number|null>(null)

  const parsed = useMemo(()=>parseOps(strokesPayload), [strokesPayload])
  const ops = parsed.ops
  const durationMs = ops.length ? Math.max(...ops.map(o=>o.t1)) : 0

  // scrub state (start at 0)
  const [scrubbing, setScrubbing] = useState(false)
  const [scrubMs, setScrubMs] = useState(0)
  const [syncToAudio, setSyncToAudio] = useState(!!audioUrl)
  const [strokesPlaying, setStrokesPlaying] = useState(false) // legacy path (kept for UI parity)

  // Keep slider bounds in sync
  useEffect(()=>{ setScrubMs(0) }, [durationMs])

  // Bind overlay to PDF size
  useEffect(() => {
    const host = pdfHostRef.current
    if (!host) return

    const findPdfCanvas = () => {
      const canvases = Array.from(host.querySelectorAll('canvas')) as HTMLCanvasElement[]
      const overlayEl = overlayRef.current
      return canvases.find(c => c !== overlayEl) || null
    }

    const syncSize = () => {
      const pdfC = findPdfCanvas(); if (!pdfC) return
      const rect = pdfC.getBoundingClientRect()
      const cssW = Math.max(1, Math.round(rect.width))
      const cssH = Math.max(1, Math.round(rect.height))
      const dpr  = window.devicePixelRatio || 1
      setOverlay(prev => (prev.cssW===cssW && prev.cssH===cssH && prev.dpr===dpr) ? prev : { cssW, cssH, dpr })
    }

    syncSize()
    let ro: ResizeObserver | null = null
    const pdfC = findPdfCanvas()
    if (pdfC && 'ResizeObserver' in window) { ro = new ResizeObserver(syncSize); ro.observe(pdfC) }
    const onResize = () => syncSize()
    window.addEventListener('resize', onResize)

    const poll = window.setInterval(syncSize, 200)
    const stopPoll = window.setTimeout(()=>window.clearInterval(poll), 3000)

    return () => {
      window.removeEventListener('resize', onResize)
      if (ro) ro.disconnect()
      window.clearInterval(poll)
      window.clearTimeout(stopPoll)
    }
  }, [pdfUrl, pageIndex])

  function ensureCtx(): CanvasRenderingContext2D | null {
    const c = overlayRef.current; if (!c) return null
    const { cssW, cssH, dpr } = overlay
    c.style.width  = `${cssW}px`
    c.style.height = `${cssH}px`
    const bw = Math.max(1, Math.round(cssW * dpr))
    const bh = Math.max(1, Math.round(cssH * dpr))
    if (c.width !== bw)  c.width = bw
    if (c.height !== bh) c.height = bh
    const ctx = c.getContext('2d'); if (!ctx) return null
    ctx.setTransform(1,0,0,1,0,0)
    ctx.scale(dpr, dpr)
    return ctx
  }

  // scale from capture space to current CSS space
  const sw = parsed.w || pdfCssRef.current.w
  const sh = parsed.h || pdfCssRef.current.h
  function withScale(ctx:CanvasRenderingContext2D, draw:()=>void){
    const sx = overlay.cssW / Math.max(1, sw)
    const sy = overlay.cssH / Math.max(1, sh)
    ctx.save(); ctx.scale(sx, sy); draw(); ctx.restore()
  }

  function drawOp(ctx:CanvasRenderingContext2D, op:Op, upToMs:number){
    if (op.t0 > upToMs) return
    const pts = op.pts.filter(p => p.t <= upToMs)
    if (pts.length === 0) return
    if (op.type === 'draw') {
      const isHi = op.tool === 'highlighter'
      ctx.globalAlpha = isHi ? 0.35 : 1
      ctx.strokeStyle = op.color || '#111'
      ctx.lineWidth   = Math.max(1, isHi ? op.size * 1.5 : op.size)
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      if (pts.length === 1) {
        const p = pts[0]
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, op.size*0.5), 0, Math.PI*2); ctx.fillStyle = op.color || '#111'; ctx.fill()
      } else {
        ctx.beginPath()
        ctx.moveTo(pts[0].x, pts[0].y)
        for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    } else {
      // ERASE
      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(1, op.radius)
      if (pts.length === 1) {
        const p = pts[0]
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, op.radius*0.5), 0, Math.PI*2); ctx.fill()
      } else {
        ctx.beginPath()
        ctx.moveTo(pts[0].x, pts[0].y)
        for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y)
        ctx.stroke()
      }
      ctx.restore()
    }
  }

  function drawAt(ms:number){
    const ctx = ensureCtx(); if (!ctx) return
    const { cssW, cssH } = overlay
    ctx.clearRect(0,0,cssW,cssH)
    withScale(ctx, () => {
      for (const op of ops) drawOp(ctx, op, ms)
    })
  }

  function stopRAF(){ if (rafRef.current!=null){ cancelAnimationFrame(rafRef.current); rafRef.current=null } }

  // Initial static frame
  useEffect(()=>{ drawAt(scrubMs) }, [overlay.cssW, overlay.cssH, overlay.dpr, sw, sh, strokesPayload])

  // Audio sync → draw by time
  useEffect(()=>{
    if (!syncToAudio) { stopRAF(); return }
    const el = audioRef.current; if (!el) return
    const onPlay = ()=>{ stopRAF(); const loop=()=>{ drawAt(el.currentTime*1000); rafRef.current=requestAnimationFrame(loop) }; rafRef.current=requestAnimationFrame(loop) }
    const onPause=()=>{ stopRAF(); drawAt(el.currentTime*1000) }
    const onSeek =()=>{ drawAt(el.currentTime*1000) }
    const onTime =()=>{ if (!rafRef.current) drawAt(el.currentTime*1000) }
    const onEnd =()=>{ stopRAF(); drawAt(durationMs) }
    el.addEventListener('play',onPlay)
    el.addEventListener('pause',onPause)
    el.addEventListener('seeked',onSeek)
    el.addEventListener('timeupdate',onTime)
    el.addEventListener('ended',onEnd)
    drawAt(el.currentTime*1000)
    return ()=>{ el.removeEventListener('play',onPlay); el.removeEventListener('pause',onPause); el.removeEventListener('seeked',onSeek); el.removeEventListener('timeupdate',onTime); el.removeEventListener('ended',onEnd); stopRAF() }
  }, [syncToAudio, durationMs, overlay.cssW, overlay.cssH, overlay.dpr, sw, sh, ops.length])

  // Legacy “Replay Strokes” button (kept, but will just scrub time forward)
  useEffect(()=>{
    if (!strokesPlaying) return
    const start = performance.now()
    const tick = ()=>{
      const t = performance.now() - start
      const ms = Math.min(t, durationMs)
      drawAt(ms)
      if (ms >= durationMs) { setStrokesPlaying(false); return }
      rafRef.current = requestAnimationFrame(tick)
    }
    stopRAF()
    rafRef.current = requestAnimationFrame(tick)
    return ()=> stopRAF()
  }, [strokesPlaying, durationMs, overlay.cssW, overlay.cssH, overlay.dpr, sw, sh])

  const hasAudio = !!audioUrl

  return (
    <div role="dialog" aria-modal="true" style={{ position:'fixed', inset:0, background:'rgba(17,24,39,0.55)', display:'flex', justifyContent:'center', zIndex:50 }}>
      <div style={{ background:'#fff', width:'min(1200px, 96vw)', height:'min(92vh, 980px)', margin:'2vh auto', borderRadius:12, boxShadow:'0 10px 30px rgba(0,0,0,0.2)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:12, borderBottom:'1px solid #e5e7eb', background:'#f9fafb' }}>
          <strong style={{ fontSize:14 }}>Preview — {student || 'Student'}</strong>
          <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
            <button
              onClick={() => { setSyncToAudio(false); setScrubbing(false); setStrokesPlaying(p => !p) }}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}
              title="Replay (time-based)"
            >
              {strokesPlaying ? 'Stop' : 'Replay'}
            </button>
            <button
              onClick={() => { setStrokesPlaying(false); setScrubbing(false); setSyncToAudio(s => !s) }}
              disabled={!hasAudio}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background: hasAudio ? '#fff' : '#f3f4f6' }}
              title={hasAudio ? 'Tie ink to audio playback' : 'No audio available'}
            >
              {syncToAudio ? 'Sync: ON' : 'Sync: OFF'}
            </button>
            <button
              onClick={() => { setStrokesPlaying(false); setSyncToAudio(false); setScrubbing(s=>!s); const startAt = 0; setScrubMs(startAt); drawAt(startAt) }}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background: scrubbing ? '#fee2e2' : '#fff' }}
              title="Scrub through ops"
            >
              {scrubbing ? 'Exit Scrub' : 'Scrub'}
            </button>
            <button onClick={onClose} style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}>
              Close
            </button>
          </div>
        </div>

        {/* Controls */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:12, borderBottom:'1px solid #e5e7eb' }}>
          {hasAudio ? (<audio ref={audioRef} controls src={audioUrl} style={{ width:'min(600px, 100%)' }} />) : (<span style={{ fontSize:12, color:'#6b7280' }}>No audio</span>)}
          <span style={{ marginLeft:'auto', fontSize:12, color:'#6b7280' }}>Page {pageIndex + 1}</span>
        </div>

        {/* Content */}
        <div style={{ flex:1, minHeight:0, overflow:'auto', background:'#fafafa' }}>
          <div ref={pdfHostRef} style={{ position:'relative', width:`${overlay.cssW}px`, margin:'12px auto' }}>
            <div style={{ position:'relative' }}>
              <PdfCanvas
                url={pdfUrl}
                pageIndex={pageIndex}
                onReady={(_pdf:any, canvas:HTMLCanvasElement) => {
                  const rect = canvas.getBoundingClientRect()
                  pdfCssRef.current = { w: Math.max(1, Math.round(rect.width)), h: Math.max(1, Math.round(rect.height)) }
                  const dpr = window.devicePixelRatio || 1
                  setOverlay(prev => {
                    const cssW = pdfCssRef.current.w, cssH = pdfCssRef.current.h
                    return (prev.cssW === cssW && prev.cssH === cssH && prev.dpr === dpr) ? prev : { cssW, cssH, dpr }
                  })
                }}
              />
              <canvas ref={overlayRef} style={{ position:'absolute', inset:0, width:`${overlay.cssW}px`, height:`${overlay.cssH}px`, pointerEvents:'none' }} />
            </div>
          </div>
        </div>

        {/* Scrubber */}
        <div style={{ padding: 12, borderTop: '1px solid #e5e7eb', background: '#fff' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, opacity: scrubbing ? 1 : 0.6 }}>
            <span style={{ width: 40, textAlign:'right', fontSize:12, color:'#6b7280' }}>{Math.round(scrubMs/1000)}s</span>
            <input
              type="range"
              min={0}
              max={Math.max(0, durationMs)}
              step={1}
              value={Math.min(durationMs, Math.max(0, scrubMs))}
              onChange={(e)=>{ const v = Math.min(durationMs, Math.max(0, parseInt(e.target.value,10))); setScrubMs(v); if (scrubbing) drawAt(v) }}
              style={{ flex:1 }}
              disabled={!scrubbing || durationMs <= 0}
            />
            <span style={{ width: 40, fontSize:12, color:'#6b7280' }}>{Math.round(durationMs/1000)}s</span>
          </div>
          {!scrubbing && <div style={{ marginTop:6, fontSize:12, color:'#6b7280' }}>Tip: Scrub shows drawing + erasing in order.</div>}
        </div>
      </div>
    </div>
  )
}
