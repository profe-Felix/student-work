import { useEffect, useRef } from 'react'

type Tool = 'pen' | 'highlighter' | 'eraser'

/**
 * Pencil-friendly drawing with 2-finger pan:
 * - Pen, Highlighter (alpha), Eraser (destination-out)
 * - Apple Pencil: draws immediately
 * - Touch: one-finger draw (with tiny delay to avoid accidental dot when intent is 2-finger scroll)
 * - Two-finger pan handled by parent panel (manual), canvas releases when needed
 * - Pixel-accurate (devicePixelRatio)
 */
export default function DrawCanvas({
  width,   // CSS width (from PDF canvas CSS size)
  height,  // CSS height (from PDF canvas CSS size)
  color,
  size,
  mode,            // 'scroll' | 'draw'
  tool = 'pen'     // 'pen' | 'highlighter' | 'eraser'
}:{
  width: number
  height: number
  color: string
  size: number
  mode: 'scroll' | 'draw'
  tool?: Tool
}){
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const ctxRef       = useRef<CanvasRenderingContext2D | null>(null)

  const drawing      = useRef(false)
  const usingPen     = useRef(false)          // Apple Pencil
  const activeId     = useRef<number | null>(null)

  // Pending single-finger start (to allow second finger to land for 2-finger pan)
  const pendingId    = useRef<number | null>(null)
  const pendingPos   = useRef<{x:number,y:number} | null>(null)
  const pendingTO    = useRef<number | null>(null)
  const PENDING_MS   = 60
  const MOVE_THRESH  = 8

  // --- size/backing store ---
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // draw in CSS pixels
    ctxRef.current = ctx
  }

  // --- interaction policy (set BEFORE touches begin) ---
  const applyPolicy = ()=>{
    const c = canvasRef.current!
    if (!c) return
    if (mode === 'scroll') {
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
      return
    }
    // Draw mode: single-finger should never scroll; toolbar/panel handles 2-finger pan
    c.style.pointerEvents = 'auto'
    c.style.touchAction   = 'none'
  }

  // Apply sizing/policy on prop changes (never mid-stroke)
  useEffect(()=>{
    if (!drawing.current) {
      resizeBackingStore()
      applyPolicy()
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
    const ctx = () => ctxRef.current!

    // ---- stroke style per tool ----
    const applyToolStyle = ()=>{
      const k = ctx()
      k.lineCap = 'round'
      k.lineJoin = 'round'

      if (tool === 'eraser') {
        k.globalCompositeOperation = 'destination-out'
        k.globalAlpha = 1
        k.strokeStyle = '#000'
        k.lineWidth   = size * 2 // eraser a bit larger feels nicer
      } else if (tool === 'highlighter') {
        k.globalCompositeOperation = 'source-over'
        k.globalAlpha = 0.35
        k.strokeStyle = color
        k.lineWidth   = size * 2 // highlighter is broader
      } else {
        // pen
        k.globalCompositeOperation = 'source-over'
        k.globalAlpha = 1
        k.strokeStyle = color
        k.lineWidth   = size
      }
    }

    // ---- stroke helpers ----
    const begin = (x:number, y:number)=>{
      applyToolStyle()
      const k = ctx()
      k.beginPath()
      k.moveTo(x, y)
      // tiny segment so taps leave a dot
      k.lineTo(x + 0.001, y + 0.001)
      k.stroke()
    }
    const lineTo = (x:number, y:number)=>{
      const k = ctx()
      k.lineTo(x, y)
      k.stroke()
    }

    // Pending helpers
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
      begin(pendingPos.current.x, pendingPos.current.y)
      clearPending()
    }

    // Pointer handlers (pen/touch/mouse)
    const onPointerDown = (e: PointerEvent)=>{
      if (mode !== 'draw') return

      usingPen.current = (e.pointerType === 'pen')
      const p = toLocal(e.clientX, e.clientY)

      if (usingPen.current || e.pointerType === 'mouse') {
        // Pencil/mouse: start immediately
        drawing.current  = true
        activeId.current = e.pointerId
        begin(p.x, p.y)
        c.setPointerCapture?.(e.pointerId)
        e.preventDefault()
        return
      }

      // TOUCH (single finger): delay to see if a second finger lands (panel handles 2-finger)
      pendingId.current  = e.pointerId
      pendingPos.current = p
      if (pendingTO.current) window.clearTimeout(pendingTO.current)
      pendingTO.current = window.setTimeout(()=>{
        // If still pending, commit to draw
        if (pendingId.current === e.pointerId) {
          commitPending()
          c.setPointerCapture?.(e.pointerId)
        }
      }, PENDING_MS)
    }

    const onPointerMove = (e: PointerEvent)=>{
      // If this pointer is the pending single-finger start, start when moved enough
      if (pendingId.current !== null && e.pointerId === pendingId.current && pendingPos.current) {
        const r = rect()
        const dx = e.clientX - (r.left + pendingPos.current.x)
        const dy = e.clientY - (r.top  + pendingPos.current.y)
        if (Math.hypot(dx, dy) >= MOVE_THRESH) {
          commitPending()
          c.setPointerCapture?.(e.pointerId)
        }
      }

      if (!drawing.current) return
      if (activeId.current !== null && e.pointerId !== activeId.current) return

      const p = toLocal(e.clientX, e.clientY)
      lineTo(p.x, p.y)
      e.preventDefault()
    }

    const endStroke = (e: PointerEvent)=>{
      // Cancel pending start if this was the pending pointer
      if (pendingId.current !== null && e.pointerId === pendingId.current) {
        clearPending()
      }

      if (drawing.current && activeId.current !== null && e.pointerId === activeId.current) {
        drawing.current = false
        usingPen.current = false
        activeId.current = null
        c.releasePointerCapture?.(e.pointerId)
        applyPolicy()
      } else {
        // Even if not drawing, ensure policy is correct
        applyPolicy()
      }
    }

    const onPointerUp           = (e: PointerEvent)=> endStroke(e)
    const onPointerCancel       = (e: PointerEvent)=> endStroke(e)
    const onLostPointerCapture  = (e: PointerEvent)=> endStroke(e)

    // Non-passive so preventDefault works while drawing
    c.addEventListener('pointerdown',        onPointerDown,        { passive: false })
    c.addEventListener('pointermove',        onPointerMove,        { passive: false })
    c.addEventListener('pointerup',          onPointerUp,          { passive: false })
    c.addEventListener('pointercancel',      onPointerCancel,      { passive: false })
    c.addEventListener('lostpointercapture', onLostPointerCapture, { passive: false })

    // DPR change (rotate/zoom) — avoid during active stroke
    const onResize = ()=>{ if (!drawing.current) { resizeBackingStore() } }
    window.addEventListener('resize', onResize)

    return ()=>{
      c.removeEventListener('pointerdown',        onPointerDown as any)
      c.removeEventListener('pointermove',        onPointerMove as any)
      c.removeEventListener('pointerup',          onPointerUp as any)
      c.removeEventListener('pointercancel',      onPointerCancel as any)
      c.removeEventListener('lostpointercapture', onLostPointerCapture as any)
      window.removeEventListener('resize',        onResize)
      clearPending()
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
}
