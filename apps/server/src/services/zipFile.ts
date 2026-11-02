import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

/**
 * ZIP mínimo y defensivo, leído DESDE DISCO (nunca el archivo entero en memoria) y escrito en flujo. Reutilizable: lotes de
 * documentos, adjuntos del chat, entregables.
 *
 * Lectura: directorio central por lectura posicional; cada entrada se valida sin extraer (recorrido de directorios, rutas
 * absolutas, enlaces, cifrado, métodos no admitidos, ZIP64, tamaños y relación de compresión) y se extrae de una en una con
 * tope de salida y CRC comprobado. Escritura: entradas deflate una a una, CRC y tamaños en el directorio central.
 */
export interface ZipEntry {
  name: string; flags: number; method: number; crc: number; csize: number; usize: number; localOffset: number; external: number;
  isDir: boolean; problem: string | null;
}
export interface ZipListing { size: number; entries: ZipEntry[] }

const err = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len); let off = 0;
  while (off < len) { const n = fs.readSync(fd, b, off, len - off, pos + off); if (n <= 0) break; off += n; }
  return off === len ? b : b.subarray(0, off);
}

/** Problema de una entrada (o null). `maxEntryBytes` y `maxRatio` acotan cada archivo descomprimido. */
export function entryProblem(e: Pick<ZipEntry, 'name' | 'flags' | 'method' | 'csize' | 'usize' | 'external'>, opts: { maxEntryBytes: number; maxRatio: number }): string | null {
  const n = e.name;
  if (!n || n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').includes('..') || n.includes('\u0000')) return 'ruta no permitida (recorrido de directorios)';
  if (((e.external >>> 16) & 0o170000) === 0o120000) return 'es un enlace';
  if (e.flags & 0x1) return 'cifrado';
  if (e.method !== 0 && e.method !== 8) return 'compresión no admitida';
  if (e.csize === 0xffffffff || e.usize === 0xffffffff) return 'ZIP64 no admitido';
  if (e.usize > opts.maxEntryBytes) return `demasiado grande (máx. ${Math.round(opts.maxEntryBytes / 1048576)} MB)`;
  if (e.csize > 0 && e.usize / e.csize > opts.maxRatio) return 'relación de compresión sospechosa';
  return null;
}

/** Lista las entradas sin extraer nada. Lanza si el archivo no es un ZIP legible o supera el máximo de entradas. */
export function listZip(file: string, opts: { maxEntries: number; maxEntryBytes: number; maxRatio: number }): ZipListing {
  const st = fs.statSync(file); const fd = fs.openSync(file, 'r');
  try {
    const tailLen = Math.min(st.size, 65_557); const tail = readAt(fd, st.size - tailLen, tailLen);
    const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]); const at = tail.lastIndexOf(sig);
    if (at < 0 || at + 22 > tail.length) throw err('No es un ZIP válido.');
    const count = tail.readUInt16LE(at + 10); const cdSize = tail.readUInt32LE(at + 12); const cdOff = tail.readUInt32LE(at + 16);
    if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw err('ZIP64 no admitido: divide el archivo en ZIP más pequeños (menos de 65 535 archivos y 4 GB).');
    if (count > opts.maxEntries) throw err(`El ZIP tiene ${count} entradas: el máximo es ${opts.maxEntries}. Divídelo en varios ZIP.`);
    if (cdOff + cdSize > st.size) throw err('ZIP dañado (directorio central fuera del archivo).');
    if (cdSize > 64 * 1024 * 1024) throw err('ZIP no admitido: su índice es demasiado grande.');
    const cd = readAt(fd, cdOff, cdSize); const entries: ZipEntry[] = []; let p = 0;
    for (let k = 0; k < count; k++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw err('ZIP dañado (entrada del directorio central).');
      const flags = cd.readUInt16LE(p + 8); const method = cd.readUInt16LE(p + 10); const crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20); const usize = cd.readUInt32LE(p + 24); const nlen = cd.readUInt16LE(p + 28);
      const xlen = cd.readUInt16LE(p + 30); const clen = cd.readUInt16LE(p + 32); const external = cd.readUInt32LE(p + 38); const localOffset = cd.readUInt32LE(p + 42);
      const raw = cd.subarray(p + 46, p + 46 + nlen); const name = (flags & 0x800 ? raw.toString('utf8') : raw.toString('latin1')).replace(/\\/g, '/');
      p += 46 + nlen + xlen + clen;
      const isDir = name.endsWith('/');
      const e: ZipEntry = { name, flags, method, crc, csize, usize, localOffset, external, isDir, problem: null };
      e.problem = isDir ? null : entryProblem(e, opts)
        // Lo declarado debe caber en el archivo (si no, leerlo reservaría memoria por un tamaño falso).
        ?? (localOffset + 30 + nlen + csize > st.size ? 'datos fuera del archivo' : null)
        ?? (method === 0 && csize !== usize ? 'tamaños incoherentes' : null)
        ?? (method === 8 && csize > usize + Math.ceil(usize / 100) + 65_536 ? 'tamaños incoherentes' : null);
      entries.push(e);
    }
    return { size: st.size, entries };
  } finally { fs.closeSync(fd); }
}

