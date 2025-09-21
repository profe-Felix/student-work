import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

type Tool = 'pen' | 'highlighter' | 'eraser' | 'eraserObject'

type Point = { x:number; y:number }

type Stroke = {
  tool: 'pen' | 'highlighter' | 'eraser'; // object eraser doesn't add a stroke
  color: string;
  size: number;
  points: Point[];
}

type HistoryAdd = { type:'add'; index:number }                // index where stroke lives now (end)
type HistoryRemove = { type:'remove'; index:number; stroke: Stroke } // removed stroke + original index
type HistoryItem = HistoryAdd | HistoryRemove

export type DrawCanvasHandle = {
  undo: () => void;
}

// Distance from point to segment
function distPointToSeg(px:number, py:number, x1:number, y1:number, x2:number, y2:number){
  const vx = x2 - x1, vy = y2 - y1
  const wx = px - x1, wy = py - y1
  const c1 = vx*wx + vy*wy
  if (c1 <= 0) return Math.hypot(px - x1, py - y1)
  const c2 = vx*vx + vy*vy
  if (c2 <= c1) return Math.hypot(px - x2, py - y2)
  const b = c1 / c2
  const bx = x1 + b*vx, by = y1 + b*vy
  return Math.hypot(px - bx, py - by)
}

// Quick bbox overlap test for two segments (with padding)
function segsBBoxOverlap(ax:number, ay:number, bx:number, by:number, cx:number, cy:number, dx:number, dy:number, pad:number){
  const min1x = Math.min(ax, bx) - pad, max1x = Math.max(ax, bx) + pad
  const min1y = Math.min(ay, by) - pad, max1y = Math.max(ay, by) + pad
  const min2x = Math.min(cx, dx) - pad, max2x = Math.max(cx, dx) + pad
  const min2y = Math.min(cy, dy) - pad, max2y = Math.max(cy, dy) + pad
  return !(max1x < min2x || max2x < min1x || max1y < min2y || max2y < min1y)
}

