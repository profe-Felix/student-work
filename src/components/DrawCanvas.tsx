// src/components/DrawCanvas.tsx
import { forwardRef, useImperativeHandle, useRef, useEffect } from 'react'

export type StrokePoint = { x: number; y: number; t?: number }
export type Stroke = {
  color: string
  size: number
  tool: 'pen' | 'highlighter' | 'eraser'
  pts: StrokePoint[]
}
export type StrokesPayload = { strokes: Stroke[] }

/** Realtime delta payload */
export type RemoteStrokeUpdate = {
  id: string                 // stable id per in-progress stroke from a peer
  color: string
  size: number
  tool: 'pen' | 'highlighter' | 'eraser'
  pts: Array<{ x: number; y: number; t?: number }>
  done?: boolean
  from?: string
}

export type DrawCanvasHandle = {
  getStrokes: () => StrokesPayload
  loadStrokes: (data: StrokesPayload | null | undefined) => void
  clearStrokes: () => void
  undo: () => void
  applyRemote: (u: RemoteStrokeUpdate) => void
}

type Props = {
  width:number; height:number
  color:string; size:number
  mode:'scroll'|'draw'
  tool:'pen'|'highlighter'|'eraser'|'eraserObject'
  selfId?: string
  onStrokeUpdate?: (u: RemoteStrokeUpdate) => void
}

/* ---------- Type guards & normalize ---------- */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
function isPoint(v: unknown): v is StrokePoint {
  return isRecord(v) && Number.isFinite((v as any).x) && Number.isFinite((v as any).y)
}
function isStroke(v: unknown): v is Stroke {
  if (!isRecord(v)) return false
  const color = typeof v.color === 'string'
  const size  = Number.isFinite((v as any).size)
  const tool  = v.tool === 'pen' || v.tool === 'highlighter' || v.tool === 'eraser'
  const pts   = Array.isArray((v as any).pts) && (v as any).pts.every(isPoint)
  return color && size && tool && pts
}
function normalize(input: StrokesPayload | null | undefined): StrokesPayload {
  if (!isRecord(input) || !Array.isArray((input as any).strokes)) {
    return { strokes: [] }
  }
  const raw = (input as any).strokes as unknown[]
  const safe: Stroke[] = raw
    .map((s) => {
      if (isStroke(s)) return s
      if (isRecord(s)) {
        const color = typeof s.color === 'string' ? (s as any).color as string : '#000000'
        const size  = Number.isFinite((s as any).size) ? (s as any).size as number : 4
        const tRaw  = (s as any).tool
        const tool  : Stroke['tool'] =
          tRaw === 'highlighter' ? 'highlighter' :
          tRaw === 'eraser'      ? 'eraser'      : 'pen'
        const pts   = Array.isArray((s as any).pts) ? (s as any).pts.filter(isPoint) :
                      Array.isArray((s as any).points) ? (s as any).points.filter(isPoint) : []
        return { color, size, tool, pts }
      }
      return null
    })
    .filter((x): x is Stroke => !!x)
  return { strokes: safe }
}

/* ---------- Render helpers ---------- */
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  if (!s.pts || s.pts.length === 0) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (s.tool === 'highlighter') {
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = s.color
    ctx.lineWidth = Math.max(1, s.size * 2)
    ctx.globalAlpha = 0.35
  } else if (s.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.strokeStyle = '#000'
    ctx.lineWidth = Math.max(1, s.size * 2)
    ctx.globalAlpha = 1
  } else {
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = s.color
    ctx.lineWidth = Math.max(1, s.size)
    ctx.globalAlpha = 1
  }

  ctx.beginPath()
  for (let i = 0; i < s.pts.length; i++) {
    const p = s.pts[i]
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  }
  ctx.stroke()
  ctx.restore()
}

