import { useEffect, useMemo, useRef, useState } from 'react';

// Shows one email's HTML safely:
//   - sandboxed iframe with NO scripts (an email can't run code or touch rlyfe)
//   - remote images blocked until you tap "Show images" (they're how senders track opens)
//   - links open in a new tab; wide newsletter layouts shrink to the phone's width
export default function EmailBody({ html, text }: { html: string | null; text: string | null }) {
  const [images, setImages] = useState(false);
  const [height, setHeight] = useState(120);
  const frame = useRef<HTMLIFrameElement>(null);

  const hasRemoteImages = useMemo(() => !!html && /<img[^>]+src=["']?https?:/i.test(html), [html]);

  const doc = useMemo(() => {
    if (!html) return '';
    const csp = `default-src 'none'; style-src 'unsafe-inline' https:; font-src https: data:; img-src data: cid:${images ? ' https: http:' : ''};`;
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  html, body { margin: 0; padding: 0; background: #fff; color: #1f2326; }
  body { padding: 12px; font: 15px/1.5 -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif; overflow-wrap: anywhere; }
  img { max-width: 100% !important; height: auto !important; }
  table { max-width: 100% !important; }
  td, th { word-break: break-word; }
  pre { white-space: pre-wrap; }
  blockquote { margin: 8px 0; padding-left: 10px; border-left: 3px solid #ddd; color: #555; }
</style></head><body>${html}</body></html>`;
  }, [html, images]);

  // Fit the frame to its content (allowed because the frame is same-origin, still script-free)
  useEffect(() => {
    if (!html) return;
    const fit = () => {
      const d = frame.current?.contentDocument;
      if (d?.documentElement) setHeight(Math.min(20000, d.documentElement.scrollHeight + 4));
    };
    const timers = [100, 400, 1200, 3000].map(ms => window.setTimeout(fit, ms));
    return () => timers.forEach(clearTimeout);
  }, [doc, html]);

  if (!html) return <pre className="email-text">{text ?? ''}</pre>;

  return (
    <div className="email-html">
      {hasRemoteImages && !images && (
        <button className="link small" onClick={() => setImages(true)}>Show images</button>
      )}
      <iframe
        ref={frame}
        title="Email"
        srcDoc={doc}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        style={{ height }}
        onLoad={() => {
          const d = frame.current?.contentDocument;
          if (d?.documentElement) setHeight(Math.min(20000, d.documentElement.scrollHeight + 4));
        }}
      />
    </div>
  );
}
