import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { getDocument, type OFDDocument, type OFDSource, type RenderTask, type Diagnostic } from '../index.js';
export interface OFDViewerProps {
  source: OFDSource | null;
  initialScale?: number;
  className?: string;
  style?: CSSProperties;
  onLoad?: (document: OFDDocument) => void;
  onError?: (error: Error) => void;
  onDiagnostics?: (diagnostics: readonly Diagnostic[]) => void;
}
const asError = (e: unknown): Error => e instanceof Error ? e : new Error(String(e));
export function OFDViewer({ source, initialScale = 1, className = '', style, onLoad, onError, onDiagnostics }: OFDViewerProps) {
  const [doc, setDoc] = useState<OFDDocument | null>(null), [page, setPage] = useState(1);
  const [scale, setScale] = useState(initialScale), [rotation, setRotation] = useState(0);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [rendering, setRendering] = useState(false);
  const [diagnostics, setDiagnostics] = useState<readonly Diagnostic[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null), container = useRef<HTMLDivElement>(null);
  const docRef = useRef(doc); docRef.current = doc;
  const renderQueue = useRef<Promise<void>>(Promise.resolve());
  const callbacks = useRef({ onLoad, onError, onDiagnostics }); callbacks.current = { onLoad, onError, onDiagnostics };
  useEffect(() => {
    const controller = new AbortController(); let owned: OFDDocument | undefined;
    setDoc(null); setError(''); setDiagnostics([]); setPage(1); setLoading(!!source);
    if (source) void getDocument(source, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) { result.destroy(); return; }
      owned = result; setDoc(result); setLoading(false); callbacks.current.onLoad?.(result);
    }).catch(e => { if (!controller.signal.aborted) { setError(asError(e).message); setLoading(false); callbacks.current.onError?.(asError(e)); } });
    return () => { controller.abort(); owned?.destroy(); };
  }, [source]);
  useEffect(() => {
    let cancelled = false, task: RenderTask | undefined;
    if (!doc) return;
    setRendering(true); setError('');
    const run = async () => {
      if (cancelled) return;
      try {
        const ofdPage = await doc.getPage(page); if (cancelled || !canvas.current) return;
        const ctx = canvas.current.getContext('2d'); if (!ctx) throw new Error('Canvas 2D unavailable');
        task = ofdPage.render({ canvasContext: ctx, viewport: ofdPage.getViewport({ scale, rotation }) });
        await task.promise;
        if (!cancelled) { const ds = [...doc.diagnostics]; setDiagnostics(ds); callbacks.current.onDiagnostics?.(ds); }
      } catch (e) { if (!cancelled) { setError(asError(e).message); callbacks.current.onError?.(asError(e)); } }
      finally { if (!cancelled) setRendering(false); }
    };
    renderQueue.current = renderQueue.current.catch(() => {}).then(run);
    return () => { cancelled = true; task?.cancel(); };
  }, [doc, page, scale, rotation]);
  const fit = async () => {
    if (!doc || !container.current) return;
    const current = doc;
    try {
      const p = await current.getPage(page);
      if (docRef.current !== current || !container.current) return;
      setScale(Math.max(.1, Math.min(4, (container.current.clientWidth - 48) / p.getViewport({ rotation }).width)));
    } catch (e) {
      if (docRef.current === current) { setError(asError(e).message); callbacks.current.onError?.(asError(e)); }
    }
  };
  return <section className={`ofd-viewer ${className}`} style={style} aria-label="OFD 文档阅读器">
    <div className="ofd-toolbar">
      <span className="ofd-brand">OFD<span>JS</span></span><span className="ofd-divider" />
      <button aria-label="上一页" disabled={!doc || page <= 1} onClick={() => setPage(p => p - 1)}>←</button>
      <span className="ofd-pages"><input aria-label="页码" type="number" min={1} max={doc?.numPages || 1} value={page} disabled={!doc} onChange={e => { const n = Number(e.target.value); if (doc && Number.isInteger(n) && n >= 1 && n <= doc.numPages) setPage(n); }} /> / {doc?.numPages ?? '—'}</span>
      <button aria-label="下一页" disabled={!doc || page >= doc.numPages} onClick={() => setPage(p => p + 1)}>→</button>
      <span className="ofd-divider" />
      <button aria-label="缩小" disabled={!doc || scale <= .25} onClick={() => setScale(s => Math.max(.25, s - .25))}>−</button>
      <span className="ofd-zoom">{Math.round(scale * 100)}%</span>
      <button aria-label="放大" disabled={!doc || scale >= 4} onClick={() => setScale(s => Math.min(4, s + .25))}>＋</button>
      <button disabled={!doc} onClick={() => void fit()}>适合宽度</button>
      <button aria-label="旋转页面" disabled={!doc} onClick={() => setRotation(r => (r + 90) % 360)}>↻</button>
      <span className="ofd-status" role="status">{loading ? '正在读取…' : rendering ? '正在渲染…' : doc ? 'Canvas · 本地渲染' : '等待打开文件'}</span>
    </div>
    {error && <div className="ofd-error" role="alert">{error}</div>}
    {diagnostics.length > 0 && <details className="ofd-diagnostics"><summary>兼容性提示 · {diagnostics.length}</summary><ul>{diagnostics.map((d, i) => <li key={i}>{d.message}</li>)}</ul></details>}
    <div className="ofd-stage" ref={container} aria-busy={loading || rendering}>
      {doc ? <canvas ref={canvas} className="ofd-canvas" aria-label={`第 ${page} 页`} style={{ visibility: error || rendering ? 'hidden' : 'visible' }} /> : <div className="ofd-empty"><span>▤</span><h2>{loading ? '正在打开文档' : '在浏览器中阅读 OFD'}</h2><p>选择一个 .ofd 文件开始预览</p></div>}
    </div>
  </section>;
}
