import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Point to local worker bundled in public/
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';

interface CanvasPdfViewerProps {
  data?: Uint8Array;
  blobUrl?: string;
  fileName?: string;
}

export const CanvasPdfViewer: React.FC<CanvasPdfViewerProps> = ({ data, blobUrl }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.3);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pdfDocRef = useRef<any>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<any>(null);

  useEffect(() => {
    let isCancelled = false;
    setLoading(true);
    setErrorMsg(null);

    const loadDoc = async () => {
      try {
        console.log('[Viewer] Loading PDF with bundled CMaps & standard font packages...');
        
        // Use relative path to public/cmaps/ and public/standard_fonts/
        const cMapUrl = './cmaps/';
        const standardFontDataUrl = './standard_fonts/';

        let loadingTask;
        if (data && data.byteLength > 0) {
          console.log(`[Viewer] Loading Uint8Array buffer (${data.byteLength} bytes) with full font assets`);
          loadingTask = pdfjsLib.getDocument({
            data: data.slice(),
            cMapUrl: cMapUrl,
            cMapPacked: true,
            standardFontDataUrl: standardFontDataUrl,
            enableXfa: true,
          });
        } else if (blobUrl) {
          console.log(`[Viewer] Loading blobUrl (${blobUrl}) with full font assets`);
          loadingTask = pdfjsLib.getDocument({
            url: blobUrl,
            cMapUrl: cMapUrl,
            cMapPacked: true,
            standardFontDataUrl: standardFontDataUrl,
            enableXfa: true,
          });
        } else {
          throw new Error('لا توجد بيانات ثنائية للملف');
        }

        const doc = await loadingTask.promise;
        if (isCancelled) return;

        console.log(`[Viewer] PDF parsed successfully! Total pages: ${doc.numPages}`);
        pdfDocRef.current = doc;
        setNumPages(doc.numPages);
        setCurrentPage(1);
        setLoading(false);
      } catch (err: any) {
        console.error('[Viewer] PDF.js getDocument error:', err);
        if (!isCancelled) {
          setErrorMsg(err.message || 'تعذر تحليل ملف الـ PDF أو تحميل الخطوط القياسية.');
          setLoading(false);
        }
      }
    };

    loadDoc();

    return () => {
      isCancelled = true;
    };
  }, [data, blobUrl]);

  // Render current page to canvas with high fidelity & proper pixel ratio
  useEffect(() => {
    if (!pdfDocRef.current || currentPage < 1) return;

    let isCancelled = false;

    const renderPage = async () => {
      try {
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }

        const page = await pdfDocRef.current.getPage(currentPage);
        if (isCancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;

        const context = canvas.getContext('2d', { alpha: false });
        if (!context) return;

        // Native screen scale for crisp text rendering of Arabic ligatures and French accents
        const pixelRatio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * pixelRatio });

        // Set buffer size for crisp font glyphs
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        // Set visual display size
        canvas.style.width = `${viewport.width / pixelRatio}px`;
        canvas.style.height = `${viewport.height / pixelRatio}px`;

        const renderContext = {
          canvasContext: context,
          viewport: viewport,
          intent: 'display',
        };

        const task = page.render(renderContext);
        renderTaskRef.current = task;
        await task.promise;
      } catch (err: any) {
        if (err.name !== 'RenderingCancelledException') {
          console.error('[Viewer] Page render error:', err);
        }
      }
    };

    renderPage();

    return () => {
      isCancelled = true;
    };
  }, [currentPage, scale, numPages]);

  return (
    <div className="canvas-pdf-viewer" style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', userSelect: 'none' }}>
      {/* Control Bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 16px',
        backgroundColor: '#1e293b',
        borderBottom: '1px solid #334155',
        color: '#f8fafc',
        fontSize: '0.88rem'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className="btn btn-outline"
            style={{ padding: '4px 10px' }}
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
          >
            السابق ◀
          </button>
          <span>
            الصفحة {currentPage} من {numPages || 1}
          </span>
          <button
            className="btn btn-outline"
            style={{ padding: '4px 10px' }}
            disabled={currentPage >= numPages}
            onClick={() => setCurrentPage(p => Math.min(numPages, p + 1))}
          >
            ▶ التالي
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className="btn btn-outline"
            style={{ padding: '4px 8px' }}
            onClick={() => setScale(s => Math.max(0.7, s - 0.2))}
          >
            🔍 -
          </button>
          <span>{Math.round(scale * 100)}%</span>
          <button
            className="btn btn-outline"
            style={{ padding: '4px 8px' }}
            onClick={() => setScale(s => Math.min(3.0, s + 0.2))}
          >
            🔍 +
          </button>
        </div>
      </div>

      {/* Main Viewport */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          padding: '16px',
          backgroundColor: '#0f172a'
        }}
      >
        {loading && (
          <div style={{ textAlign: 'center', marginTop: '40px', color: '#94a3b8' }}>
            <div style={{ fontSize: '2rem', marginBottom: 8 }}>⏳</div>
            <p>جاري فك التشفير وعرض المستند بالخطوط الأصلية...</p>
          </div>
        )}

        {errorMsg && (
          <div style={{ textAlign: 'center', marginTop: '40px', color: '#f87171', padding: '16px', backgroundColor: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', maxWidth: '80%' }}>
            <div style={{ fontSize: '2rem', marginBottom: 8 }}>⚠️</div>
            <p style={{ fontWeight: 700 }}>تعذر فتح المستند:</p>
            <p style={{ fontSize: '0.85rem', marginTop: 4 }}>{errorMsg}</p>
          </div>
        )}

        <canvas
          ref={canvasRef}
          style={{
            display: loading || errorMsg ? 'none' : 'block',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            backgroundColor: '#ffffff',
            borderRadius: '4px'
          }}
        />
      </div>
    </div>
  );
};