export default forwardRef<DrawCanvasHandle, {
  width: number
  height: number
  color: string
  size: number
  mode: 'scroll' | 'draw'
  tool: Tool
}> (function DrawCanvas({
  width, height, color, size, mode, tool
}, ref){

  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const ctxRef       = useRef<CanvasRenderingContext2D | null>(null)

  const drawing      = useRef(false)
  const usingPen     = useRef(false)        // Apple Pencil
  const activeId     = useRef<number | null>(null)

  const pendingId    = useRef<number | null>(null)
  const pendingPos   = useRef<Point | null>(null)
  const pendingTO    = useRef<number | null>(null)
  const PENDING_MS   = 60
  const MOVE_THRESH  = 8

  // Stroke model (for redraw & undo)
  const strokesRef   = useRef<Stroke[]>([])
  const liveStroke   = useRef<Stroke | null>(null)

  // Sweep eraser path (object eraser)
  const sweeping     = useRef(false)
  const sweepLast    = useRef<Point | null>(null)
  const SWEEP_STEP   = 2 // px sampling to avoid missing thin lines

  // History stack (supports undo for add + object-erase)
  const historyRef   = useRef<HistoryItem[]>([])
  const HISTORY_LIMIT = 500

  const pushHistory = (item: HistoryItem)=>{
    const arr = historyRef.current
    arr.push(item)
    if (arr.length > HISTORY_LIMIT) arr.shift()
  }

  const resizeBackingStore = ()=>{
    const c = canvasRef.current!
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const needW = Math.floor(width  * dpr)
    const needH = Math.floor(height * dpr)
    if (c.width !== needW)  c.width  = needW
    if (c.height !== needH) c.height = needH
    c.style.width  = `${width}px`
    c.style.height = `${height}px`
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctxRef.current = ctx
  }

  const clearCanvas = ()=>{
    const c = canvasRef.current!, k = ctxRef.current!
    k.save()
    k.setTransform(1,0,0,1,0,0) // clear in device pixels
    k.clearRect(0,0,c.width,c.height)
    // restore CSS pixel transform
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    k.setTransform(dpr,0,0,dpr,0,0)
    k.restore()
  }

  const applyStrokeStyle = (s: Stroke)=>{
    const k = ctxRef.current!
    k.lineCap = 'round'
    k.lineJoin = 'round'
    if (s.tool === 'eraser') {
      k.globalCompositeOperation = 'destination-out'
      k.globalAlpha = 1
      k.strokeStyle = '#000'
      k.lineWidth   = s.size * 2
    } else if (s.tool === 'highlighter') {
      k.globalCompositeOperation = 'source-over'
      k.globalAlpha = 0.35
      k.strokeStyle = s.color
      k.lineWidth   = s.size * 2
    } else { // pen
      k.globalCompositeOperation = 'source-over'
      k.globalAlpha = 1
      k.strokeStyle = s.color
      k.lineWidth   = s.size
    }
  }

  const drawStroke = (s: Stroke)=>{
    const k = ctxRef.current!
    if (!s.points.length) return
    applyStrokeStyle(s)
    k.beginPath()
    k.moveTo(s.points[0].x, s.points[0].y)
    for (let i=1;i<s.points.length;i++){
      const p = s.points[i]
      k.lineTo(p.x, p.y)
    }
    if (s.points.length === 1) {
      const p = s.points[0]
      k.lineTo(p.x + 0.001, p.y + 0.001)
    }
    k.stroke()
  }

  const redrawAll = ()=>{
    clearCanvas()
    for (const s of strokesRef.current) drawStroke(s)
  }

  useImperativeHandle(ref, ()=>({
    undo(){
      // If a live stroke is mid-flight, cancel it
      if (liveStroke.current) {
        liveStroke.current = null
        redrawAll()
        return
      }
      const h = historyRef.current
      if (!h.length) return
      const last = h.pop()!
      if (last.type === 'add') {
        // remove the most recently added stroke
        if (strokesRef.current.length > 0) {
          strokesRef.current.pop()
          redrawAll()
        }
      } else if (last.type === 'remove') {
        // re-insert previously deleted stroke at its original index
        const idx = Math.max(0, Math.min(last.index, strokesRef.current.length))
        strokesRef.current.splice(idx, 0, last.stroke)
        redrawAll()
      }
    }
  }), [])

  const applyPolicy = ()=>{
    const c = canvasRef.current!
    if (!c) return
    if (mode === 'scroll') {
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
      return
    }
    // Draw mode: single finger should never scroll; two-finger pan handled by parent panel.
    c.style.pointerEvents = 'auto'
    c.style.touchAction   = 'none'
  }

  useEffect(()=>{
    if (!drawing.current) {
      resizeBackingStore()
      applyPolicy()
      redrawAll()
    }
  }, [width, height, mode])

  useEffect(()=>{
    const c = canvasRef.current!
    resizeBackingStore()
    applyPolicy()

    const rect = () => c.getBoundingClientRect()
    const toLocal = (clientX:number, clientY:number)=>{
      const r = rect()
      return { x: clientX - r.left, y: clientY - r.top }
    }

    const clearPending = ()=>{
      if (pendingTO.current) { window.clearTimeout(pendingTO.current) }
      pendingTO.current = null
      pendingId.current = null
      pendingPos.current = null
    }
    const commitPending = ()=>{
      if (pendingId.current === null || !pendingPos.current) return
      drawing.current  = true
      activeId.current = pendingId.current
      liveStroke.current = {
        tool: (tool === 'eraser' ? 'eraser' : tool === 'highlighter' ? 'highlighter' : 'pen'),
        color, size, points: [pendingPos.current]
      }
      drawStroke(liveStroke.current)
      clearPending()
    }

    // --- OBJECT ERASER SWEEP HELPERS ---
    const hitStrokeBySweepSeg = (ax:number, ay:number, bx:number, by:number): number | null=>{
      const arr = strokesRef.current
      // Hit top-most first
      for (let i = arr.length - 1; i >= 0; i--) {
        const s = arr[i]
        if (s.tool === 'eraser') continue // ignore pixel eraser strokes
        const pts = s.points
        const thresh = Math.max(12, s.tool==='highlighter' ? s.size*2 : s.size*1.2)
        for (let j=0;j<pts.length-1;j++){
          const a = pts[j], b = pts[j+1]
          if (!segsBBoxOverlap(ax,ay,bx,by, a.x,a.y,b.x,b.y, thresh)) continue
          const d = distPointToSeg(ax,ay, a.x,a.y, b.x,b.y)
          if (d <= thresh) return i
        }
        if (pts.length === 1) {
          const d1 = distPointToSeg(pts[0].x, pts[0].y, ax, ay, bx, by)
          if (d1 <= thresh) return i
        }
      }
      return null
    }

    const sweepEraseBetween = (p0:Point, p1:Point)=>{
      const dx = p1.x - p0.x, dy = p1.y - p0.y
      const len = Math.hypot(dx, dy)
      const steps = Math.max(1, Math.floor(len / SWEEP_STEP))
      let prev = p0
      for (let i=1; i<=steps; i++){
        const t = i/steps
        const cur = { x: p0.x + dx*t, y: p0.y + dy*t }
        const idx = hitStrokeBySweepSeg(prev.x, prev.y, cur.x, cur.y)
        if (idx !== null) {
          const [removed] = strokesRef.current.splice(idx, 1)
          // record deletion for undo
          pushHistory({ type:'remove', index: idx, stroke: removed })
          redrawAll()
        }
        prev = cur
      }
    }

    const onPointerDown = (e: PointerEvent)=>{
      if (mode !== 'draw') return

      usingPen.current = (e.pointerType === 'pen')
      const p = toLocal(e.clientX, e.clientY)

      if (tool === 'eraserObject') {
        sweeping.current = true
        sweepLast.current = p
        // hit-test initial point
        const idx = (function hitAtPoint(pt:Point){
          return hitStrokeBySweepSeg(pt.x, pt.y, pt.x+0.001, pt.y+0.001)
        })(p)
        if (idx !== null) {
          const [removed] = strokesRef.current.splice(idx, 1)
          pushHistory({ type:'remove', index: idx, stroke: removed })
          redrawAll()
        }
        e.preventDefault()
        return
      }

      if (usingPen.current || e.pointerType === 'mouse') {
        drawing.current  = true
        activeId.current = e.pointerId
        liveStroke.current = {
          tool: (tool === 'eraser' ? 'eraser' : tool === 'highlighter' ? 'highlighter' : 'pen'),
          color, size, points: [p]
        }
        drawStroke(liveStroke.current)
        c.setPointerCapture?.(e.pointerId)
        e.preventDefault()
        return
      }

      // touch: small delay to avoid accidental dot when intent is 2-finger pan
      pendingId.current  = e.pointerId
      pendingPos.current = p
      if (pendingTO.current) window.clearTimeout(pendingTO.current)
      pendingTO.current = window.setTimeout(()=>{
        if (pendingId.current === e.pointerId) {
          commitPending()
          c.setPointerCapture?.(e.pointerId)
        }
      }, PENDING_MS)
    }

    const onPointerMove = (e: PointerEvent)=>{
      const pt = toLocal(e.clientX, e.clientY)

      // Sweep eraser path
      if (tool === 'eraserObject' && sweeping.current && sweepLast.current) {
        sweepEraseBetween(sweepLast.current, pt)
        sweepLast.current = pt
        e.preventDefault()
        return
      }

      // start on move if pending and moved enough
      if (pendingId.current !== null && e.pointerId === pendingId.current && pendingPos.current) {
        const r = rect()
        const dx = e.clientX - (r.left + pendingPos.current.x)
        const dy = e.clientY - (r.top  + pendingPos.current.y)
        if (Math.hypot(dx, dy) >= MOVE_THRESH) {
          commitPending()
          c.setPointerCapture?.(e.pointerId)
        }
      }

      if (!drawing.current || activeId.current !== e.pointerId || !liveStroke.current) return
      liveStroke.current.points.push(pt)
      // draw only the new segment
      const k = ctxRef.current!
      const s = liveStroke.current
      const n = s.points.length
      if (n >= 2) {
        applyStrokeStyle(s)
        k.beginPath()
        const a = s.points[n-2], b = s.points[n-1]
        k.moveTo(a.x, a.y); k.lineTo(b.x, b.y); k.stroke()
      }
      e.preventDefault()
    }

    const endStroke = (e: PointerEvent)=>{
      // End sweep eraser
      if (tool === 'eraserObject' && sweeping.current) {
        sweeping.current = false
        sweepLast.current = null
      }

      // cancel pending (no draw)
      if (pendingId.current !== null && e.pointerId === pendingId.current) {
        clearPending()
      }
      if (drawing.current && activeId.current === e.pointerId) {
        drawing.current = false
        activeId.current = null
        if (liveStroke.current) {
          // push stroke and record history
          strokesRef.current.push(liveStroke.current)
          pushHistory({ type:'add', index: strokesRef.current.length - 1 })
          liveStroke.current = null
        }
        c.releasePointerCapture?.(e.pointerId)
        applyPolicy()
      }
    }

    const onPointerUp           = (e: PointerEvent)=> endStroke(e)
    const onPointerCancel       = (e: PointerEvent)=> endStroke(e)
    const onLostPointerCapture  = (e: PointerEvent)=> endStroke(e)

    c.addEventListener('pointerdown',        onPointerDown,        { passive: false })
    c.addEventListener('pointermove',        onPointerMove,        { passive: false })
    c.addEventListener('pointerup',          onPointerUp,          { passive: false })
    c.addEventListener('pointercancel',      onPointerCancel,      { passive: false })
    c.addEventListener('lostpointercapture', onLostPointerCapture, { passive: false })

    const onResize = ()=>{ if (!drawing.current) { resizeBackingStore(); redrawAll() } }
    window.addEventListener('resize', onResize)

    return ()=>{
      c.removeEventListener('pointerdown',        onPointerDown as any)
      c.removeEventListener('pointermove',        onPointerMove as any)
      c.removeEventListener('pointerup',          onPointerUp as any)
      c.removeEventListener('pointercancel',      onPointerCancel as any)
      c.removeEventListener('lostpointercapture', onLostPointerCapture as any)
      window.removeEventListener('resize',        onResize)
      if (pendingTO.current) window.clearTimeout(pendingTO.current)
    }
  }, [mode, color, size, tool])

  return (
    <canvas
      ref={canvasRef}
      width={1}
      height={1}
      style={{
        position:'absolute', inset:0, zIndex:10,
        display:'block', width: `${width}px`, height: `${height}px`,
        WebkitUserSelect: 'none',
        userSelect: 'none',
        WebkitTouchCallout: 'none'
      }}
      onContextMenu={(e)=> e.preventDefault()}
    />
  )
})
