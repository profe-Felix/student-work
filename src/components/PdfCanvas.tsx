import { useEffect, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument, PDFDocumentProxy } from 'pdfjs-dist'
// Vite: import the worker as a real worker URL so it loads on GitHub Pages
// @ts-ignore
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?worker&url'

GlobalWorkerOptions.workerSrc = workerSrc

export default function PdfCanvas({ url, pageIndex, onReady }:{
  url: string
  pageIndex: number
  onReady?: (pdf: PDFDocumentProxy, canvas: HTMLCanvasElement) => void
}){
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(true)

  useEffect(()=>{
    let cancelled = false
    setLoading(true); setError(null)
    ;(async()=>{
      try{
        const pdf = await getDocument(url).promise
        const page = await pdf.getPage(pageIndex+1)
        const viewport = page.getViewport({ scale: 1.5 })
        const canvas = canvasRef.current!
        const ctx = canvas.getContext('2d')!
        canvas.width = viewport.width
        canvas.height = viewport.height
        await page.render({ canvasContext: ctx, viewport }).promise
        if(!cancelled) onReady?.(pdf, canvas)
      }catch(e:any){
        if(!cancelled) setError(e?.message || 'Failed to load PDF')
      }finally{
        if(!cancelled) setLoading(false)
      }
    })()
    return ()=>{ cancelled = true }
  },[url, pageIndex])

  if(error){
    return (
      <div style={{padding:12,border:'1px solid #fca5a5',background:'#fee2e2',color:'#991b1b',borderRadius:8}}>
        <strong>PDF viewer error</strong><br/>
        {error}<br/>
        The rest of the page should still work. Try a hard refresh, or we can test without PDF rendering.
      </div>
    )
  }

  return (
    <div>
      {loading && <div style={{opacity:.7,marginBottom:8}}>Loading page…</div>}
      <canvas ref={canvasRef} style={{ display:'block', maxWidth:'100%' }}/>
    </div>
  )
}
