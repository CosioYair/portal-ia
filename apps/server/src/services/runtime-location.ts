// Servicio de solo lectura: compara la carpeta y la rama en ejecución del Portal con el repositorio
// registrado del proyecto y comprueba si la rama contiene los commits de las historias completadas.
// Solo ejecuta comandos git de lectura. No llama a modelos, no tiene coste y nunca lanza.

import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  clasificarHistorias,
  compararUbicacion,
  construirPasosCorreccion,
  type HistoriaUbicacion,
  type UbicacionEjecucion,
  type UbicacionRegistrada
} from '@portal/domain';
import { RuntimeLocationCheckSchema, type RuntimeLocationCheck } from '@portal/contracts';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;
const MAX_HISTORIAS_COMPROBADAS = 50;
const MAX_HISTORIAS_DEVUELTAS = 500;
const SHA_VALIDO = /^[0-9a-f]{7,64}$/i;

export interface RepositorioRegistrado {
  /** Ruta del repositorio registrado del proyecto (null si no tiene). */
  readonly ruta: string | null;
  readonly rama: string | null;
}

export interface HistoriaCompletada {
  readonly id: string;
  readonly titulo: string;
  /** SHA del commit de cierre; null si no se registró. */
  readonly sha: string | null;
}

export interface RuntimeLocationDeps {
  /** Repositorio registrado del proyecto (misma fuente que usa la sincronización del Portal). */
  readonly getRegisteredRepository: (projectId: string) => Promise<RepositorioRegistrado>;
  /** Historias completadas del proyecto, de la más reciente a la más antigua. */
  readonly getCompletedStories: (projectId: string) => Promise<readonly HistoriaCompletada[]>;
  /** Carpeta de trabajo del proceso; por defecto process.cwd(). */
  readonly cwd?: string;
  readonly platform?: string;
  readonly now?: () => Date;
  readonly maxStoriesChecked?: number;
}

export interface RuntimeLocationService {
  check(projectId: string): Promise<RuntimeLocationCheck>;
}

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly code: number | string | null;
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    });
    return { ok: true, stdout: stdout.trim(), code: 0 };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      ok: false,
      stdout: '',
      code: typeof code === 'number' || typeof code === 'string' ? code : null
    };
  }
}

async function rutaReal(ruta: string): Promise<string> {
  try {
    return await realpath(ruta);
  } catch {
    return ruta;
  }
}

type LecturaEjecucion =
  | { readonly ok: true; readonly ejecucion: UbicacionEjecucion; readonly head: string | null }
  | { readonly ok: false; readonly motivo: string };

async function leerEjecucion(cwd: string): Promise<LecturaEjecucion> {
  const top = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok || top.stdout.length === 0) {
    return {
      ok: false,
      motivo:
        top.code === 'ENOENT'
          ? 'Git no está disponible en este equipo: no se puede comprobar la carpeta ni la rama.'
          : 'La carpeta desde la que corre el Portal no es un repositorio git.'
    };
  }
  const rama = await runGit(cwd, ['branch', '--show-current']);
  const head = await runGit(cwd, ['rev-parse', 'HEAD']);
  const nombre = rama.ok && rama.stdout.length > 0 ? rama.stdout : null;
  return {
    ok: true,
    ejecucion: {
      ruta: await rutaReal(top.stdout),
      rama: nombre,
      headDesacoplado: rama.ok && nombre === null
    },
    head: head.ok && head.stdout.length > 0 ? head.stdout : null
  };
}

function noVerificable(
  motivo: string,
  ejecucion: UbicacionEjecucion,
  registrado: UbicacionRegistrada,
  historias: readonly HistoriaCompletada[],
  verificadoEn: string
): RuntimeLocationCheck {
  return {
    estado: 'no-verificable',
    ejecucion,
    registrado,
    historiasCompletadas: historias.slice(0, MAX_HISTORIAS_DEVUELTAS).map((historia) => ({
      id: historia.id,
      titulo: historia.titulo.slice(0, 300),
      sha: historia.sha !== null && SHA_VALIDO.test(historia.sha) ? historia.sha : null,
      contenida: null
    })),
    pasos: [],
    motivoNoVerificable: motivo,
    verificadoEn
  };
}

const SIN_EJECUCION: UbicacionEjecucion = { ruta: null, rama: null, headDesacoplado: false };

