import { useEffect, useRef } from 'react'

export default function DrawCanvas({
  width,
  height,
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
  const drawing     = useRef(false)
  const gesturing   = useRef(false) // true while 2+ fingers are down

  // Apply base interaction policy
  const applyPolicy = ()=>{
    const c = canvasRef.current!
    if (mode === 'scroll') {
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
    } else {
      // draw mode defaults; may be overridden during a gesture
      c.style.pointerEvents = gesturing.current ? 'none' : 'auto'
      c.style.touchAction   = gesturing.current ? 'auto' : 'pan-y pinch-zoom'
    }
  }

  useEffect(applyPolicy, [mode])

  useEffect(()=>{
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!

    const getPos = (e: any)=>{
      const r = canvas.getBoundingClientRect()
      if ('touches' in e && e.touches && e.touches.length) {
        return { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top }
      }
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    // ---- gesture helpers ----
    const enterGesture = ()=>{
      if (!gesturing.current) {
        gesturing.current = true
        applyPolicy() // temporarily let Safari handle scroll/zoom
      }
    }
    const exitGesture = ()=>{
      if (gesturing.current) {
        gesturing.current = false
        applyPolicy() // restore drawing capture
      }
    }

    // ---- handlers ----
    const onTouchStart = (e: TouchEvent)=>{
      if (mode !== 'draw') return
      // Two+ fingers: let page handle (scroll/zoom)
      if (e.touches.length > 1) { enterGesture(); return }
      // One finger: draw
      drawing.current = true
      const p = getPos(e)
      ctx.strokeStyle = color
      ctx.lineWidth   = size
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      if (e.cancelable) e.preventDefault()
    }

    const onTouchMove = (e: TouchEvent)=>{
      if (mode !== 'draw') return
      if (e.touches.length > 1) { enterGesture(); return } // let Safari scroll
      if (!drawing.current) return
      const p = getPos(e)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
      if (e.cancelable) e.preventDefault() // keep page from nudging with one finger
    }

    const onTouchEnd = (_e: TouchEvent)=>{
      if (mode !== 'draw') return
      // If any fingers remain (e.g., from 2-finger gesture -> 1 finger), keep gesture mode consistent
      // iOS fires touchend per finger; when none remain, end both drawing and gesture mode
      const anyTouchesLeft = !!document?.touches?.length // not widely supported; fallback below
      drawing.current = false
      if (!anyTouchesLeft) exitGesture()
      else {
        // fallback: small timeout to restore if everything lifted
        setTimeout(()=> exitGesture(), 0)
      }
    }

    const onMouseDown = (e: MouseEvent)=>{
      if (mode !== 'draw' || gesturing.current) return
      drawing.current = true
      const p = getPos(e)
      ctx.strokeStyle = color
      ctx.lineWidth   = size
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
    }
    const onMouseMove = (e: MouseEvent)=>{
      if (!drawing.current) return
      const p = getPos(e)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
    }
    const onMouseUp = ()=>{ drawing.current = false }

    canvas.addEventListener('touchstart', onTouchStart, { passive: false })
    canvas.addEventListener('touchmove',  onTouchMove,  { passive: false })
    canvas.addEventListener('touchend',   onTouchEnd,   { passive: true  })
    canvas.addEventListener('mousedown',  onMouseDown)
    canvas.addEventListener('mousemove',  onMouseMove)
    canvas.addEventListener('mouseup',    onMouseUp)

    return ()=>{
      canvas.removeEventListener('touchstart', onTouchStart as any)
      canvas.removeEventListener('touchmove',  onTouchMove as any)
      canvas.removeEventListener('touchend',   onTouchEnd as any)
      canvas.removeEventListener('mousedown',  onMouseDown as any)
      canvas.removeEventListener('mousemove',  onMouseMove as any)
      canvas.removeEventListener('mouseup',    onMouseUp as any)
    }
  },[color, size, mode])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position:'absolute', inset:0, zIndex:10,
        display:'block', width:'100%', height:'100%'
      }}
    />
  )
}
