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
  pts: Array<{ x: number; y: number; t?: number }>  // carry t in deltas
  done?: boolean             // true when the peer lifted the pencil
  /** echo guard */
  from?: string
}

export type DrawCanvasHandle = {
  getStrokes: () => StrokesPayload
  loadStrokes: (data: StrokesPayload | null | undefined) => void
  clearStrokes: () => void
  undo: () => void
  /** apply remote stroke deltas (from other students) */
  applyRemote: (u: RemoteStrokeUpdate) => void
}

type Props = {
  width:number; height:number
  color:string; size:number
  mode:'scroll'|'draw'
  // we accept eraserObject in props, but we only DRAW for pen|highlighter|eraser
  tool:'pen'|'highlighter'|'eraser'|'eraserObject'
  /** unique id for this client (e.g., studentCode or socket id) */
  selfId?: string
  /** broadcast local stroke deltas as user draws */
  onStrokeUpdate?: (u: RemoteStrokeUpdate) => void
}

/* ---------- Type guards ---------- */
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

  // Realtime: in-progress strokes from peers (id -> stroke)
  const remoteActive = useRef<Map<string, Stroke>>(new Map())
  // Realtime: finished strokes from peers (kept lightweight)
  const remoteFinished = useRef<Stroke[]>([])

  // Pointer state for two-finger detection & pencil
  const activePointers = useRef<Set<number>>(new Set())
  const drawingPointerId = useRef<number|null>(null)
  const localStrokeId = useRef<string|null>(null) // id for broadcasting

  // DPR-aware canvas setup: always draw in CSS space, scale bitmap by DPR
  const setupCanvas = ()=>{
    const c = canvasRef.current
    if (!c) return
    const rect = c.getBoundingClientRect()
    const cssW = Math.max(1, Math.round(rect.width))
    const cssH = Math.max(1, Math.round(rect.height))
    const dpr  = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1

    // bitmap size
    const bw = Math.max(1, Math.round(cssW * dpr))
    const bh = Math.max(1, Math.round(cssH * dpr))

    if (c.width !== bw) c.width = bw
    if (c.height !== bh) c.height = bh

    // style should reflect CSS size (avoid unexpected stretching)
    c.style.width  = `${cssW}px`
    c.style.height = `${cssH}px`

    const ctx = c.getContext('2d')
    if (!ctx) return
    ctxRef.current = ctx

    // reset then scale so all drawing uses CSS units
    ctx.setTransform(1,0,0,1,0,0)
    ctx.scale(dpr, dpr)
  }

  const redraw = ()=>{
    const ctx = ctxRef.current
    if (!ctx) return
    const c = ctx.canvas
    // clear in CSS space (context already scaled)
    ctx.clearRect(0,0, c.width / (window.devicePixelRatio || 1), c.height / (window.devicePixelRatio || 1))

    // Order: finished remote, finished local, active remote, active local
    for (const s of remoteFinished.current) drawStroke(ctx, s)
    for (const s of strokes.current) drawStroke(ctx, s)
    for (const s of remoteActive.current.values()) drawStroke(ctx, s)
    if (current.current) drawStroke(ctx, current.current)
  }

  // Initialize + respond to size changes
  useEffect(()=>{
    setupCanvas()
    redraw()
    // keep canvas in sync with CSS size changes (parent resizes, DPR changes)
    const c = canvasRef.current
    if (!c) return

    let ro: ResizeObserver | null = null
    if ('ResizeObserver' in window) {
      ro = new ResizeObserver(()=>{ setupCanvas(); redraw() })
      ro.observe(c)
    }
    const onWinResize = ()=>{ setupCanvas(); redraw() }
    window.addEventListener('resize', onWinResize)

    // DPR change (pinch-zoom on some devices) → listen via media query
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onDprChange = ()=>{ setupCanvas(); redraw() }
    if (mq && typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onDprChange)
    }

    return ()=>{
      window.removeEventListener('resize', onWinResize)
      if (ro) ro.disconnect()
      if (mq && typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onDprChange)
    }
    // NOTE: using actual element size via ResizeObserver, so we don't depend on width/height props here
  }, [])

  useEffect(()=>{
    // If parent code changes container size via props, a re-setup helps
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
      // clear remote layers only when explicitly reloading base strokes
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
      // Ignore echoes from self
      if (u.from && selfId && u.from === selfId) return
      // accumulate deltas into a single active stroke per remote id
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
          s.pts.push({ x: p.x, y: p.y, t: typeof p.t === 'number' ? p.t : undefined }) // KEEP t
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
    // CSS-space coordinates (match our scaled context)
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  useEffect(()=>{
    const c = canvasRef.current
    if (!c) return

    const shouldDraw = (e: PointerEvent) => {
      if (mode !== 'draw') return false
      // Draw/broadcast for pen/highlighter/eraser (eraser uses destination-out).
      const allowed = (tool === 'pen' || tool === 'highlighter' || tool === 'eraser' || tool === 'eraserObject')
      if (!allowed) return false
      if (e.pointerType === 'pen') return true // allow Apple Pencil even with palm
      // fingers/mouse: draw only if a single non-pen pointer is down
      return activePointers.current.size <= 1
    }

    const onPointerDown = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.add(e.pointerId)
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

      // broadcast initial point (INCLUDES t)
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
      if (!shouldDraw(e)) {
        // stroke cancelled; finish what we have
        if (current.current.pts.length > 1) strokes.current.push(current.current)
        onStrokeUpdate?.({
          id: localStrokeId.current!, color, size,
          tool: current.current.tool, pts: [], done: true, from: selfId
        })
        current.current = null
        localStrokeId.current = null
        drawingPointerId.current = null
        redraw()
        return
      }
      const p = getPos(e) as StrokePoint
      p.t = stampNow()
      current.current.pts.push(p)
      // broadcast delta (single point WITH t)
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
        // notify completion
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
      try { c.releasePointerCapture(e.pointerId) } catch {}
    }
    const onPointerCancel = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.delete(e.pointerId)
      if (drawingPointerId.current === e.pointerId) endStroke()
      try { c.releasePointerCapture(e.pointerId) } catch {}
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
      // width/height attributes are controlled by setupCanvas() using CSS rect × DPR
      style={{
        position:'absolute', inset:0, zIndex:10,
        display:'block', width:'100%', height:'100%',
        touchAction:'pan-y pinch-zoom', background:'transparent'
      }}
    />
  )
})
