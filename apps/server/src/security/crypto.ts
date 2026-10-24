import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

/**
 * Cifrado de credenciales en reposo: AES-256-GCM con una clave maestra local.
 * La clave maestra se genera la primera vez y se guarda en <dataDir>/.master.key con permisos 0600.
 * Siguiente paso (futuro): mover la clave maestra al llavero del sistema operativo.
 * Las credenciales en claro nunca se escriben en disco ni en logs y nunca se devuelven al frontend.
 */
const KEY_FILE = path.join(config.dataDir, '.master.key');

function loadMasterKey(): Buffer {
  if (fs.existsSync(KEY_FILE)) {
    const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (hex.length !== 64) throw new Error('Clave maestra corrupta en ' + KEY_FILE);
    return Buffer.from(hex, 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  return key;
}

const masterKey = loadMasterKey();

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(payload: string): string {
  const [v, ivB, tagB, encB] = payload.split(':');
  if (v !== 'v1' || !ivB || !tagB || !encB) throw new Error('Formato de secreto no reconocido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}

/** Pista no sensible para mostrar en la UI: primeros 7 y últimos 4 caracteres. */
export function credentialHint(key: string): string {
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}
