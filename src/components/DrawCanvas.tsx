import { useEffect, useRef } from 'react'

/**
 * Canvas drawing with:
 * - Pixel-perfect alignment (devicePixelRatio aware)
 * - Apple Pencil: always draws (pointerType === 'pen')
 * - Touch: 1 finger draws, 2+ fingers scroll/pinch (canvas releases)
 * - Multiple strokes in a row (no “stuck scroll mode”)
 */
export default function DrawCanvas({
  width,   // CSS width (from PDF canvas CSS size)
  height,  // CSS height (from PDF canvas CSS size)
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
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const ctxRef      = useRef<CanvasRenderingContext2D | null>(null)

  const drawing     = useRef(false)
  const usingPen    = useRef(false)
  const gesturing   = useRef(false)          // true while 2+ touches are down
  const activeId    = useRef<number | null>(null)
  const gestureTO   = useRef<number | null>(null) // debounce to clear gesture after touchend

  // --- sizing helpers (CSS px -> device px backing store) ---
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // use CSS pixel coords everywhere
    ctxRef.current = ctx
  }

  // --- interaction policy ---
  const applyPolicy = ()=>{
    const c = canvasRef.current!
    if (!c) return
    if (mode === 'scroll') {
      // Teacher set to Scroll: never capture
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
      return
    }
    // DRAW mode:
    if (gesturing.current && !usingPen.current) {
      // 2+ fingers (no Pencil) → release to scroll/pinch
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
    } else {
      // IMPORTANT: keep touchAction 'none' in draw mode so single-finger never scrolls
      c.style.pointerEvents = 'auto'
      c.style.touchAction   = 'none'
    }
  }

  // Ensure correct size & policy on mount/prop changes (but never mid-stroke)
  useEffect(()=>{
    if (!drawing.current) {
      resizeBackingStore()
      applyPolicy()
    }
  }, [width, height, mode])

  // Global 2-finger detection (fires BEFORE pointer handlers)
  useEffect(()=>{
    const clearGestureSoon = ()=>{
      if (gestureTO.current) window.clearTimeout(gestureTO.current)
      // Debounce a hair to avoid sticky “gesture true” between fingers lifting
      gestureTO.current = window.setTimeout(()=>{
        gesturing.current = false
        applyPolicy()
      }, 40) // 40ms is enough to avoid flicker, but clears before next stroke
    }

    const onTS = (e: TouchEvent)=>{
      if (e.touches.length > 1) {
        if (gestureTO.current) window.clearTimeout(gestureTO.current)
        gesturing.current = true
        applyPolicy()
      }
    }
    const onTE = (e: TouchEvent)=>{
      if (e.touches.length <= 1){
        clearGestureSoon()
      }
    }
    window.addEventListener('touchstart', onTS, { passive: true })
    window.addEventListener('touchend',   onTE, { passive: true })
    window.addEventListener('touchcancel',onTE, { passive: true })
    return ()=>{
      window.removeEventListener('touchstart', onTS as any)
      window.removeEventListener('touchend',   onTE  as any)
      window.removeEventListener('touchcancel',onTE  as any)
      if (gestureTO.current) window.clearTimeout(gestureTO.current)
    }
  }, [])

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

    // --- basic stroke helpers ---
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

    // --- Pointer Events (pen/touch/mouse) ---
    const onPointerDown = (e: PointerEvent)=>{
      if (mode !== 'draw') return

      usingPen.current = (e.pointerType === 'pen')

      // If a multi-touch gesture is stuck from earlier but we now have a single new pointer,
      // force-clear gesture state so a new stroke can begin.
      // (Pencil always draws; for touch/mouse, assume single-pointer at this event.)
      if (!usingPen.current) {
        gesturing.current = false
        applyPolicy()
      }

      // If a genuine 2+ finger gesture is active, still do not start (unless Pencil)
      if (gesturing.current && !usingPen.current) return

      drawing.current = true
      activeId.current = e.pointerId

      const p = toLocal(e.clientX, e.clientY)
      begin(p.x, p.y)

      // Capture so we keep receiving moves even if finger leaves the element
      c.setPointerCapture?.(e.pointerId)

      // touch-action is already 'none' in draw mode; this belt+suspenders avoids page nudge
      e.preventDefault()
    }

    const onPointerMove = (e: PointerEvent)=>{
      if (!drawing.current) return
      if (activeId.current !== null && e.pointerId !== activeId.current) return

      // If a two-finger gesture starts mid-stroke (rare), abort (unless using Pencil)
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
      if (!drawing.current) return
      if (activeId.current !== null && e.pointerId !== activeId.current) return

      drawing.current = false
      usingPen.current = false
      activeId.current = null
      c.releasePointerCapture?.(e.pointerId)
      applyPolicy()
    }

    const onPointerUp           = (e: PointerEvent)=> endStroke(e)
    const onPointerCancel       = (e: PointerEvent)=> endStroke(e)
    const onLostPointerCapture  = (e: PointerEvent)=> endStroke(e)

    // Non-passive so preventDefault works
    c.addEventListener('pointerdown',        onPointerDown,        { passive: false })
    c.addEventListener('pointermove',        onPointerMove,        { passive: false })
    c.addEventListener('pointerup',          onPointerUp,          { passive: false })
    c.addEventListener('pointercancel',      onPointerCancel,      { passive: false })
    c.addEventListener('lostpointercapture', onLostPointerCapture, { passive: false })

    // Keep crisp if DPR changes (rotate/zoom) — avoid during stroke
    const onResize = ()=>{ if (!drawing.current) { resizeBackingStore() } }
    window.addEventListener('resize', onResize)

    return ()=>{
      c.removeEventListener('pointerdown',        onPointerDown as any)
      c.removeEventListener('pointermove',        onPointerMove as any)
      c.removeEventListener('pointerup',          onPointerUp as any)
      c.removeEventListener('pointercancel',      onPointerCancel as any)
      c.removeEventListener('lostpointercapture', onLostPointerCapture as any)
      window.removeEventListener('resize',        onResize)
    }
  }, [mode, color, size])

  return (
    <canvas
      ref={canvasRef}
      // Backing store size is set in effect; keep attrs minimal to avoid resets mid-stroke
      width={1}
      height={1}
      style={{
        position:'absolute', inset:0, zIndex:10,
        display:'block', width: `${width}px`, height: `${height}px`
      }}
    />
  )
}
