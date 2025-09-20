import { useEffect, useRef } from 'react'
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

  useEffect(()=>{
    let cancelled = false
    ;(async()=>{
      const pdf = await getDocument(url).promise
      const page = await pdf.getPage(pageIndex+1)
      const viewport = page.getViewport({ scale: 1.5 })
      const canvas = canvasRef.current!
      const ctx = canvas.getContext('2d')!
      canvas.width = viewport.width
      canvas.height = viewport.height
      await page.render({ canvasContext: ctx, viewport }).promise
      if(!cancelled) onReady?.(pdf, canvas)
    })()
    return ()=>{ cancelled = true }
  },[url, pageIndex])

  return <canvas ref={canvasRef} style={{ display:'block', maxWidth:'100%' }}/>
}
