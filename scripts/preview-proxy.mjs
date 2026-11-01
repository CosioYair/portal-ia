// Proxy HTTP de una vista previa (contenedor propio en una red propia, código de confianza del Portal; ver
// apps/server/src/services/preview.ts). Es el ÚNICO camino del navegador al candidato, que vive en un contenedor sin red:
// - reenvía solo a su socket (destino fijo; sin URI absolutas, CONNECT ni upgrade) y solo con el Host de la vista previa
//   (una página de otro dominio que «se reasigne» a 127.0.0.2 no la lee);
// - quita cookies y credenciales en ambos sentidos y los diálogos de autenticación;
// - impone una política de seguridad: la página no puede hablar con otros orígenes (el Portal en marcha), registrar service
//   workers, enviar formularios fuera, abrir ventanas ni descargas, pedir cámara, micrófono, portapapeles…, ni incrustarse;
// - marca cada página con una franja «Vista previa aislada · NO es el Portal en marcha» (que no escribas claves reales).
import http from 'node:http';
import os from 'node:os';

const SOCK = '/run/pv/app.sock'; const PORT = 8080;
const HOST = process.env.PREVIEW_HOST || '127.0.0.2';
const BANNER = (process.env.PREVIEW_BANNER || 'Vista previa aislada · NO es el Portal en marcha').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:", "connect-src 'self'", "form-action 'self'", "worker-src 'none'", "frame-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
  'sandbox allow-scripts allow-same-origin allow-forms allow-modals'
].join('; ');
const PERMISSIONS = 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), clipboard-read=(), display-capture=(), payment=(), publickey-credentials-get=()';
const hostOk = h => new RegExp(`^${HOST.replace(/\./g, '\\.')}:\\d+$`).test(String(h ?? ''));
const ip = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address ?? '0.0.0.0';
let first = true;

const server = http.createServer((req, res) => {
  if (!req.url || !req.url.startsWith('/') || req.headers['service-worker'] || !hostOk(req.headers.host)) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end('No permitido en la vista previa.'); return; }
  // El Host ya comprobado (127.0.0.2:puerto) llega tal cual: el Portal candidato lo reconoce como local y de su mismo origen.
  const headers = { ...req.headers, 'accept-encoding': 'identity' };
  for (const h of ['cookie', 'authorization', 'proxy-authorization', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) delete headers[h];
  const up = http.request({ socketPath: SOCK, path: req.url, method: req.method, headers }, r => {
    const h = { ...r.headers, 'content-security-policy': CSP, 'permissions-policy': PERMISSIONS, 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin', 'x-content-type-options': 'nosniff' };
    delete h['set-cookie']; delete h['www-authenticate'];
    const html = /text\/html/.test(String(r.headers['content-type'] ?? ''));
    // Primera página de esta vista previa: borra lo que dejara otra anterior en este origen (almacenamiento, caché y cookies).
    if (first && html) { h['clear-site-data'] = '"cache", "storage", "cookies"'; first = false; }
    if (!html) { res.writeHead(r.statusCode ?? 502, h); r.pipe(res); return; }
    const chunks = []; r.on('data', c => chunks.push(c)); r.on('error', () => res.destroy());
    r.on('end', () => {
      const bar = `<div role="status" style="position:fixed;z-index:2147483647;left:0;right:0;bottom:0;padding:6px 12px;background:#7a2e0e;color:#fff;font:600 13px/1.4 system-ui,sans-serif;text-align:center">${BANNER}</div>`;
      let body = Buffer.concat(chunks).toString('utf8');
      body = /<\/body>/i.test(body) ? body.replace(/<\/body>/i, `${bar}</body>`) : body + bar;
      delete h['content-length']; delete h['transfer-encoding'];
      res.writeHead(r.statusCode ?? 502, { ...h, 'content-length': Buffer.byteLength(body) }); res.end(body);
    });
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('La vista previa aún está arrancando o ya se detuvo.'); });
  req.pipe(up);
});
server.on('upgrade', (_req, socket) => socket.destroy());
server.on('connect', (_req, socket) => socket.destroy());
server.listen(PORT, ip, () => console.log(`[vista previa] proxy en ${ip}:${PORT}`));
