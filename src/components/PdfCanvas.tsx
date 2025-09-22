// src/components/PdfCanvas.tsx
import { useEffect, useRef } from 'react'

type Props = {
  url: string               // PDF URL (Supabase public URL or /aprende-m2.pdf)
  pageIndex: number         // 0-based index
  onReady?: (pdf: any, canvas: HTMLCanvasElement) => void
  scale?: number            // default 1.25
}

export default function PdfCanvas({ url, pageIndex, onReady, scale = 1.25 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let cancelled = false
    let cleanup: (() => void) | null = null

    ;(async () => {
      if (!url) return
      try {
        const pdfjs: any = await import('pdfjs-dist/build/pdf')

        // ✅ v4 worker is an ES module (.mjs). Use a CDN that serves it.
        pdfjs.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.worker.min.mjs'

        const loadingTask = pdfjs.getDocument(url)
        const pdf = await loadingTask.promise
        if (cancelled) return

        const page = await pdf.getPage(pageIndex + 1)
        if (cancelled) return

        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        canvas.width = viewport.width
        canvas.height = viewport.height

        const renderTask = page.render({ canvasContext: ctx, viewport })
        await renderTask.promise
        if (cancelled) return

        onReady?.(pdf, canvas)

        cleanup = () => {
          try { (loadingTask as any)?.destroy?.() } catch {}
          try { (pdf as any)?.destroy?.() } catch {}
        }
      } catch (e) {
        console.error('PdfCanvas load error', e)
      }
    })()

    return () => {
      cancelled = true
      if (cleanup) cleanup()
    }
  }, [url, pageIndex, scale, onReady])

  return <canvas ref={canvasRef} style={{ width: '100%', height: 'auto', display: 'block' }} />
}
