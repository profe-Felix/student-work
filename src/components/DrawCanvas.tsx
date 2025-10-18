// src/components/DrawCanvas.tsx
import { forwardRef, useImperativeHandle, useRef, useEffect } from 'react'

export type StrokePoint = { x: number; y: number; t?: number } // <-- add t (ms)
export type Stroke = {
  color: string
  size: number
  tool: 'pen'|'highlighter'|'eraser' // <-- include eraser as a stroke tool
  pts: StrokePoint[]
}
export type StrokesPayload = { strokes: Stroke[] }

/** Realtime delta payload */
export type RemoteStrokeUpdate = {
  id: string                 // stable id per in-progress stroke from a peer
  color: string
  size: number
  tool: 'pen'|'highlighter'|'eraser' // <-- allow eraser in RT too
  pts: StrokePoint[]         // new points since last update (can be length 1+), each with t
  done?: boolean             // true when the peer lifted the pencil
  /** NEW: echo guard */
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
        const toolRaw = (s as any).tool
        const tool: Stroke['tool'] =
          toolRaw === 'highlighter' ? 'highlighter'
          : toolRaw === 'eraser' ? 'eraser'
          : 'pen'
        const pts   = Array.isArray((s as any).pts)
          ? (s as any).pts.filter(isPoint)
          : []
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
  // Eraser uses destination-out compositing so it "cuts" previous ink
  if (s.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.globalAlpha = 1
    ctx.strokeStyle = '#000' // color irrelevant in destination-out
  } else {
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = s.tool === 'highlighter' ? 0.35 : 1
    ctx.strokeStyle = s.color
  }
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = s.size
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

  // Monotonic timestamp base so every point (ink/eraser) gets t in ms
  const sessionStartRef = useRef<number>(performance.now())
  const nowMs = () => Math.round(performance.now() - sessionStartRef.current)

  const redraw = ()=>{
    const ctx = ctxRef.current
    if (!ctx) return
    ctx.clearRect(0,0, ctx.canvas.width, ctx.canvas.height)

    // Order: finished remote, finished local, active remote, active local
    for (const s of remoteFinished.current) drawStroke(ctx, s)
    for (const s of strokes.current) drawStroke(ctx, s)
    for (const s of remoteActive.current.values()) drawStroke(ctx, s)
    if (current.current) drawStroke(ctx, current.current)
  }

  useEffect(()=>{
    const c = canvasRef.current
    if (!c) return
    c.width = width; c.height = height
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctxRef.current = ctx
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
      // reset session start so new points have reasonable t relative to newly loaded content
      sessionStartRef.current = performance.now()
      redraw()
    },
    clearStrokes: (): void => {
      strokes.current = []
      current.current = null
      remoteActive.current.clear()
      remoteFinished.current = []
      // reset base time
      sessionStartRef.current = performance.now()
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
        const toolNorm: Stroke['tool'] =
          u.tool === 'highlighter' ? 'highlighter'
          : u.tool === 'eraser' ? 'eraser'
          : 'pen'
        s = { color: u.color, size: u.size, tool: toolNorm, pts: [] }
        remoteActive.current.set(u.id, s)
      }
      if (Array.isArray(u.pts) && u.pts.length > 0) {
        // keep any provided t; if missing, stamp now
        for (const p of u.pts) {
          if (typeof p.t !== 'number') p.t = nowMs()
          s.pts.push(p)
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
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  useEffect(()=>{
    const c = canvasRef.current
    if (!c) return

    const isDrawingTool = (tool: Props['tool']) =>
      tool === 'pen' || tool === 'highlighter' || tool === 'eraser' || tool === 'eraserObject'

    const shouldDraw = (e: PointerEvent) => {
      if (mode !== 'draw') return false
      if (!isDrawingTool(tool)) return false
      if (e.pointerType === 'pen') return true // allow Apple Pencil even with palm
      // fingers/mouse: draw only if a single non-pen pointer is down
      return activePointers.current.size <= 1
    }

    const normalizeTool = (t: Props['tool']): Stroke['tool'] => {
      if (t === 'highlighter') return 'highlighter'
      if (t === 'eraser' || t === 'eraserObject') return 'eraser'
      return 'pen'
    }

    const onPointerDown = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.add(e.pointerId)
      if (!shouldDraw(e)) return
      drawingPointerId.current = e.pointerId
      c.setPointerCapture(e.pointerId)
      const p0 = getPos(e)
      const t0 = nowMs()
      const toolNorm = normalizeTool(tool)
      current.current = { color, size, tool: toolNorm, pts: [{ x: p0.x, y: p0.y, t: t0 }] }
      localStrokeId.current = `${Date.now()}-${Math.random().toString(36).slice(2)}-${e.pointerId}`
      // broadcast initial point (with t)
      onStrokeUpdate?.({
        id: localStrokeId.current,
        color, size, tool: toolNorm, pts: [{ x: p0.x, y: p0.y, t: t0 }], done: false, from: selfId
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
      const p = getPos(e)
      const tNow = nowMs()
      current.current.pts.push({ x: p.x, y: p.y, t: tNow })
      // broadcast delta (single point, with t)
      onStrokeUpdate?.({
        id: localStrokeId.current!, color, size,
        tool: current.current.tool, pts: [{ x: p.x, y: p.y, t: tNow }], done: false, from: selfId
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
      width={width}
      height={height}
      style={{
        position:'absolute', inset:0, zIndex:10,
        display:'block', width:'100%', height:'100%',
        touchAction:'pan-y pinch-zoom', background:'transparent'
      }}
    />
  )
})