export function createRuntimeLocationService(deps: RuntimeLocationDeps): RuntimeLocationService {
  const cwd = deps.cwd ?? process.cwd();
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? (() => new Date());
  const maxComprobadas = deps.maxStoriesChecked ?? MAX_HISTORIAS_COMPROBADAS;
  // La ascendencia de un commit respecto a un HEAD fijo no cambia: se cachea por (HEAD, SHA).
  const cacheContencion = new Map<string, boolean | null>();

  async function contiene(head: string, sha: string): Promise<boolean | null> {
    const clave = `${head}:${sha}`;
    if (cacheContencion.has(clave)) return cacheContencion.get(clave) ?? null;
    const resultado = await runGit(cwd, ['merge-base', '--is-ancestor', sha, head]);
    let valor: boolean | null;
    if (resultado.ok) valor = true;
    else if (resultado.code === 1 || resultado.code === 128) valor = false;
    else valor = null;
    if (cacheContencion.size > 2_000) cacheContencion.clear();
    cacheContencion.set(clave, valor);
    return valor;
  }

  async function calcular(projectId: string): Promise<RuntimeLocationCheck> {
    const verificadoEn = now().toISOString();

    let registradoCrudo: RepositorioRegistrado;
    let historias: readonly HistoriaCompletada[];
    try {
      registradoCrudo = await deps.getRegisteredRepository(projectId);
      historias = await deps.getCompletedStories(projectId);
    } catch {
      return noVerificable(
        'No se pudo leer el repositorio registrado ni las historias del proyecto.',
        SIN_EJECUCION,
        { ruta: null, rama: null },
        [],
        verificadoEn
      );
    }

    const registrado: UbicacionRegistrada = {
      ruta: registradoCrudo.ruta === null ? null : await rutaReal(registradoCrudo.ruta),
      rama: registradoCrudo.rama
    };

    const lectura = await leerEjecucion(cwd);
    if (!lectura.ok) {
      return noVerificable(lectura.motivo, SIN_EJECUCION, registrado, historias, verificadoEn);
    }
    const { ejecucion, head } = lectura;

    const comprobables = registrado.ruta !== null && head !== null;
    const evaluadas: HistoriaUbicacion[] = [];
    let comprobadas = 0;
    for (const historia of historias.slice(0, MAX_HISTORIAS_DEVUELTAS)) {
      const sha = historia.sha !== null && SHA_VALIDO.test(historia.sha) ? historia.sha : null;
      let contenida: boolean | null = null;
      if (comprobables && sha !== null && comprobadas < maxComprobadas) {
        comprobadas += 1;
        contenida = await contiene(head, sha);
      }
      evaluadas.push({ id: historia.id, titulo: historia.titulo.slice(0, 300), sha, contenida });
    }

    const comparacion = compararUbicacion({ ejecucion, registrado, plataforma: platform });
    const { noContenidas } = clasificarHistorias(evaluadas);
    const pasos = construirPasosCorreccion({
      estado: comparacion.estado,
      ejecucion,
      registrado,
      historiasNoContenidas: noContenidas.map((historia) => historia.id)
    });

    return {
      estado: comparacion.estado,
      ejecucion,
      registrado,
      historiasCompletadas: evaluadas,
      pasos,
      ...(comparacion.motivoNoVerificable === null
        ? {}
        : { motivoNoVerificable: comparacion.motivoNoVerificable }),
      verificadoEn
    };
  }

  return {
    async check(projectId: string): Promise<RuntimeLocationCheck> {
      try {
        return RuntimeLocationCheckSchema.parse(await calcular(projectId));
      } catch {
        return noVerificable(
          'La verificación falló de forma inesperada.',
          SIN_EJECUCION,
          { ruta: null, rama: null },
          [],
          now().toISOString()
        );
      }
    }
  };
}

/**
 * Verificación de arranque: escribe una advertencia en el log si la carpeta o la rama no coinciden.
 * Solo incluye rutas y ramas (sin secretos). Nunca lanza.
 */
export async function advertirSiUbicacionNoCoincide(
  service: RuntimeLocationService,
  projectId: string,
  advertir: (mensaje: string) => void
): Promise<void> {
  try {
    const resultado = await service.check(projectId);
    if (resultado.estado === 'coincide' || resultado.estado === 'no-verificable') return;
    advertir(
      `El Portal corre desde una carpeta o rama distinta al repositorio registrado (${resultado.estado}). ` +
        `En ejecución: ${resultado.ejecucion.ruta ?? '(desconocida)'} @ ${resultado.ejecucion.rama ?? '(sin rama)'}. ` +
        `Registrado: ${resultado.registrado.ruta ?? '(desconocida)'} @ ${resultado.registrado.rama ?? '(sin rama)'}.`
    );
  } catch {
    // La advertencia de arranque nunca debe impedir que el servidor arranque.
  }
}
