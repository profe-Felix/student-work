/* ========================= Types ========================= */
type TimedPoint = { x: number; y: number; t?: number }
type StrokeIn = {
  color?: string
  size?: number
  tool?: 'pen'|'highlighter'|'eraser'|string
  // Accept both shapes:
  points?: TimedPoint[]
  pts?: TimedPoint[]
}
type TLPoint = { x:number; y:number; t:number }
type TLStroke = { color?:string; size?:number; tool?:string; pts: TLPoint[] }
type Timeline = { strokes: TLStroke[]; t0:number; t1:number }

/* ========== Normalize to a single timeline (like the sandbox) ========== */
function buildTimeline(strokes: StrokeIn[]): Timeline {
  if (!Array.isArray(strokes) || strokes.length === 0) return { strokes: [], t0: 0, t1: 0 }

  const tl: TLStroke[] = []
  let anyT = false

  // detect if any point has a timestamp
  for (const s of strokes) {
    const raw = (s.pts || s.points || []) as TimedPoint[]
    for (const p of raw) { if (typeof p?.t === 'number') { anyT = true; break } }
    if (anyT) break
  }

  let gmin = Infinity, gmax = 0

  if (anyT) {
    for (const s of strokes) {
      const raw = (s.pts || s.points || []) as TimedPoint[]
      const pts: TLPoint[] = []
      let last = -Infinity
      for (const p of raw) {
        let t = typeof p.t === 'number' ? p.t : (last > 0 ? last + 10 : 0)
        // keep non-decreasing per stroke
        t = Math.max(t, last > 0 ? last : t)
        last = t
        const x = Math.round(p.x), y = Math.round(p.y)
        pts.push({ x, y, t })
        if (t < gmin) gmin = t
        if (t > gmax) gmax = t
      }
      if (pts.length) tl.push({ color: s.color, size: s.size, tool: s.tool, pts })
    }
    if (!Number.isFinite(gmin)) gmin = 0
    for (const s of tl) for (const p of s.pts) p.t = Math.max(0, p.t - gmin) // rebase to 0
  } else {
    // synthesize times (10ms per segment, 150ms gap)
    const SEG = 10, GAP = 150
    let t = 0
    for (const s of strokes) {
      const raw = (s.pts || s.points || []) as TimedPoint[]
      if (!raw.length) { t += GAP; continue }
      const pts: TLPoint[] = []
      pts.push({ x: Math.round(raw[0].x), y: Math.round(raw[0].y), t })
      for (let i=1;i<raw.length;i++) { t += SEG; pts.push({ x: Math.round(raw[i].x), y: Math.round(raw[i].y), t }) }
      tl.push({ color: s.color, size: s.size, tool: s.tool, pts })
      t += GAP
    }
    gmin = 0
    gmax = Math.max(0, ...tl.map(s => s.pts.length ? s.pts[s.pts.length-1].t : 0))
  }

  // enforce consistent ordering by first point time
  tl.sort((a,b) => (a.pts[0]?.t ?? 0) - (b.pts[0]?.t ?? 0))

  return { strokes: tl, t0: 0, t1: Math.max(0, gmax - (Number.isFinite(gmin)? gmin : 0)) }
}

/* ========== Drawing at a given time (eraser-safe) ========== */
function drawAtTime(ctx: CanvasRenderingContext2D, cssW:number, cssH:number, tl: Timeline, ms: number) {
  ctx.clearRect(0,0,cssW,cssH)
  ctx.globalCompositeOperation = 'source-over' // reset each frame

  for (const s of tl.strokes) {
    const pts = s.pts
    if (!pts || pts.length === 0) continue

    // style by tool
    if (s.tool === 'highlighter') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = s.color || '#111'
      ctx.lineWidth = Math.max(1, (s.size || 4) * 2)
      ctx.globalAlpha = 0.35
    } else if (s.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = '#000'
      ctx.lineWidth = Math.max(1, (s.size || 4) * 2)
      ctx.globalAlpha = 1
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = s.color || '#111'
      ctx.lineWidth = Math.max(1, (s.size || 4))
      ctx.globalAlpha = 1
    }

    // last index with t <= ms
    let i = 0; while (i < pts.length && pts[i].t <= ms) i++
    const lastIdx = i - 1
    if (lastIdx < 0) { ctx.globalCompositeOperation = 'source-over'; continue }

    if (lastIdx >= 1) {
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let k=1; k<=lastIdx; k++) ctx.lineTo(pts[k].x, pts[k].y)
      ctx.stroke()
    } else {
      // draw a “dot”
      const p = pts[0]
      if (s.tool === 'eraser') {
        const prev = ctx.globalCompositeOperation
        ctx.globalCompositeOperation = 'destination-out'
        ctx.beginPath(); ctx.arc(p.x, p.y, (s.size||4)*0.5, 0, Math.PI*2); ctx.fillStyle = '#000'; ctx.fill()
        ctx.globalCompositeOperation = prev
      } else {
        ctx.beginPath(); ctx.arc(p.x, p.y, (s.size||4)*0.5, 0, Math.PI*2); ctx.fillStyle = s.color || '#111'; ctx.fill()
      }
    }

    // smooth head
    if (lastIdx < pts.length - 1 && lastIdx >= 0) {
      const a = pts[lastIdx], b = pts[lastIdx+1]
      const dt = Math.max(1, b.t - a.t)
      const f = Math.min(1, Math.max(0, (ms - a.t) / dt))
      const hx = a.x + (b.x - a.x) * f
      const hy = a.y + (b.y - a.y) * f
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(hx, hy); ctx.stroke()
    }

    // restore for next stroke
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }
}