export default forwardRef<DrawCanvasHandle, Props>(function DrawCanvas(
  { width, height, color, size, mode, tool, selfId, onStrokeUpdate },
  ref
){
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctxRef    = useRef<CanvasRenderingContext2D|null>(null)

  // timeline base so all points have small, relative ms
  const sessionStartRef = useRef<number | null>(null)
  function stampNow(): number {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
    if (sessionStartRef.current == null) sessionStartRef.current = now
    return now - sessionStartRef.current
  }

  // Local finished strokes + in-progress local stroke
  const strokes   = useRef<Stroke[]>([])
  const current   = useRef<Stroke|null>(null)

  // Realtime
  const remoteActive = useRef<Map<string, Stroke>>(new Map())
  const remoteFinished = useRef<Stroke[]>([])

  const activePointers = useRef<Set<number>>(new Set())
  const drawingPointerId = useRef<number|null>(null)
  const localStrokeId = useRef<string|null>(null)

  /** DPR-aware canvas setup that TRUSTS props width/height (no rect re-measure). */
  const setupCanvas = ()=>{
    const c = canvasRef.current
    if (!c) return
    const cssW = Math.max(1, Math.round(width))
    const cssH = Math.max(1, Math.round(height))
    const dpr  = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1

    const bw = Math.max(1, Math.round(cssW * dpr))
    const bh = Math.max(1, Math.round(cssH * dpr))

    if (c.width !== bw) c.width = bw
    if (c.height !== bh) c.height = bh

    // Style reflects CSS size exactly
    c.style.width  = `${cssW}px`
    c.style.height = `${cssH}px`

    const ctx = c.getContext('2d')
    if (!ctx) return
    ctxRef.current = ctx

    // Reset then scale so all drawing uses CSS units
    ctx.setTransform(1,0,0,1,0,0)
    ctx.scale(dpr, dpr)
  }

  const redraw = ()=>{
    const ctx = ctxRef.current
    if (!ctx) return
    const c = ctx.canvas
    // clear in CSS space (context already scaled to DPR)
    ctx.clearRect(0,0, c.width, c.height)

    for (const s of remoteFinished.current) drawStroke(ctx, s)
    for (const s of strokes.current) drawStroke(ctx, s)
    for (const s of remoteActive.current.values()) drawStroke(ctx, s)
    if (current.current) drawStroke(ctx, current.current)
  }

  // Initialize + respond to prop-driven size changes ONLY
  useEffect(()=>{
    setupCanvas()
    redraw()
  }, [width, height])

  useEffect(()=>{
    const c = canvasRef.current
    if (!c) return
    if (mode === 'scroll') {
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
    } else {
      c.style.pointerEvents = 'auto'
      c.style.touchAction   = 'pan-y pinch-zoom'
    }
  }, [mode])

  useImperativeHandle(ref, () => ({
    getStrokes: (): StrokesPayload => ({ strokes: strokes.current }),
    loadStrokes: (data: StrokesPayload | null | undefined): void => {
      const safe = normalize(data)
      strokes.current = safe.strokes
      current.current = null
      remoteActive.current.clear()
      remoteFinished.current = []
      redraw()
    },
    clearStrokes: (): void => {
      strokes.current = []
      current.current = null
      remoteActive.current.clear()
      remoteFinished.current = []
      redraw()
    },
    undo: (): void => {
      strokes.current.pop()
      redraw()
    },
    applyRemote: (u) => {
      if (u.from && selfId && u.from === selfId) return
      let s = remoteActive.current.get(u.id)
      if (!s) {
        const t: Stroke['tool'] =
          u.tool === 'highlighter' ? 'highlighter' :
          u.tool === 'eraser'      ? 'eraser'      : 'pen'
        s = { color: u.color, size: u.size, tool: t, pts: [] }
        remoteActive.current.set(u.id, s)
      }
      if (Array.isArray(u.pts) && u.pts.length > 0) {
        for (const p of u.pts) {
          s.pts.push({ x: p.x, y: p.y, t: typeof p.t === 'number' ? p.t : undefined })
        }
      }
      if (u.done) {
        remoteActive.current.delete(u.id)
        if (s.pts.length > 1) remoteFinished.current.push(s)
      }
      redraw()
    }
  }))

  const getPos = (e: PointerEvent)=>{
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    // CSS-space coordinates (context already scaled to DPR)
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // NEW: helper to safely release pointer capture
  function releaseCaptureIfAny(c: HTMLCanvasElement, id: number | null) {
    if (id == null) return
    try { c.releasePointerCapture(id) } catch {}
  }

  useEffect(()=>{
    const c = canvasRef.current
    if (!c) return

    const shouldDraw = (e: PointerEvent) => {
      if (mode !== 'draw') return false
      const allowed = (tool === 'pen' || tool === 'highlighter' || tool === 'eraser' || tool === 'eraserObject')
      if (!allowed) return false
      if (e.pointerType === 'pen') return true
      // allow a single finger; disallow once a second touch is down
      return activePointers.current.size <= 1
    }

    const onPointerDown = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.add(e.pointerId)

      // If this touch shouldn't start a draw (e.g., second finger), let the browser handle scroll/zoom.
      if (!shouldDraw(e)) return

      drawingPointerId.current = e.pointerId
      c.setPointerCapture(e.pointerId)

      const p = getPos(e) as StrokePoint
      p.t = stampNow()

      const t: Stroke['tool'] =
        tool === 'highlighter' ? 'highlighter' :
        (tool === 'eraser' || tool === 'eraserObject') ? 'eraser' : 'pen'

      current.current = { color, size, tool: t, pts: [p] }
      localStrokeId.current = `${Date.now()}-${Math.random().toString(36).slice(2)}-${e.pointerId}`

      onStrokeUpdate?.({
        id: localStrokeId.current!,
        color, size, tool: t, pts: [p], done: false, from: selfId
      })
      redraw()
      ;(e as any).preventDefault?.()
    }

    const onPointerMove = (e: PointerEvent)=>{
      if (drawingPointerId.current !== e.pointerId) return
      if (!current.current) return

      // If we shouldn't draw anymore (e.g., second finger went down),
      // end the stroke and RELEASE CAPTURE so the page can scroll/pinch.
      if (!shouldDraw(e)) {
        if (current.current.pts.length > 1) {
          strokes.current.push(current.current)
          onStrokeUpdate?.({
            id: localStrokeId.current!, color, size,
            tool: current.current.tool, pts: [], done: true, from: selfId
          })
        }
        current.current = null
        localStrokeId.current = null
        releaseCaptureIfAny(c, drawingPointerId.current)
        drawingPointerId.current = null
        redraw()
        return
      }

      const p = getPos(e) as StrokePoint
      p.t = stampNow()
      current.current.pts.push(p)
      onStrokeUpdate?.({
        id: localStrokeId.current!, color, size,
        tool: current.current.tool, pts: [p], done: false, from: selfId
      })
      redraw()
      ;(e as any).preventDefault?.()
    }

    const endStroke = ()=>{
      if (current.current) {
        if (current.current.pts.length > 1) strokes.current.push(current.current)
        onStrokeUpdate?.({
          id: localStrokeId.current!, color, size,
          tool: current.current.tool, pts: [], done: true, from: selfId
        })
        current.current = null
        localStrokeId.current = null
        redraw()
      }
      drawingPointerId.current = null
    }

    const onPointerUp = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.delete(e.pointerId)
      if (drawingPointerId.current === e.pointerId) endStroke()
      releaseCaptureIfAny(c, e.pointerId)
    }
    const onPointerCancel = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.delete(e.pointerId)
      if (drawingPointerId.current === e.pointerId) endStroke()
      releaseCaptureIfAny(c, e.pointerId)
    }

    c.addEventListener('pointerdown', onPointerDown as EventListener, { passive:false })
    c.addEventListener('pointermove', onPointerMove as EventListener, { passive:false })
    c.addEventListener('pointerup', onPointerUp as EventListener, { passive:true })
    c.addEventListener('pointercancel', onPointerCancel as EventListener, { passive:true })
    return ()=>{
      c.removeEventListener('pointerdown', onPointerDown as EventListener)
      c.removeEventListener('pointermove', onPointerMove as EventListener)
      c.removeEventListener('pointerup', onPointerUp as EventListener)
      c.removeEventListener('pointercancel', onPointerCancel as EventListener)
      activePointers.current.clear()
      drawingPointerId.current = null
      localStrokeId.current = null
    }
  }, [mode, color, size, tool, selfId, onStrokeUpdate])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position:'absolute', inset:0, zIndex:10,
        display:'block',
        width:`${Math.max(1, Math.round(width))}px`,
        height:`${Math.max(1, Math.round(height))}px`,
        // Leave this as pan-y pinch-zoom so two-finger scroll & pinch work in draw mode
        touchAction:'pan-y pinch-zoom',
        background:'transparent'
      }}
    />
  )
})