/** Extrae UNA entrada (validada antes) con tope de salida y CRC; nunca más de lo declarado. */
export function readZipEntry(file: string, e: ZipEntry): Buffer {
  if (e.problem) throw err(`${e.name}: ${e.problem}`);
  const fd = fs.openSync(file, 'r');
  try {
    const lh = readAt(fd, e.localOffset, 30);
    if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw err(`${e.name}: cabecera local dañada`);
    const start = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    if (start + e.csize > fs.fstatSync(fd).size) throw err(`${e.name}: datos fuera del archivo`);
    const comp = readAt(fd, start, e.csize);
    if (comp.length !== e.csize) throw err(`${e.name}: datos fuera del archivo`);
    let data: Buffer;
    try { data = e.method === 0 ? comp : zlib.inflateRawSync(comp, { maxOutputLength: e.usize + 1 }); } catch { throw err(`${e.name}: no se pudo descomprimir (o excede lo declarado)`); }
    if (data.length !== e.usize || zlib.crc32(data) !== e.crc) throw err(`${e.name}: tamaño o CRC no coinciden`);
    return data;
  } finally { fs.closeSync(fd); }
}

/**
 * Escribe un ZIP en flujo (deflate, un archivo a la vez en memoria). `files`: nombre dentro del ZIP (único, sin rutas
 * peligrosas) y ruta del archivo en disco. Escritura exclusiva: nunca reemplaza un ZIP existente.
 */
export async function writeZip(outFile: string, files: { name: string; file: string }[]): Promise<{ bytes: number; entries: number }> {
  const seen = new Set<string>();
  for (const f of files) {
    if (!f.name || f.name.startsWith('/') || f.name.split('/').includes('..') || /^[a-z]:/i.test(f.name)) throw err(`Nombre no permitido en el ZIP: ${f.name}`);
    if (seen.has(f.name.toLowerCase())) throw err(`Nombre repetido en el ZIP: ${f.name}`);
    seen.add(f.name.toLowerCase());
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fd = fs.openSync(outFile, 'wx'); const central: Buffer[] = []; let off = 0;
  const dos = (d: Date) => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });
  try {
    for (const f of files) {
      await new Promise<void>(r => setImmediate(r));
      const data = fs.readFileSync(f.file); const comp = zlib.deflateRawSync(data); const crc = zlib.crc32(data);
      if (data.length >= 0xffffffff || comp.length >= 0xffffffff || off >= 0xffffffff) throw err('El entregable superaría 4 GB: divide el lote.');
      const name = Buffer.from(f.name, 'utf8'); const t = dos(fs.statSync(f.file).mtime);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(t.time, 10); lh.writeUInt16LE(t.date, 12);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
      fs.writeSync(fd, lh); fs.writeSync(fd, name); fs.writeSync(fd, comp);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(t.time, 12); ch.writeUInt16LE(t.date, 14);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
      central.push(Buffer.concat([ch, name]));
      off += 30 + name.length + comp.length;
    }
    const cd = Buffer.concat(central); fs.writeSync(fd, cd);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    fs.writeSync(fd, end);
    return { bytes: off + cd.length + 22, entries: files.length };
  } catch (e) { try { fs.closeSync(fd); } catch { /* ya cerrado */ } try { fs.rmSync(outFile, { force: true }); } catch { /* sin archivo */ } throw e; }
  finally { try { fs.closeSync(fd); } catch { /* ya cerrado */ } }
}

/** SHA-256 de un archivo leído en flujo, sin bloquear el servidor (un ZIP de 1 GB tarda unos segundos). */
export async function sha256FileAsync(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) h.update(chunk as Buffer);
  return h.digest('hex');
}
