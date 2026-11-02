import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Subidas binarias en FLUJO (application/octet-stream): el archivo va directo a un temporal en disco, con tope de tamaño
 * contado byte a byte (además del Content-Length declarado). Así un ZIP grande no pasa por memoria ni por base64.
 */
export function acceptOctetStream(app: FastifyInstance) {
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
}

export async function streamToTemp(req: FastifyRequest, limit: number): Promise<{ file: string; size: number; cleanup: () => void }> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw Object.assign(new Error(`El archivo pesa ${Math.round(declared / 1048576)} MB: el máximo es ${Math.round(limit / 1048576)} MB.`), { statusCode: 413 });
  const body = req.body as NodeJS.ReadableStream | undefined;
  if (!body || typeof (body as any).pipe !== 'function') throw Object.assign(new Error('Envía el archivo como application/octet-stream.'), { statusCode: 415 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pia-up-')); const file = path.join(dir, 'subida.bin');
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temporal */ } };
  let size = 0;
  const counter = new Transform({ transform(chunk, _enc, cb) { size += chunk.length; if (size > limit) cb(Object.assign(new Error(`El archivo supera el máximo de ${Math.round(limit / 1048576)} MB.`), { statusCode: 413 })); else cb(null, chunk); } });
  try { await pipeline(body, counter, fs.createWriteStream(file, { flags: 'wx' })); }
  catch (e) { cleanup(); throw e; }
  return { file, size, cleanup };
}

/** Nombre del archivo subido (cabecera x-file-name, codificada) — solo el nombre base. */
export const uploadName = (req: FastifyRequest) => {
  const raw = String((req.query as any)?.name ?? req.headers['x-file-name'] ?? '');
  let n = raw; try { n = decodeURIComponent(raw); } catch { /* tal cual */ }
  return path.basename(n.replace(/\\/g, '/')).slice(0, 200);
};
