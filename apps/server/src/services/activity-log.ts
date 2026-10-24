// Registro de actividad. Provisional: archivo JSONL de solo anexado hasta que exista la
// persistencia SQLite por empresa (HU-003). La interfaz permite sustituir la implementación.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ActivityEntrySchema, validate } from '@portal/contracts';
import type { ActivityEntry } from '@portal/contracts';

export interface ActivityLog {
  append(entry: ActivityEntry): Promise<void>;
  list(): Promise<readonly ActivityEntry[]>;
}

function esArchivoInexistente(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export class JsonlActivityLog implements ActivityLog {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Valida la entrada con el contrato y la anexa. Nunca reescribe el archivo. */
  async append(entry: ActivityEntry): Promise<void> {
    const result = validate(ActivityEntrySchema, entry);
    if (!result.ok) {
      const detalle = result.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
      throw new Error(`Entrada de actividad inválida: ${detalle}`);
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(result.data)}\n`, 'utf8');
  }

  async list(): Promise<readonly ActivityEntry[]> {
    let contenido: string;
    try {
      contenido = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (esArchivoInexistente(error)) return [];
      throw error;
    }
    return contenido
      .split('\n')
      .filter((linea) => linea.trim().length > 0)
      .map((linea) => ActivityEntrySchema.parse(JSON.parse(linea)));
  }
}
