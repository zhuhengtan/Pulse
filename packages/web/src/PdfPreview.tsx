import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PulseButton } from './PulseControls.js'
GlobalWorkerOptions.workerSrc = workerUrl

export function PdfPreview({ bytes }: { bytes: Uint8Array }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy>(), [page, setPage] = useState(1), [scale, setScale] = useState(1), [error, setError] = useState('')
  useEffect(() => {
    const task = getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true }); let active = true
    setError(''); setPage(1)
    void task.promise.then(value => { if (active) setPdf(value) }).catch(() => { if (active) setError('PDF 无法打开，可能已损坏或需要密码。') })
    return () => { active = false; setPdf(undefined); void task.destroy() }
  }, [bytes])
  useEffect(() => {
    if (!pdf || !canvas.current) return
    let cancelled = false, rendering: { cancel(): void } | undefined
    void pdf.getPage(page).then(value => {
      if (cancelled || !canvas.current) return
      const viewport = value.getViewport({ scale: scale * 1.25 }), node = canvas.current, context = node.getContext('2d')
      if (!context) return
      node.width = viewport.width; node.height = viewport.height
      delete node.dataset.rendered
      const task = value.render({ canvasContext: context, viewport }); rendering = task
      void task.promise.then(() => { if (!cancelled) node.dataset.rendered = String(page) }).catch(error => { if (!cancelled && error?.name !== 'RenderingCancelledException') setError('PDF 页面渲染失败。') })
    }).catch(() => { if (!cancelled) setError('PDF 页面读取失败。') })
    return () => { cancelled = true; rendering?.cancel() }
  }, [pdf, page, scale])
  return <div className="pdf-preview"><div className="preview-toolbar"><PulseButton disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</PulseButton><span>{page} / {pdf?.numPages ?? '…'}</span><PulseButton disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(page + 1)}>下一页</PulseButton><PulseButton onClick={() => setScale(Math.max(.5, scale - .25))}>−</PulseButton><PulseButton onClick={() => setScale(Math.min(3, scale + .25))}>＋</PulseButton></div>{error ? <p role="alert">{error}</p> : <canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} />}</div>
}
