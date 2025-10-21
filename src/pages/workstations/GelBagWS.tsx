import { useEffect, useRef } from 'react'

/**
 * Gel Bag Decomposer workstation (2–3 parts) with multi-touch "gel press"
 * URL params: parts, count, size, gel, hand, copies, toolbar, stemfs, stemw
 */
export default function GelBagWS() {
  // DOM refs
  const cardRef = useRef<HTMLDivElement | null>(null)
  const simRef = useRef<HTMLCanvasElement | null>(null)
  const drawRef = useRef<HTMLCanvasElement | null>(null)
  const headerRef = useRef<HTMLDivElement | null>(null)
  const stemsRef = useRef<HTMLDivElement | null>(null)

  // Controls
  const countRef = useRef<HTMLInputElement | null>(null)
  const sizeRef = useRef<HTMLInputElement | null>(null)
  const partsRef = useRef<HTMLSelectElement | null>(null)
  const gelRef = useRef<HTMLInputElement | null>(null)
  const handRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const card = cardRef.current!
    const sim = simRef.current!
    const draw = drawRef.current!
    const header = headerRef.current!
    const stems = stemsRef.current!

    const sctx = sim.getContext('2d')!
    const dctx = draw.getContext('2d')!

    // ---- URL params ----
    const params = new URLSearchParams(location.search)
    const numParam = (k:string, d:number)=> {
      const v = params.get(k); return (v!=null && !isNaN(+v)) ? +v : d
    }
    const boolParam = (k:string, d:boolean)=> {
      const v = params.get(k); if(v==null) return d; return v==='1'||v==='true'
    }

    let parts = Math.max(2, Math.min(3, numParam('parts', 2)))
    let COUNT = Math.max(1, Math.min(60, numParam('count', 12)))
    let SIZE  = Math.max(6, Math.min(28, numParam('size', 12)))
    let PRESS_STRENGTH = Math.max(0.02, Math.min(1.2, numParam('gel', 0.22)))
    let AREA_BOOST     = Math.max(0.3, Math.min(3.0, numParam('hand', 1.0)))
    let COPIES = Math.max(1, Math.min(10, numParam('copies', 5)))
    // NEW: stems width + font size
    let STEM_W  = Math.max(260, Math.min(640, numParam('stemw', 440))) // px
    let STEM_FS = Math.max(18,  Math.min(56,  numParam('stemfs', 32))) // px

    const hideToolbar = params.get('toolbar') === '0' || params.get('toolbar') === 'false'

    // Apply defaults to UI if visible
    const countEl = countRef.current!, sizeEl = sizeRef.current!
    const partsEl = partsRef.current!, gelEl = gelRef.current!, handEl = handRef.current!
    if (countEl) countEl.value = String(COUNT)
    if (sizeEl)  sizeEl.value  = String(SIZE)
    if (partsEl) partsEl.value = String(parts)
    if (gelEl)   gelEl.value   = String(PRESS_STRENGTH)
    if (handEl)  handEl.value  = String(AREA_BOOST)

    // expose stems width as a CSS var so JSX can use it
    document.documentElement.style.setProperty('--stemW', `${STEM_W}px`)

    if (hideToolbar) {
      header.style.display = 'none'
    }

    // ---- State ----
    let DPR = Math.max(1, window.devicePixelRatio || 1)
    let W = 0, H = 0, penSize = 4 * DPR
    const colors = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899']
    const bag = { x:0, y:0, w:0, h:0 }
    type Ball = { x:number;y:number;r:number;color:string; vx:number;vy:number; grabbed:boolean }
    const balls: Ball[] = []
    let Rmin = 8*DPR, Rmax = 16*DPR

    // drawing strokes
    type Stroke = { size:number; pts:{x:number;y:number}[] }
    const strokes: Stroke[] = []
    let currentStroke: Stroke | null = null
    let drawEnabled = true, erasing = false

    // multi-press gel
    type Press = { id:number|string; x:number;y:number;r:number }
    let presses: Press[] = []
    const BASE_PRESS_R = 60
    const VISCOSITY = 0.85

    // ---- Helpers ----
    function setToolbarHeightVar(){
      const hb = header.style.display==='none' ? 0 : header.offsetHeight
      draw.style.top = hb + 'px'
      document.documentElement.style.setProperty('--toolbarH', hb + 'px')
    }

    function fit(){
      setToolbarHeightVar()

      const simWrap = sim.parentElement! // .sim-wrap
      const srect = simWrap.getBoundingClientRect()
      DPR = Math.max(1, window.devicePixelRatio || 1)
      penSize = 4 * DPR

      sim.width = Math.floor(srect.width * DPR)
      sim.height= Math.floor(srect.height* DPR)
      sim.style.width = srect.width + 'px'
      sim.style.height= srect.height + 'px'

      // draw covers bag + stems
      const cardRect = card.getBoundingClientRect()
      const hb = header.style.display==='none' ? 0 : header.offsetHeight
      draw.width  = Math.floor(cardRect.width * DPR)
      draw.height = Math.floor((cardRect.height - hb) * DPR)
      draw.style.width = cardRect.width + 'px'
      draw.style.height= (cardRect.height - hb) + 'px'

      const pad = 24 * DPR
      bag.x = pad; bag.y = pad; bag.w = sim.width - pad*2; bag.h = sim.height - pad*2

      redrawStrokes()
    }

    function rnd(a:number,b:number){ return a + Math.random()*(b-a) }
    function overlapsAny(x:number,y:number,r:number){
      for(const b of balls){ const dx=b.x-x, dy=b.y-y; if((dx*dx+dy*dy) < (b.r+r+2)**2) return true }
      return false
    }
    function clampInBag(b:Ball){
      if(b.x-b.r < bag.x) b.x = bag.x + b.r
      if(b.y-b.r < bag.y) b.y = bag.y + b.r
      if(b.x+b.r > bag.x+bag.w) b.x = bag.x+bag.w - b.r
      if(b.y+b.r > bag.y+bag.h) b.y = bag.y+bag.h - b.r
    }
    function resolveCollisions(){
      for(let i=0;i<balls.length;i++){
        for(let j=i+1;j<balls.length;j++){
          const a=balls[i], b=balls[j]
          const dx=b.x-a.x, dy=b.y-a.y, d=Math.hypot(dx,dy), min=a.r+b.r
          if(d>0 && d<min){
            const push=(min-d)/2, nx=dx/d, ny=dy/d
            a.x -= nx*push; a.y -= ny*push
            b.x += nx*push; b.y += ny*push
            clampInBag(a); clampInBag(b)
          }
        }
      }
    }

    function placeBalls(n:number){
      balls.length = 0
      const triesMax = 800
      for(let i=0;i<n;i++){
        const r = rnd(Rmin, Rmax); let x=0,y=0, tries=0
        while(tries++<triesMax){
          x=rnd(bag.x+r, bag.x+bag.w-r); y=rnd(bag.y+r, bag.y+bag.h-r)
          if(!overlapsAny(x,y,r)) break
        }
        balls.push({ x, y, r, color: colors[i%colors.length], vx:0, vy:0, grabbed:false })
      }
      render()
    }

    function roundRectPath(ctx:CanvasRenderingContext2D, x:number,y:number,w:number,h:number,r:number){
      const rr = Math.min(r, w/2, h/2)
      ctx.moveTo(x+rr, y)
      ctx.arcTo(x+w, y, x+w, y+h, rr)
      ctx.arcTo(x+w, y+h, x, y+h, rr)
      ctx.arcTo(x, y+h, x, y, rr)
      ctx.arcTo(x, y, x+w, y, rr)
      ctx.closePath()
    }
    function partitionXs(){
      const xs:number[] = []
      if(parts===2) xs.push(bag.x + bag.w/2)
      if(parts===3) xs.push(bag.x + bag.w/3, bag.x + 2*bag.w/3)
      return xs
    }

    function drawGelBag(){
      const r = 24*DPR
      sctx.save()
      sctx.beginPath(); roundRectPath(sctx, bag.x,bag.y,bag.w,bag.h,r)
      const g1 = sctx.createLinearGradient(bag.x,bag.y, bag.x,bag.y+bag.h)
      g1.addColorStop(0, 'rgba(59,130,246,.12)')
      g1.addColorStop(0.5, 'rgba(59,130,246,.06)')
      g1.addColorStop(1, 'rgba(59,130,246,.12)')
      sctx.fillStyle = g1; sctx.fill()
      sctx.lineWidth = 2*DPR; sctx.strokeStyle = '#94a3b8'; sctx.stroke()
      sctx.globalAlpha = 0.25; sctx.fillStyle = '#fff'
      sctx.beginPath(); roundRectPath(sctx, bag.x+6*DPR, bag.y+6*DPR, bag.w-12*DPR, bag.h*0.22, r*0.6); sctx.fill()
      sctx.restore()

      const lines = partitionXs()
      sctx.save(); sctx.strokeStyle = 'rgba(30,41,59,.35)'; sctx.setLineDash([8*DPR, 10*DPR]); sctx.lineWidth=2*DPR
      for(const lx of lines){ sctx.beginPath(); sctx.moveTo(lx, bag.y+10*DPR); sctx.lineTo(lx, bag.y+bag.h-10*DPR); sctx.stroke() }
      sctx.restore()

      // visualize presses
      if(presses.length){
        sctx.save(); sctx.globalAlpha=0.15; sctx.fillStyle='#3b82f6'
        for(const p of presses){ sctx.beginPath(); sctx.arc(p.x,p.y,p.r,0,Math.PI*2); sctx.fill() }
        sctx.restore()
      }
    }

    function render(){
      sctx.clearRect(0,0,sim.width, sim.height)
      sctx.save(); sctx.fillStyle='#fff'; sctx.fillRect(0,0,sim.width, sim.height); sctx.restore()
      drawGelBag()
      for(const b of balls){
        sctx.save(); sctx.globalAlpha=0.22; sctx.fillStyle='#000'
        sctx.beginPath(); sctx.ellipse(b.x+0.6*DPR, b.y+1.8*DPR, b.r*1.05, b.r*0.85, 0, 0, Math.PI*2); sctx.fill(); sctx.restore()
        sctx.save(); sctx.translate(b.x, b.y); sctx.beginPath(); sctx.fillStyle=b.color; sctx.arc(0,0,b.r,0,Math.PI*2); sctx.fill()
        sctx.globalAlpha=0.18; sctx.fillStyle='#fff'
        sctx.beginPath(); sctx.arc(-b.r*0.25,-b.r*0.25,b.r*0.6,-0.6,0.8); sctx.lineTo(0,0); sctx.closePath(); sctx.fill()
        sctx.restore()
      }
    }

    function renderStems(){
      const unders = (parts===2)
        ? '<span class="unders">_______</span> + <span class="unders">_______</span> = <span class="unders">_______</span>'
        : '<span class="unders">_______</span> + <span class="unders">_______</span> + <span class="unders">_______</span> = <span class="unders">_______</span>'
      let rows = ''
      for(let i=0;i<COPIES;i++){
        rows += `<div class="stemRow" style="font-size:${STEM_FS}px; padding:10px 0; border-bottom:1px dotted #e5e7eb">${unders}</div>`
      }
      stems.innerHTML = `<div class="stemTitle" style="font-weight:700; font-size:${Math.round(STEM_FS*0.9)}px; margin:4px 0 8px">Descompón (${COPIES} maneras):</div>${rows}`
    }

    // drawing layer
    function redrawStrokes(){
      dctx.clearRect(0,0,draw.width, draw.height)
      dctx.lineCap='round'; dctx.lineJoin='round'
      for(const s of strokes){
        dctx.strokeStyle = '#111827'; dctx.lineWidth = s.size
        const pts=s.pts; if(!pts.length) continue
        dctx.beginPath(); dctx.moveTo(pts[0].x, pts[0].y)
        for(let i=1;i<pts.length;i++) dctx.lineTo(pts[i].x, pts[i].y)
        dctx.stroke()
      }
    }
    function eraseByPoint(p:{x:number;y:number}, radius:number){
      const r2 = radius*radius; const keep: Stroke[] = []
      for(const s of strokes){
        let hit=false; for(const q of s.pts){ const dx=q.x-p.x, dy=q.y-p.y; if(dx*dx+dy*dy<=r2){ hit=true; break } }
        if(!hit) keep.push(s)
      }
      if(keep.length!==strokes.length){ strokes.length=0; strokes.push(...keep) }
    }
    function getPos(e: MouseEvent | TouchEvent, target: HTMLElement){
      const r = target.getBoundingClientRect()
      if('touches' in e && e.touches && e.touches[0]){
        return { x:(e.touches[0].clientX-r.left)*DPR, y:(e.touches[0].clientY-r.top)*DPR }
      }
      const me = e as MouseEvent
      return { x:(me.clientX-r.left)*DPR, y:(me.clientY-r.top)*DPR }
    }

    // input handling
    let draggingBall: number | null = null
    function hitBall(p:{x:number;y:number}){
      for(let i=balls.length-1;i>=0;i--){ const b=balls[i]; const dx=b.x-p.x, dy=b.y-p.y; if(dx*dx+dy*dy<=b.r*b.r) return i }
      return -1
    }
    function updatePressesFromTouches(ev: TouchEvent){
      presses = []
      const rect = sim.getBoundingClientRect()
      for(let i=0;i<ev.touches.length;i++){
        const t = ev.touches[i]
        const x = (t.clientX - rect.left) * DPR
        const y = (t.clientY - rect.top) * DPR
        const rx = (t.radiusX ? t.radiusX : BASE_PRESS_R) * DPR * AREA_BOOST
        const ry = (t.radiusY ? t.radiusY : BASE_PRESS_R) * DPR * AREA_BOOST
        const r = Math.max(20*DPR, (rx+ry)/1.5)
        presses.push({ id: t.identifier, x, y, r })
      }
    }
    function onDown(e: MouseEvent | TouchEvent){
      const simRect = sim.getBoundingClientRect()
      const px = ('touches' in e && e.touches[0]? e.touches[0].clientX : (e as MouseEvent).clientX)
      const py = ('touches' in e && e.touches[0]? e.touches[0].clientY : (e as MouseEvent).clientY)
      const inSim = px>=simRect.left && px<=simRect.right && py>=simRect.top && py<=simRect.bottom

      if(inSim){
        if('touches' in e && (e as TouchEvent).touches){
          updatePressesFromTouches(e as TouchEvent)
          draggingBall=null
        } else {
          const p = getPos(e, sim)
          const i = hitBall(p)
          if(i>=0){ draggingBall=i; balls[i].grabbed=true; balls[i].vx=0; balls[i].vy=0; presses=[] }
          else { presses=[{ id:'mouse', x:p.x, y:p.y, r: (60*DPR*AREA_BOOST) }] }
        }
      }

      // drawing only if not gel-pressing inside sim
      if(drawEnabled && !(inSim && (presses.length || draggingBall!=null))){
        const p = getPos(e, draw)
        if(erasing) eraseByPoint(p, penSize*1.2); else { currentStroke={ size:penSize, pts:[p] }; strokes.push(currentStroke) }
        redrawStrokes()
      }
      e.preventDefault?.()
    }
    function onMove(e: MouseEvent | TouchEvent){
      if('touches' in e && (e as TouchEvent).touches){
        updatePressesFromTouches(e as TouchEvent)
      } else if(draggingBall!=null){
        const p = getPos(e, sim); const b=balls[draggingBall]; b.x=p.x; b.y=p.y; clampInBag(b); resolveCollisions()
      } else if(presses.length){
        const p = getPos(e, sim); presses[0].x=p.x; presses[0].y=p.y
      }
      if(currentStroke){ const p=getPos(e, draw); if(erasing) eraseByPoint(p, penSize*1.2); else currentStroke.pts.push(p); redrawStrokes() }
      e.preventDefault?.()
    }
    function onUp(){ if(draggingBall!=null){ balls[draggingBall].grabbed=false } draggingBall=null; currentStroke=null; presses=[] }

    // physics for gel presses
    function applyPress(){
      for(const b of balls){ b.vx *= VISCOSITY; b.vy *= VISCOSITY }
      for(const p of presses){
        for(const b of balls){
          const dx=b.x-p.x, dy=b.y-p.y, d=Math.hypot(dx,dy)
          if(d < p.r + b.r){
            const nd = Math.max(1, d), nx=dx/nd, ny=dy/nd
            const amt = (1 - Math.min(1, (nd - b.r)/p.r)) * PRESS_STRENGTH * p.r
            b.vx += nx * amt; b.vy += ny * amt
          }
        }
      }
      for(const b of balls){ if(!b.grabbed){ b.x += b.vx; b.y += b.vy; clampInBag(b) } }
      resolveCollisions()
    }

    function tick(){ if(presses.length) applyPress(); render(); requestAnimationFrame(tick) }

    // buttons
    const newBtn = document.getElementById('btnNew') as HTMLButtonElement
    newBtn?.addEventListener('click', ()=> placeBalls(parseInt(countRef.current!.value,10)))
    document.getElementById('btnPen')?.addEventListener('click', ()=>{ erasing=false; drawEnabled=true; setToolPressed(true) })
    document.getElementById('btnErase')?.addEventListener('click', ()=>{ erasing=true; drawEnabled=true; setToolPressed(false) })
    document.getElementById('btnClear')?.addEventListener('click', ()=>{ strokes.length=0; redrawStrokes() })

    // sliders
    countEl?.addEventListener('input', ()=>{})
    sizeEl?.addEventListener('input', ()=>{
      SIZE = parseInt(sizeEl.value,10); Rmin = Math.max(6*DPR, SIZE*DPR*0.8); Rmax = Math.max(Rmin+2, SIZE*DPR*1.0)
    })
    partsEl?.addEventListener('change', ()=>{ parts = parseInt(partsEl.value,10); renderStems() })
    gelEl?.addEventListener('input', ()=>{ PRESS_STRENGTH = parseFloat(gelEl.value) })
    handEl?.addEventListener('input', ()=>{ AREA_BOOST = parseFloat(handEl.value) })

    function setToolPressed(pen:boolean){
      const penBtn = document.getElementById('btnPen')
      const eraBtn = document.getElementById('btnErase')
      penBtn?.setAttribute('aria-pressed', String(pen))
      eraBtn?.setAttribute('aria-pressed', String(!pen))
    }
    setToolPressed(true)

    // resize observers
    const ro = new ResizeObserver(()=> fit())
    ro.observe(card)
    window.addEventListener('resize', fit)

    // pointer on draw (covers sim + stems)
    draw.addEventListener('mousedown', onDown as any, { passive:false } as any)
    draw.addEventListener('mousemove', onMove as any, { passive:false } as any)
    window.addEventListener('mouseup', onUp as any)

    draw.addEventListener('touchstart', onDown as any, { passive:false } as any)
    draw.addEventListener('touchmove', onMove as any, { passive:false } as any)
    window.addEventListener('touchend', onUp as any)

    // init
    fit()
    // radius from SIZE
    function updateR(){ Rmin = Math.max(6*DPR, SIZE*DPR*0.8); Rmax = Math.max(Rmin+2, SIZE*DPR*1.0) }
    updateR()
    placeBalls(COUNT)
    renderStems()
    tick()

    return ()=>{
      ro.disconnect()
      window.removeEventListener('resize', fit)
      window.removeEventListener('mouseup', onUp as any)
      window.removeEventListener('touchend', onUp as any)
    }
  }, [])

  return (
    <div
      ref={cardRef}
      style={{position:'relative', minHeight:560, height:'76vh', background:'#fff', border:'1px solid #e2e8f0', borderRadius:16, boxShadow:'0 10px 20px rgba(0,0,0,.08)'}}
    >
      {/* Header (can hide via ?toolbar=0) */}
      <div ref={headerRef} className="header" style={{
        position:'absolute', top:0, left:0, right:0, padding:10, display:'flex', flexWrap:'wrap', gap:8, alignItems:'center', justifyContent:'space-between',
        background:'#fff', borderBottom:'1px solid #eef2f7', borderTopLeftRadius:16, borderTopRightRadius:16, zIndex:12
      }}>
        <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
          <button id="btnNew" className="primary" style={btnPrimary}>↻ Nuevo</button>
          <label className="select" style={selStyle}>⚪ cantidad <input ref={countRef} type="range" min={1} max={60} defaultValue={12} /> </label>
          <label className="select" style={selStyle}>⚪ tamaño <input ref={sizeRef} type="range" min={6} max={28} defaultValue={12} /> </label>
          <label className="select" style={selStyle}>partes
            <select ref={partsRef} defaultValue={2} style={{marginLeft:6}}><option value={2}>2</option><option value={3}>3</option></select>
          </label>
          <label className="select" style={selStyle}>gel <input ref={gelRef} type="range" min={0.05} max={0.8} step={0.01} defaultValue={0.22} /></label>
          <label className="select" style={selStyle}>mano × <input ref={handRef} type="range" min={0.5} max={2.0} step={0.05} defaultValue={1.0} /></label>
        </div>
        <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
          <button id="btnPen" className="success tool" aria-pressed="true" style={btnSuccess}>✎ Lápiz</button>
          <button id="btnErase" className="ghost tool" aria-pressed="false" style={btnGhost}>⌫ Borrar</button>
          <button id="btnClear" className="ghost" style={btnGhost}>🗑️ Limpiar</button>
        </div>
      </div>

      {/* Stems (right panel) */}
      <aside
        ref={stemsRef}
        className="stems"
        style={{
          position:'absolute',
          top:'var(--toolbarH)',
          right:0,
          bottom:0,
          width:'var(--stemW)',            // ← dynamic width from URL
          borderLeft:'1px dashed #e2e8f0',
          background:'#fff',
          padding:'12px 14px',
          overflow:'auto'
        }}
      />

      {/* Sim region (left of stems, below header) */}
      <div className="sim-wrap" style={{position:'absolute', top:'var(--toolbarH)', left:0, right:'var(--stemW)', bottom:16}}>
        <canvas id="sim" ref={simRef} style={{display:'block', width:'100%', height:'100%', borderRadius:'0 0 0 16px', background:'#fff', border:'1px solid #e5e7eb', position:'absolute', inset:0, zIndex:1}} />
      </div>

      {/* Drawing over both sim + stems (not header) */}
      <canvas id="draw" ref={drawRef} style={{position:'absolute', top:'var(--toolbarH)', left:0, right:0, bottom:0, zIndex:5}} />
    </div>
  )
}

const baseBtn: React.CSSProperties = { fontFamily:'inherit', padding:'10px 12px', borderRadius:12, border:'1px solid #cbd5e1', background:'#fff', cursor:'pointer' }
const btnPrimary: React.CSSProperties = { ...baseBtn, background:'#3b82f6', borderColor:'#3b82f6', color:'#fff', fontWeight:600 }
const btnSuccess: React.CSSProperties = { ...baseBtn, background:'#22c55e', borderColor:'#22c55e', color:'#fff', fontWeight:600 }
const btnGhost: React.CSSProperties = { ...baseBtn, background:'#fff' }
const selStyle: React.CSSProperties = { padding:'8px 10px', borderRadius:10, border:'1px solid #cbd5e1' }
