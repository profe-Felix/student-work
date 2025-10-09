import { useEffect, useRef } from 'react'

/**
 * Inside–Outside Counters workstation
 * Ported from your raw HTML version into a single React component.
 * - No external deps
 * - Handles resize/orientation changes
 * - Cleans up all listeners and RAFs on unmount
 */
export default function InsideOutsideWS() {
  // refs to key DOM nodes
  const panelRef = useRef<HTMLDivElement | null>(null)
  const simRef = useRef<HTMLCanvasElement | null>(null)
  const drawRef = useRef<HTMLCanvasElement | null>(null)
  const playBtnRef = useRef<HTMLButtonElement | null>(null)
  const refreshBtnRef = useRef<HTMLButtonElement | null>(null)
  const penBtnRef = useRef<HTMLButtonElement | null>(null)
  const eraserBtnRef = useRef<HTMLButtonElement | null>(null)
  const clearBtnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const panel = panelRef.current!
    const sim = simRef.current!
    const draw = drawRef.current!
    const playBtn = playBtnRef.current!
    const refreshBtn = refreshBtnRef.current!
    const penBtn = penBtnRef.current!
    const eraserBtn = eraserBtnRef.current!
    const clearBtn = clearBtnRef.current!

    const sctx = sim.getContext('2d')!
    const dctx = draw.getContext('2d')!

    // ====== State captured in closure (same as your script) ======
    let W = 0, H = 0
    let DPR = Math.max(1, window.devicePixelRatio || 1)

    // overlay (drawing) state
    let drawEnabled = true, erasing = false, penSize = 4 * DPR, drawing = false
    const strokes: { color: string; size: number; points: { x: number; y: number }[] }[] = []
    let currentStroke: { color: string; size: number; points: { x: number; y: number }[] } | null = null

    // physics state
    type C = {
      x:number; y:number; r:number; color:string;
      z:number; vz:number; landed:boolean;
      rot:number; vrot:number; svx:number; svy:number
    }
    const counters: C[] = []
    const colors = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899']
    let gravityZ = 1.0; let restitution = 0.65; let running = true
    let rafId: number | null = null

    // recent split pairs
    const recent: string[] = []
    const rememberPair = (t:number,i:number)=>{ const key=`${t}-${i}`; recent.push(key); if(recent.length>8) recent.shift() }
    const seenPair = (t:number,i:number)=> recent.includes(`${t}-${i}`)

    // main circle
    const center = { x:0,y:0,r:0 }
    function layoutMainCircle(){ center.x=(W*DPR)/2; center.y=(H*DPR)/2; center.r=Math.min(W,H)*DPR*0.28 }

    // helpers
    const randInt = (a:number,b:number)=> a + Math.floor(Math.random()*(b-a+1))
    const pickInside = (total:number)=> {
      let k = randInt(1,total-1)
      if((k===1||k===total-1) && Math.random()<0.7 && total>=6){ k = randInt(2,total-2) }
      return k
    }

    const redrawStrokes = () => {
      dctx.clearRect(0,0,draw.width,draw.height)
      dctx.lineCap='round'
      dctx.lineJoin='round'
      for (const s of strokes){
        dctx.strokeStyle = '#111827'
        dctx.lineWidth = s.size
        const pts = s.points; if(!pts.length) continue
        dctx.beginPath()
        dctx.moveTo(pts[0].x, pts[0].y)
        for (let i=1;i<pts.length;i++) dctx.lineTo(pts[i].x, pts[i].y)
        dctx.stroke()
      }
    }

    function fit() {
      // size to the "card" panel
      const rect = panel.getBoundingClientRect()
      const availH = rect.height - 100 // bottom sentence area ~100px
      W = Math.max(320, Math.floor(rect.width))
      H = Math.max(320, Math.floor(availH))
      DPR = Math.max(1, window.devicePixelRatio || 1)
      penSize = 4 * DPR

      sim.width = Math.floor(W * DPR)
      sim.height = Math.floor(H * DPR)
      sim.style.width = `${W}px`
      sim.style.height = `${H}px`

      // full-card drawing canvas so students can write on the sentence too
      draw.width = Math.floor(rect.width * DPR)
      draw.height = Math.floor(rect.height * DPR)
      draw.style.width = `${rect.width}px`
      draw.style.height = `${rect.height}px`

      redrawStrokes()
    }

    // non-overlap helpers
    function randomPointInside(radius:number){
      const m=18*DPR; const r=Math.random()*(radius-m); const t=Math.random()*Math.PI*2
      return { x:center.x+Math.cos(t)*r, y:center.y+Math.sin(t)*r }
    }
    function randomPointOutside(radius:number){
      const worldW=W*DPR, worldH=H*DPR, m=18*DPR
      const leftToolbar={x:0,y:0,w:220*DPR,h:56*DPR}
      const rightToolbar={x:worldW-260*DPR,y:0,w:260*DPR,h:56*DPR}
      for(let tries=0;tries<300;tries++){
        const x=m+Math.random()*(worldW-2*m); const y=m+Math.random()*(worldH-2*m)
        const d=Math.hypot(x-center.x,y-center.y)
        const inToolbar =
          (x>leftToolbar.x && x<leftToolbar.x+leftToolbar.w && y>leftToolbar.y && y<leftToolbar.y+leftToolbar.h) ||
          (x>rightToolbar.x && x<rightToolbar.x+rightToolbar.w && y>rightToolbar.y && y<rightToolbar.y+rightToolbar.h)
        if(d>radius+m && !inToolbar) return {x,y}
      }
      return { x: worldW - m, y: worldH - m }
    }
    function nonOverlappingPlace(list:{x:number;y:number;r:number}[], candidate:{x:number;y:number}, r:number){
      const minGap=2*DPR
      for(const o of list){
        const dx=o.x-candidate.x, dy=o.y-candidate.y
        if((dx*dx+dy*dy) < (o.r+r+minGap)**2) return false
      }
      return true
    }

    // Spawning / resplitting
    let currentTotal=0, currentInside=0
    function resolveOverlaps(iter=1){
      const worldW=W*DPR, worldH=H*DPR
      for(let k=0;k<iter;k++){
        for (let i=0; i<counters.length; i++){
          for (let j=i+1; j<counters.length; j++){
            const a=counters[i], b=counters[j]
            const dx=b.x-a.x, dy=b.y-a.y; const dist=Math.hypot(dx,dy)
            const minDist=a.r+b.r
            if (dist>0 && dist < minDist){
              const overlap = (minDist - dist)
              const nx = dx/dist, ny = dy/dist
              const push = overlap/2
              a.x -= nx*push; a.y -= ny*push
              b.x += nx*push; b.y += ny*push
            }
          }
        }
        for (const c of counters){
          if(c.x-c.r<0) c.x=c.r
          if(c.y-c.r<0) c.y=c.r
          if(c.x+c.r>worldW) c.x=worldW-c.r
          if(c.y+c.r>worldH) c.y=worldH-c.r
        }
      }
    }
    function spawnSplit(total:number, insideCount:number){
      counters.length=0
      const rMin=10*DPR, rMax=16*DPR
      const temp:{x:number;y:number;r:number}[] = []
      for(let i=0;i<insideCount;i++){
        const r=rMin+Math.random()*(rMax-rMin); let p, tries=0
        do{ p=randomPointInside(center.r - r); tries++ } while(tries<160 && !nonOverlappingPlace(temp,p,r))
        temp.push({ ...p, r })
      }
      for(let i=insideCount;i<total;i++){
        const r=rMin+Math.random()*(rMax-rMin); let p, tries=0
        do{ p=randomPointOutside(center.r + r); tries++ } while(tries<200 && !nonOverlappingPlace(temp,p,r))
        temp.push({ ...p, r })
      }
      for(let i=temp.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [temp[i],temp[j]]=[temp[j],temp[i]] }
      for(let i=0;i<temp.length;i++){
        const t=temp[i]
        const z0=(140+Math.random()*200)*DPR
        const vx0=(Math.random()*2-1)*0.6*DPR
        const vy0=(Math.random()*2-1)*0.6*DPR
        counters.push({
          x:t.x, y:t.y, r:t.r, color:colors[i%colors.length],
          z:z0, vz:0, landed:false, rot:Math.random()*Math.PI*2,
          vrot:(Math.random()*0.25)*(Math.random()<0.5?-1:1),
          svx:vx0, svy:vy0
        })
      }
      resolveOverlaps(6)
      currentTotal=total; currentInside=insideCount; rememberPair(total, insideCount)
    }
    function newNumber(){
      let tries=0, total:number, inside:number
      do{ total=randInt(4,10); inside=pickInside(total); tries++ } while(tries<40 && seenPair(total,inside))
      spawnSplit(total, inside)
    }
    function resplitSame(){
      if(!currentTotal){ newNumber(); return }
      let tries=0, inside:number
      do{ inside=pickInside(currentTotal); tries++ } while(tries<40 && (inside===currentInside || seenPair(currentTotal,inside)))
      spawnSplit(currentTotal, inside)
    }

    // physics + render
    function physics(){
      const g=gravityZ*0.45*DPR
      const worldW=W*DPR, worldH=H*DPR
      for(const c of counters){
        if(!c.landed){
          c.vz-=g; c.z+=c.vz
          c.x+=c.svx*0.35; c.y+=c.svy*0.35; c.svx*=0.995; c.svy*=0.995
          if(c.z<=0 && c.vz<0){ c.z=0; c.vz*=-restitution; if(Math.abs(c.vz)<0.8*DPR){ c.vz=0; c.landed=true } }
          c.rot+=c.vrot; c.vrot*=0.995
        } else {
          c.x+=c.svx*0.1; c.y+=c.svy*0.1; c.svx*=0.9; c.svy*=0.9
          if(Math.abs(c.svx)<0.02*DPR) c.svx=0
          if(Math.abs(c.svy)<0.02*DPR) c.svy=0
        }
        if(c.x-c.r<0){ c.x=c.r; c.svx=-c.svx*0.3 }
        if(c.y-c.r<0){ c.y=c.r; c.svy=-c.svy*0.3 }
        if(c.x+c.r>worldW){ c.x=worldW-c.r; c.svx=-c.svx*0.3 }
        if(c.y+c.r>worldH){ c.y=worldH-c.r; c.svy=-c.svy*0.3 }
      }
      resolveOverlaps(1)
    }
    function drawWorld(){
      sctx.clearRect(0,0,sim.width, sim.height)
      sctx.save(); sctx.fillStyle='#fff'; sctx.fillRect(0,0,sim.width, sim.height); sctx.restore()
      sctx.save(); sctx.translate(0.5,0.5); sctx.fillStyle='#f1f5f9'; sctx.strokeStyle='#94a3b8'
      sctx.lineWidth=2*DPR; sctx.beginPath(); sctx.arc(center.x, center.y, center.r, 0, Math.PI*2); sctx.fill(); sctx.stroke(); sctx.restore()
      for(const c of counters){
        const shadowGrow=Math.min(1.0, c.z/(220*DPR))
        const shR1=c.r*(1.05+shadowGrow*0.6); const shR2=c.r*(0.85+shadowGrow*0.8)
        sctx.save(); sctx.globalAlpha=0.18+shadowGrow*0.22; sctx.fillStyle='#000'
        sctx.beginPath(); sctx.ellipse(c.x+0.6*DPR, c.y+1.8*DPR, shR1, shR2, 0, 0, Math.PI*2); sctx.fill(); sctx.restore()
        sctx.save(); const lift=Math.min(6*DPR, c.z*0.02); sctx.translate(c.x, c.y-lift)
        sctx.beginPath(); sctx.fillStyle=c.color; sctx.arc(0,0,c.r,0,Math.PI*2); sctx.fill()
        sctx.rotate(c.rot); sctx.beginPath(); sctx.globalAlpha=0.18; sctx.fillStyle='#fff'
        sctx.arc(0,0,c.r*0.75,-0.8,0.8); sctx.lineTo(0,0); sctx.closePath(); sctx.fill(); sctx.restore()
      }
    }
    const tick = () => { if(running) physics(); drawWorld(); rafId = requestAnimationFrame(tick) }

    // toolbar + drawing
    function setActiveTool(btn: HTMLButtonElement){
      penBtn.setAttribute('aria-pressed', (btn===penBtn).toString())
      eraserBtn.setAttribute('aria-pressed', (btn===eraserBtn).toString())
    }
    function setDrawEnabled(on:boolean){ drawEnabled=on; draw.style.pointerEvents = on ? 'auto' : 'none' }

    function getPos(e: MouseEvent | TouchEvent){
      const r = draw.getBoundingClientRect()
      if ('touches' in e && e.touches && e.touches[0]) {
        return { x:(e.touches[0].clientX-r.left)*DPR, y:(e.touches[0].clientY-r.top)*DPR }
      }
      const me = e as MouseEvent
      return { x:(me.clientX-r.left)*DPR, y:(me.clientY-r.top)*DPR }
    }
    function eraseByPoint(p:{x:number;y:number}, radius:number){
      const r2 = radius*radius; const keep: typeof strokes = []
      for (const s of strokes){
        let hit=false
        for (let i=0;i<s.points.length;i++){
          const dx=s.points[i].x-p.x, dy=s.points[i].y-p.y
          if (dx*dx+dy*dy <= r2){ hit=true; break }
        }
        if(!hit) keep.push(s)
      }
      if (keep.length !== strokes.length){ strokes.length=0; strokes.push(...keep) }
    }

    // pointer handlers
    const start = (e: MouseEvent | TouchEvent) => {
      if(!drawEnabled) return
      drawing=true
      const p = getPos(e)
      if(erasing){
        eraseByPoint(p, penSize*1.2)
      } else {
        currentStroke={ color:'#111827', size:penSize, points:[p] }
        strokes.push(currentStroke)
      }
      redrawStrokes()
      e.preventDefault?.()
    }
    const move = (e: MouseEvent | TouchEvent) => {
      if(!drawing) return
      const p = getPos(e)
      if(erasing) eraseByPoint(p, penSize*1.2)
      else currentStroke!.points.push(p)
      redrawStrokes()
      e.preventDefault?.()
    }
    const end = () => { drawing=false; currentStroke=null }

    // temporarily disable drawing while pressing toolbar buttons
    const toolIds = [playBtn, refreshBtn, penBtn, eraserBtn, clearBtn]
    const pressDown = () => { draw.style.pointerEvents = 'none' }
    const pressUp = () => { draw.style.pointerEvents = drawEnabled ? 'auto' : 'none' }

    // wire events
    const ro = new ResizeObserver(() => { fit(); layoutMainCircle() })
    ro.observe(panel)

    window.addEventListener('resize', () => { fit(); layoutMainCircle() })

    playBtn.addEventListener('click', () => { resplitSame() })
    refreshBtn.addEventListener('click', () => { newNumber() })
    penBtn.addEventListener('click', (e) => { erasing=false; setActiveTool(penBtn); setDrawEnabled(true) })
    eraserBtn.addEventListener('click', () => { erasing=true; setActiveTool(eraserBtn); setDrawEnabled(true) })
    clearBtn.addEventListener('click', () => { strokes.length=0; dctx.clearRect(0,0,draw.width,draw.height) })

    toolIds.forEach(btn => {
      btn.addEventListener('mousedown', pressDown)
      btn.addEventListener('mouseup', pressUp)
      btn.addEventListener('mouseleave', pressUp)
      btn.addEventListener('touchstart', pressDown, { passive:true } as any)
      btn.addEventListener('touchend', pressUp)
    })

    draw.addEventListener('mousedown', start as any)
    draw.addEventListener('mousemove', move as any)
    window.addEventListener('mouseup', end)

    draw.addEventListener('touchstart', start as any, { passive:false } as any)
    draw.addEventListener('touchmove', move as any, { passive:false } as any)
    window.addEventListener('touchend', end)

    // init + loop
    fit(); layoutMainCircle(); newNumber()
    rafId = requestAnimationFrame(tick)

    return () => {
      // cleanup
      if (rafId != null) cancelAnimationFrame(rafId)
      ro.disconnect()
      window.removeEventListener('resize', () => { fit(); layoutMainCircle() })
      draw.removeEventListener('mousedown', start as any)
      draw.removeEventListener('mousemove', move as any)
      window.removeEventListener('mouseup', end)
      draw.removeEventListener('touchstart', start as any)
      draw.removeEventListener('touchmove', move as any)
      window.removeEventListener('touchend', end)
      toolIds.forEach(btn => {
        btn.removeEventListener('mousedown', pressDown)
        btn.removeEventListener('mouseup', pressUp)
        btn.removeEventListener('mouseleave', pressUp)
        btn.removeEventListener('touchstart', pressDown as any)
        btn.removeEventListener('touchend', pressUp)
      })
    }
  }, [])

  return (
    <div style={{
      padding: 12,
      minHeight: '100vh',
      background: 'linear-gradient(180deg, #eef2ff 0%, #f7f7fb 40%)'
    }}>
      <div className="panel sim-card"
        ref={panelRef}
        style={{
          position:'relative', minHeight:560, height:'76vh',
          background:'#fff', border:'1px solid #e2e8f0', borderRadius:16,
          boxShadow:'0 10px 20px rgba(0,0,0,.08)'
        }}
      >
        {/* Top toolbar (left) */}
        <div style={{position:'absolute', top:10, left:10, zIndex:12, display:'flex', gap:8}}>
          <button ref={playBtnRef}
            className="primary"
            style={btnPrimary}
            title="Drop counters" aria-label="Drop counters">▶ Play</button>
          <button ref={refreshBtnRef}
            className="ghost"
            style={btnGhost}
            title="New number & split" aria-label="New number">↻ Refresh</button>
        </div>

        {/* Top toolbar (right) */}
        <div style={{position:'absolute', top:10, right:10, zIndex:12, display:'flex', gap:8}}>
          <button ref={penBtnRef}
            className="success tool"
            style={{...btnSuccess, ...(toolPressed)}}
            aria-pressed="true" title="Draw">✎ Pen</button>
          <button ref={eraserBtnRef}
            className="ghost tool"
            style={btnGhost}
            aria-pressed="false" title="Erase">⌫ Eraser</button>
          <button ref={clearBtnRef}
            className="ghost"
            style={btnGhost}
            title="Clear annotations">🗑️ Clear</button>
        </div>

        {/* Simulation area */}
        <div className="sim-wrap" style={{ position:'absolute', inset:'0 0 100px 0' }}>
          <canvas id="sim" ref={simRef} style={{
            display:'block', width:'100%', height:'100%',
            borderRadius:16, background:'#fff', border:'1px solid #e5e7eb', position:'absolute', inset:0, zIndex:1
          }} />
        </div>

        {/* Drawing canvas covers entire card (so students can write over sentence) */}
        <canvas id="draw" ref={drawRef} style={{ position:'absolute', inset:0, zIndex:5 }} />

        {/* Sentence strip */}
        <div id="stem" style={{
          position:'absolute', left:0, right:0, bottom:0, padding:18,
          borderTop:'1px dashed #e2e8f0', background:'#fff',
          display:'flex', flexWrap:'wrap', gap:14, justifyContent:'center', alignItems:'center', fontSize:22
        }}>
          <span style={{ letterSpacing:2 }}>_______</span> inside and
          <span style={{ letterSpacing:2 }}>_______</span> outside make
          <span style={{ letterSpacing:2 }}>_______</span> total.
        </div>
      </div>
    </div>
  )
}

// button styles (inline to keep this file self-contained)
const baseBtn: React.CSSProperties = {
  fontFamily: 'inherit', padding:'10px 12px', borderRadius:12, border:'1px solid #cbd5e1', background:'#fff', cursor:'pointer'
}
const btnPrimary: React.CSSProperties = { ...baseBtn, background:'#3b82f6', borderColor:'#3b82f6', color:'#fff', fontWeight:600 }
const btnSuccess: React.CSSProperties = { ...baseBtn, background:'#22c55e', borderColor:'#22c55e', color:'#fff', fontWeight:600 }
const btnGhost: React.CSSProperties = { ...baseBtn, background:'#fff' }
const toolPressed: React.CSSProperties = { outline:'3px solid #3b82f6', boxShadow:'0 0 0 3px rgba(59,130,246,.2) inset' }
