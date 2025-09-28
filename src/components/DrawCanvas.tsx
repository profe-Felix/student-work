//src/components/DrawCanvas.tsx
import React, {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
} from 'react'

type Tool = 'pen' | 'highlighter'
type Pt = { x: number; y: number; t: number } // <-- t is milliseconds since drawStartMs

type Stroke = {
  color: string
  size: number
  tool: Tool
  pts: Pt[]
}

type InkPayload = {
  meta: {
    canvasW: number
    canvasH: number
    drawStartMs: number
    audioStartMs?: number
    audioOffsetMs?: number
  }
  strokes: Stroke[]
}

export type DrawCanvasRef = {
  /** Call right when audio starts recording */
  markAudioStarted: () => void
  /** Returns the full payload to save (strokes_json) */
  exportPayload: () => InkPayload
  /** Clear the canvas + strokes */
  clear: () => void
}

type Props = {
  width: number
  height: number
  penColor?: string
  penSize?: number
  tool?: Tool
  /** optional background image (e.g., a rendered PDF page) */
  backgroundUrl?: string
  /** Called whenever strokes change (e.g., to enable Save button) */
  onDirtyChange?: (dirty: boolean) => void
}

const DrawCanvas = forwardRef<DrawCanvasRef, Props>(function DrawCanvas(
  {
    width,
    height,
    penColor = '#111111',
    penSize = 4,
    tool = 'pen',
    backgroundUrl,
    onDirtyChange,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const bgRef = useRef<HTMLImageElement | null>(null)

  // timing anchors
  const drawStartMsRef = useRef<number>(0)
  const audioStartMsRef = useRef<number | undefined>(undefined)

  // strokes state
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const currentStrokeRef = useRef<Stroke | null>(null)
  const drawingRef = useRef(false)

  // device pixel ratio scaling for crisp lines
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const cssW = width
  const cssH = height
  const bufW = Math.round(cssW * dpr)
  const bufH = Math.round(cssH * dpr)

  // initialize drawStart on first pointer down
  const ensureDrawStart = () => {
    if (drawStartMsRef.current <= 0) {
      drawStartMsRef.current = performance.now()
    }
  }

  // convert event to canvas space (CSS pixels)
  const getCanvasPoint = (e: PointerEvent | MouseEvent | TouchEvent) => {
    const c = canvasRef.current!
    const rect = c.getBoundingClientRect()
    // PointerEvent path: pageX/pageY
    // Normalize to CSS pixels relative to canvas
    let clientX = 0
    let clientY = 0

    if ('clientX' in e && typeof (e as any).clientX === 'number') {
      clientX = (e as any).clientX
      clientY = (e as any).clientY
    } else if ('touches' in e && (e as TouchEvent).touches.length > 0) {
      clientX = (e as TouchEvent).touches[0].clientX
      clientY = (e as TouchEvent).touches[0].clientY
    }

    const xCss = Math.max(0, Math.min(cssW, clientX - rect.left))
    const yCss = Math.max(0, Math.min(cssH, clientY - rect.top))

    // Store points in **capture space = CSS pixels**.
    // On playback we’ll scale from meta.canvasW/H to whatever preview size.
    const t = performance.now() - drawStartMsRef.current
    return { x: xCss, y: yCss, t }
  }

  // start a stroke
  const beginStroke = (p: Pt) => {
    const s: Stroke = {
      color: penColor,
      size: tool === 'highlighter' ? Math.max(6, penSize) : penSize,
      tool,
      pts: [p],
    }
    currentStrokeRef.current = s
    setStrokes(prev => {
      const next = prev.concat(s)
      onDirtyChange?.(next.length > 0)
      return next
    })
    drawingRef.current = true
  }

  // add point
  const addPoint = (p: Pt) => {
    const s = currentStrokeRef.current
    if (!s) return
    s.pts.push(p)
    drawLive() // incremental draw for responsiveness
  }

  // end stroke
  const endStroke = () => {
    drawingRef.current = false
    currentStrokeRef.current = null
    drawAll()
  }

  // drawing routines
  const ensureCtx = (): CanvasRenderingContext2D | null => {
    const c = canvasRef.current
    if (!c) return null
    if (c.width !== bufW) c.width = bufW
    if (c.height !== bufH) c.height = bufH
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.setTransform(1, 0, 0, 1, 0, 0) // reset
    ctx.scale(dpr, dpr) // map drawing units → CSS pixels
    return ctx
  }

  const drawBackground = (ctx: CanvasRenderingContext2D) => {
    const img = bgRef.current
    if (img && img.complete) {
      ctx.drawImage(img, 0, 0, cssW, cssH)
    }
  }

  const drawAll = () => {
    const ctx = ensureCtx()
    if (!ctx) return
    ctx.clearRect(0, 0, cssW, cssH)
    drawBackground(ctx)

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const s of strokes) {
      if (s.pts.length === 0) continue
      ctx.globalAlpha = s.tool === 'highlighter' ? 0.35 : 1
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.size
      const pts = s.pts
      if (pts.length === 1) {
        const p = pts[0]
        ctx.beginPath()
        ctx.arc(p.x, p.y, (s.size) * 0.5, 0, Math.PI * 2)
        ctx.fillStyle = s.color
        ctx.fill()
      } else {
        ctx.beginPath()
        ctx.moveTo(pts[0].x, pts[0].y)
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
  }

  const drawLive = () => {
    // Draw everything; for perf you could only draw last segment,
    // but full redraw is simpler and reliable.
    drawAll()
  }

  // pointer event handlers
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return

    const onPointerDown = (e: PointerEvent) => {
      c.setPointerCapture(e.pointerId)
      ensureDrawStart()
      const p = getCanvasPoint(e)
      beginStroke(p)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!drawingRef.current) return
      const p = getCanvasPoint(e)
      addPoint(p)
    }
    const onPointerUp = (_e: PointerEvent) => endStroke()
    const onPointerCancel = (_e: PointerEvent) => endStroke()

    c.addEventListener('pointerdown', onPointerDown)
    c.addEventListener('pointermove', onPointerMove)
    c.addEventListener('pointerup', onPointerUp)
    c.addEventListener('pointercancel', onPointerCancel)

    return () => {
      c.removeEventListener('pointerdown', onPointerDown)
      c.removeEventListener('pointermove', onPointerMove)
      c.removeEventListener('pointerup', onPointerUp)
      c.removeEventListener('pointercancel', onPointerCancel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [penColor, penSize, tool, cssW, cssH])

  // redraw on bg load / dimension change
  useEffect(() => {
    drawAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backgroundUrl, cssW, cssH, dpr])

  useImperativeHandle(ref, (): DrawCanvasRef => ({
    markAudioStarted: () => {
      audioStartMsRef.current = performance.now()
    },
    exportPayload: (): InkPayload => {
      const meta = {
        canvasW: cssW,
        canvasH: cssH,
        drawStartMs: drawStartMsRef.current || performance.now(), // fallback
        audioStartMs: audioStartMsRef.current,
        audioOffsetMs:
          audioStartMsRef.current != null && drawStartMsRef.current > 0
            ? audioStartMsRef.current - drawStartMsRef.current
            : undefined,
      }
      // Return a deep clone that is plain JSON (avoid React state refs)
      const cloned: Stroke[] = strokes.map(s => ({
        color: s.color,
        size: s.size,
        tool: s.tool,
        pts: s.pts.map(p => ({ x: p.x, y: p.y, t: p.t })),
      }))
      return { meta, strokes: cloned }
    },
    clear: () => {
      setStrokes([])
      currentStrokeRef.current = null
      drawingRef.current = false
      drawStartMsRef.current = 0
      audioStartMsRef.current = undefined
      onDirtyChange?.(false)
      drawAll()
    },
  }))

  return (
    <div
      style={{
        position: 'relative',
        width: `${cssW}px`,
        height: `${cssH}px`,
        touchAction: 'none', // better Apple Pencil behavior
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {backgroundUrl ? (
        <img
          ref={bgRef}
          src={backgroundUrl}
          alt=""
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'fill',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
          onLoad={() => drawAll()}
        />
      ) : null}
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: `${cssW}px`,
          height: `${cssH}px`,
          cursor: tool === 'highlighter' ? 'crosshair' : 'crosshair',
        }}
        width={bufW}
        height={bufH}
      />
    </div>
  )
})

export default DrawCanvas
