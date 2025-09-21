import { useEffect, useRef } from 'react'

/**
 * iPad-friendly drawing:
 * - Single finger draws (w/ small delay to avoid accidental dot when intending 2-finger scroll)
 * - Two fingers: detected via touchstart on the canvas → canvas releases immediately so the panel scrolls/pinches
 * - Apple Pencil: draws instantly (no delay), ignores 2-finger state
 * - Pixel-accurate (devicePixelRatio)
 * - No resize during a stroke
 */
export default function DrawCanvas({
  width,   // CSS width (from PDF)
  height,  // CSS height (from PDF)
  color,
  size,
  mode // 'scroll' | 'draw'
}:{
  width: number
  height: number
  color: string
  size: number
  mode: 'scroll' | 'draw'
}){
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const ctxRef       = useRef<CanvasRenderingContext2D | null>(null)

  const drawing      = useRef(false)
  const usingPen     = useRef(false)
  const activeId     = useRef<number | null>(null)

  const touchCount   = useRef(0)       // active touch pointers
  const gesturing    = useRef(false)   // true when 2+ touches *as seen by touchstart/touchend*

  // Pending single-finger start (to allow 2nd finger to land)
  const pendingId    = useRef<number | null>(null)
  const pendingPos   = useRef<{x:number,y:number} | null>(null)
  const pendingTO    = useRef<number | null>(null)
  const PENDING_MS   = 60
  const MOVE_THRESH  = 8

  // ----- sizing -----
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

  // ----- interaction policy (must be set BEFORE touches begin) -----
  const applyPolicy = ()=>{
    const c = canvasRef.current!
    if (!c) return
    if (mode === 'scroll') {
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
      return
    }
    // Draw mode: keep single-finger from scrolling; release only for real 2-finger
    if (gesturing.current && !usingPen.current) {
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
    } else {
      c.style.pointerEvents = 'auto'
      c.style.touchAction   = 'none'
    }
  }

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

    // ---- stroke helpers ----
    const begin = (x:number, y:number)=>{
      const k = ctx()
      k.strokeStyle = color
      k.lineWidth   = size
      k.lineCap     = 'round'
      k.lineJoin    = 'round'
      k.beginPath()
      k.moveTo(x, y)
      k.lineTo(x + 0.001, y + 0.001) // dot for taps
      k.stroke()
    }
    const lineTo = (x:number, y:number)=>{
      const k = ctx()
      k.lineTo(x, y)
      k.stroke()
    }

    // ---- FAST 2-finger detection (touchstart/touchend on the canvas) ----
    // This fires earlier than pointer events on iPad Safari.
    const onTouchStartFast = (e: TouchEvent)=>{
      if (mode !== 'draw') return
      if (e.touches.length >= 2) {
        gesturing.current = true
        // Kill any pending single-finger start immediately
        if (pendingTO.current) { window.clearTimeout(pendingTO.current) }
        pendingTO.current = null
        pendingId.current = null
        pendingPos.current = null
        applyPolicy() // canvas -> pointer-events:none so the panel can scroll/pinch
      }
    }
    const onTouchEndFast = (_e: TouchEvent)=>{
      if (mode !== 'draw') return
      // When touches drop below 2, clear gesture flag shortly (gives Safari time)
      // Tiny timeout avoids flicker while fingers leave
      setTimeout(()=>{
        gesturing.current = false
        applyPolicy()
      }, 20)
    }

    c.addEventListener('touchstart', onTouchStartFast, { passive: true })
    c.addEventListener('touchend',   onTouchEndFast,   { passive: true })
    c.addEventListener('touchcancel',onTouchEndFast,   { passive: true })

    // ---- Pointer Events (pen/touch/mouse) ----
    const onPointerDown = (e: PointerEvent)=>{
      // Maintain a rough touch count (pointer-based)
      if (e.pointerType === 'touch') {
        touchCount.current += 1
      }

      if (mode !== 'draw') return

      usingPen.current = (e.pointerType === 'pen')

      // If a real 2-finger gesture is active and not Pencil → do not start drawing
      if (gesturing.current && !usingPen.current) return

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

      // TOUCH (single finger): delay to see if a second finger lands
      pendingId.current  = e.pointerId
      pendingPos.current = p
      if (pendingTO.current) window.clearTimeout(pendingTO.current)
      pendingTO.current = window.setTimeout(()=>{
        if (!gesturing.current && pendingId.current === e.pointerId) {
          drawing.current  = true
          activeId.current = e.pointerId
          begin(pendingPos.current!.x, pendingPos.current!.y)
          c.setPointerCapture?.(e.pointerId)
        }
        pendingId.current = null
        pendingPos.current = null
        pendingTO.current = null
      }, PENDING_MS)
    }

    const onPointerMove = (e: PointerEvent)=>{
      // If this pointer is the pending single-finger start, start when moved enough
      if (pendingId.current !== null && e.pointerId === pendingId.current && pendingPos.current) {
        const r = rect()
        const dx = e.clientX - (r.left + pendingPos.current.x)
        const dy = e.clientY - (r.top  + pendingPos.current.y)
        if (Math.hypot(dx, dy) >= MOVE_THRESH && !gesturing.current) {
          drawing.current  = true
          activeId.current = e.pointerId
          begin(pendingPos.current.x, pendingPos.current.y)
          c.setPointerCapture?.(e.pointerId)
          pendingId.current = null
          pendingPos.current = null
          if (pendingTO.current) { window.clearTimeout(pendingTO.current); pendingTO.current = null }
        }
      }

      if (!drawing.current) return
      if (activeId.current !== null && e.pointerId !== activeId.current) return

      // If gesture begins mid-stroke (second finger lands) and not Pencil, abort
      if (gesturing.current && !usingPen.current) {
        drawing.current = false
        activeId.current = null
        c.releasePointerCapture?.(e.pointerId)
        applyPolicy()
        return
      }

      const p = toLocal(e.clientX, e.clientY)
      lineTo(p.x, p.y)
      e.preventDefault()
    }

    const endStroke = (e: PointerEvent)=>{
      // Update touch count
      if (e.pointerType === 'touch') {
        touchCount.current = Math.max(0, touchCount.current - 1)
      }

      // Cancel pending start if this pointer was pending
      if (pendingId.current !== null && e.pointerId === pendingId.current) {
        if (pendingTO.current) { window.clearTimeout(pendingTO.current) }
        pendingId.current = null
        pendingPos.current = null
        pendingTO.current = null
      }

      if (drawing.current && activeId.current !== null && e.pointerId === activeId.current) {
        drawing.current = false
        usingPen.current = false
        activeId.current = null
        c.releasePointerCapture?.(e.pointerId)
        applyPolicy()
      } else {
        // Even if not drawing, ensure policy reflects current gesture state
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

    // Keep crisp on DPR change (rotate/zoom) — avoid during stroke
    const onResize = ()=>{ if (!drawing.current) { resizeBackingStore() } }
    window.addEventListener('resize', onResize)

    return ()=>{
      c.removeEventListener('touchstart', onTouchStartFast as any)
      c.removeEventListener('touchend',   onTouchEndFast as any)
      c.removeEventListener('touchcancel',onTouchEndFast as any)

      c.removeEventListener('pointerdown',        onPointerDown as any)
      c.removeEventListener('pointermove',        onPointerMove as any)
      c.removeEventListener('pointerup',          onPointerUp as any)
      c.removeEventListener('pointercancel',      onPointerCancel as any)
      c.removeEventListener('lostpointercapture', onLostPointerCapture as any)

      window.removeEventListener('resize', onResize)

      if (pendingTO.current) { window.clearTimeout(pendingTO.current) }
    }
  }, [mode, color, size])

  return (
    <canvas
      ref={canvasRef}
      width={1}
      height={1}
      style={{
        position:'absolute', inset:0, zIndex:10,
        display:'block', width: `${width}px`, height: `${height}px`,
        // Stop selection/callout on the canvas itself (extra belt for palm)
        WebkitUserSelect: 'none',
        userSelect: 'none',
        WebkitTouchCallout: 'none'
      }}
      onContextMenu={(e)=> e.preventDefault()}
    />
  )
}
