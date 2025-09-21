//src/components/PdfCanvas.tsx
import { useEffect, useRef } from 'react'

type Props = {
  /** Full URL to a PDF (can be a public Supabase URL or your bundled /aprende-m2.pdf) */
  url: string
  /** 0-based page index to render */
  pageIndex: number
  /** Called after the page is rendered (pdf, canvas) */
  onReady?: (pdf: any, canvas: HTMLCanvasElement) => void
  /** Render scale; default 1.25 */
  scale?: number
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
        // ✅ ensure the web worker is used (prevents "Setting up fake worker" warning)
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.js',
          import.meta.url
        ).toString()

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
