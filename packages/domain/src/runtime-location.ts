// Reglas puras para comparar la carpeta y la rama en ejecución del Portal con el repositorio
// registrado del proyecto. Sin IO: recibe hechos ya obtenidos y decide.

import { MAIN_BRANCH, isValidBranchName } from './git-branch.ts';

export const RUNTIME_LOCATION_STATES = [
  'coincide',
  'carpeta-distinta',
  'rama-distinta',
  'carpeta-y-rama-distintas',
  'no-verificable'
] as const;

export type RuntimeLocationState = (typeof RUNTIME_LOCATION_STATES)[number];

export interface UbicacionEjecucion {
  /** Raíz del repositorio desde el que corre el Portal (null si no se pudo determinar). */
  readonly ruta: string | null;
  /** Rama activa (null si HEAD está desacoplado o no se pudo leer). */
  readonly rama: string | null;
  readonly headDesacoplado: boolean;
}

export interface UbicacionRegistrada {
  /** Ruta del repositorio registrado (null si el proyecto no tiene repositorio). */
  readonly ruta: string | null;
  readonly rama: string | null;
}

export interface HistoriaUbicacion {
  readonly id: string;
  readonly titulo: string;
  readonly sha: string | null;
  /** true/false si se pudo comprobar; null si es desconocido (sin SHA o sin repositorio). */
  readonly contenida: boolean | null;
}

export interface ComparacionUbicacion {
  readonly estado: RuntimeLocationState;
  /** Motivo en español; solo presente (no null) cuando el estado es «no-verificable». */
  readonly motivoNoVerificable: string | null;
}

const PLATAFORMAS_SIN_MAYUSCULAS: ReadonlySet<string> = new Set(['win32', 'darwin']);

/**
 * Normaliza una ruta para compararla: separadores, barras repetidas o finales y, en sistemas
 * de archivos que no distinguen mayúsculas (Windows y macOS), las mayúsculas.
 */
export function normalizarRuta(ruta: string, plataforma: string): string {
  let resultado = ruta.trim();
  if (plataforma === 'win32') resultado = resultado.replaceAll('\\', '/');
  const esUnc = plataforma === 'win32' && resultado.startsWith('//');
  resultado = resultado.replace(/\/{2,}/g, '/');
  if (esUnc) resultado = `/${resultado}`;
  while (resultado.length > 1 && resultado.endsWith('/') && !/^[A-Za-z]:\/$/.test(resultado)) {
    resultado = resultado.slice(0, -1);
  }
  return PLATAFORMAS_SIN_MAYUSCULAS.has(plataforma) ? resultado.toLowerCase() : resultado;
}

export interface ComparacionEntrada {
  readonly ejecucion: UbicacionEjecucion;
  readonly registrado: UbicacionRegistrada;
  /** Valor de process.platform (win32, darwin, linux…). */
  readonly plataforma: string;
}

function noVerificable(motivo: string): ComparacionUbicacion {
  return { estado: 'no-verificable', motivoNoVerificable: motivo };
}

function conEstado(estado: RuntimeLocationState): ComparacionUbicacion {
  return { estado, motivoNoVerificable: null };
}

/** Calcula si el Portal corre desde la carpeta y la rama del repositorio registrado. */
export function compararUbicacion(entrada: ComparacionEntrada): ComparacionUbicacion {
  const { ejecucion, registrado, plataforma } = entrada;
  if (registrado.ruta === null) {
    return noVerificable('El proyecto no tiene un repositorio registrado.');
  }
  if (ejecucion.ruta === null) {
    return noVerificable('No se pudo determinar la carpeta desde la que corre el Portal.');
  }
  const carpetaDistinta =
    normalizarRuta(ejecucion.ruta, plataforma) !== normalizarRuta(registrado.ruta, plataforma);

  if (ejecucion.rama === null) {
    if (carpetaDistinta) return conEstado('carpeta-distinta');
    return noVerificable(
      ejecucion.headDesacoplado
        ? 'El repositorio en ejecución tiene HEAD desacoplado: no hay una rama que comparar.'
        : 'No se pudo determinar la rama en ejecución.'
    );
  }
  if (registrado.rama === null) {
    if (carpetaDistinta) return conEstado('carpeta-distinta');
    return noVerificable('El repositorio registrado no indica una rama.');
  }
  const ramaDistinta = ejecucion.rama !== registrado.rama;
  if (carpetaDistinta && ramaDistinta) return conEstado('carpeta-y-rama-distintas');
  if (carpetaDistinta) return conEstado('carpeta-distinta');
  if (ramaDistinta) return conEstado('rama-distinta');
  return conEstado('coincide');
}

export interface ClasificacionHistorias {
  /** Historias cuyo commit se comprobó y NO está en la rama en ejecución. */
  readonly noContenidas: HistoriaUbicacion[];
  /** Historias que no se pudieron comprobar (sin SHA registrado o sin repositorio). */
  readonly desconocidas: HistoriaUbicacion[];
}

export function clasificarHistorias(historias: readonly HistoriaUbicacion[]): ClasificacionHistorias {
  return {
    noContenidas: historias.filter((historia) => historia.contenida === false),
    desconocidas: historias.filter((historia) => historia.contenida === null)
  };
}

export interface PasosEntrada {
  readonly estado: RuntimeLocationState;
  readonly ejecucion: UbicacionEjecucion;
  readonly registrado: UbicacionRegistrada;
  /** Identificadores de historias completadas que no están en la rama en ejecución. */
  readonly historiasNoContenidas: readonly string[];
}

const SIN_DATO = '(desconocida)';

/** Pasos de corrección en español con las rutas y ramas concretas. Vacío si coincide o no es verificable. */
export function construirPasosCorreccion(entrada: PasosEntrada): string[] {
  const { estado, ejecucion, registrado, historiasNoContenidas } = entrada;
  if (estado === 'coincide' || estado === 'no-verificable') return [];

  const rutaEjecucion = ejecucion.ruta ?? SIN_DATO;
  const rutaRegistrada = registrado.ruta ?? SIN_DATO;
  const ramaEjecucion = ejecucion.rama ?? SIN_DATO;
  const ramaRegistrada = registrado.rama ?? SIN_DATO;
  const pasos: string[] = [];

  if (estado === 'carpeta-distinta' || estado === 'carpeta-y-rama-distintas') {
    pasos.push(
      `Detén el Portal, abre una terminal en ${rutaRegistrada} y ejecútalo desde ahí con npm run dev.`
    );
    pasos.push(
      `Si la carpeta correcta es ${rutaEjecucion}, actualiza el repositorio registrado del proyecto para que apunte a ella.`
    );
  }
  if (estado === 'rama-distinta' || estado === 'carpeta-y-rama-distintas') {
    const rutaGit = estado === 'rama-distinta' ? rutaEjecucion : rutaRegistrada;
    pasos.push(
      `Ejecuta git -C "${rutaGit}" switch ${ramaRegistrada} o fusiona ${ramaEjecucion} en ${ramaRegistrada}.`
    );
    pasos.push(
      `Si la rama correcta es ${ramaEjecucion}, actualiza la rama registrada del proyecto.`
    );
  }
  if (historiasNoContenidas.length > 0) {
    pasos.push(
      `Comprueba que la rama en ejecución contiene las historias completadas que faltan: ${historiasNoContenidas.join(', ')}.`
    );
  }
  pasos.push('Reinicia el Portal y pulsa «Volver a comprobar» para confirmar que ya coincide.');
  return pasos;
}

// ---------------------------------------------------------------------------------------------
// Comprobación previa a toda ejecución (HU-129): el Portal debe correr desde main actualizado y la
// rama por defecto del remoto debe ser main. Regla «denegar por defecto»: lo que no se puede
// determinar bloquea igual que un fallo.
// ---------------------------------------------------------------------------------------------

export const PREFLIGHT_CHECK_IDS = [
  'rama-actual',
  'main-actualizado',
  'rama-por-defecto-remoto'
] as const;

export type PreflightCheckId = (typeof PREFLIGHT_CHECK_IDS)[number];

export const PREFLIGHT_CHECK_STATES = ['ok', 'fallo', 'indeterminado'] as const;

export type PreflightCheckState = (typeof PREFLIGHT_CHECK_STATES)[number];

export interface ExecutionPreflightInput {
  /** Rama activa del Portal (null si HEAD está desacoplado o no se pudo leer). */
  readonly currentBranch: string | null;
  /** SHA de HEAD (null si no se pudo leer). */
  readonly headSha: string | null;
  /** SHA de origin/main tras consultar el remoto (null si no se pudo obtener). */
  readonly originMainSha: string | null;
  /** Rama por defecto del remoto (null si no se pudo consultar). */
  readonly remoteDefaultBranch: string | null;
}

export interface PreflightCheck {
  readonly id: PreflightCheckId;
  readonly estado: PreflightCheckState;
  /** Detalle en español. */
  readonly detalle: string;
}

export interface ExecutionPreflightEvaluation {
  readonly ok: boolean;
  readonly checks: PreflightCheck[];
  /** Motivo en español del bloqueo; null cuando ok es true. */
  readonly motivo: string | null;
}

function checkRamaActual(currentBranch: string | null): PreflightCheck {
  if (currentBranch === null) {
    return {
      id: 'rama-actual',
      estado: 'indeterminado',
      detalle: 'No se pudo determinar la rama en ejecución (HEAD desacoplado o repositorio ilegible).'
    };
  }
  if (currentBranch !== MAIN_BRANCH) {
    return {
      id: 'rama-actual',
      estado: 'fallo',
      detalle: `El Portal corre desde «${currentBranch}», no desde ${MAIN_BRANCH}.`
    };
  }
  return { id: 'rama-actual', estado: 'ok', detalle: `El Portal corre desde ${MAIN_BRANCH}.` };
}

function checkMainActualizado(headSha: string | null, originMainSha: string | null): PreflightCheck {
  if (headSha === null || originMainSha === null) {
    return {
      id: 'main-actualizado',
      estado: 'indeterminado',
      detalle:
        headSha === null
          ? 'No se pudo leer el commit actual (HEAD).'
          : 'No se pudo actualizar ni leer origin/main: no se puede confirmar que main esté al día.'
    };
  }
  if (headSha !== originMainSha) {
    return {
      id: 'main-actualizado',
      estado: 'fallo',
      detalle: `HEAD (${headSha.slice(0, 7)}) no coincide con origin/main (${originMainSha.slice(0, 7)}).`
    };
  }
  return {
    id: 'main-actualizado',
    estado: 'ok',
    detalle: `HEAD coincide con origin/main (${headSha.slice(0, 7)}).`
  };
}

function checkRamaPorDefectoRemoto(remoteDefaultBranch: string | null): PreflightCheck {
  if (remoteDefaultBranch === null) {
    return {
      id: 'rama-por-defecto-remoto',
      estado: 'indeterminado',
      detalle: 'No se pudo consultar la rama por defecto del remoto.'
    };
  }
  if (remoteDefaultBranch !== MAIN_BRANCH) {
    return {
      id: 'rama-por-defecto-remoto',
      estado: 'fallo',
      detalle: `La rama por defecto del remoto es «${remoteDefaultBranch}», no ${MAIN_BRANCH}.`
    };
  }
  return {
    id: 'rama-por-defecto-remoto',
    estado: 'ok',
    detalle: `La rama por defecto del remoto es ${MAIN_BRANCH}.`
  };
}

/** Decide si una historia puede empezar a ejecutarse. Denegar por defecto: un dato ausente bloquea. */
export function evaluateExecutionPreflight(input: ExecutionPreflightInput): ExecutionPreflightEvaluation {
  const checks: PreflightCheck[] = [
    checkRamaActual(input.currentBranch),
    checkMainActualizado(input.headSha, input.originMainSha),
    checkRamaPorDefectoRemoto(input.remoteDefaultBranch)
  ];
  const problemas = checks.filter((check) => check.estado !== 'ok');
  if (problemas.length === 0) return { ok: true, checks, motivo: null };

  const hayFallo = problemas.some((check) => check.estado === 'fallo');
  const cabecera = hayFallo
    ? 'Detenido: el Portal no corre desde main actualizado.'
    : 'Detenido: no se pudo verificar que el Portal corra desde main actualizado.';
  const motivo = `${cabecera} ${problemas.map((check) => check.detalle).join(' ')}`;
  return { ok: false, checks, motivo };
}

/**
 * Extrae la rama por defecto de la salida de «git ls-remote --symref <remoto> HEAD»
 * (línea «ref: refs/heads/<rama>\tHEAD»). Devuelve null si no se reconoce.
 */
export function parseRemoteDefaultBranch(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
    const branch = match?.[1];
    if (branch !== undefined) return isValidBranchName(branch) ? branch : null;
  }
  return null;
}

/** Heurística mínima: un SHA de git completo en hexadecimal minúscula. */
export function isFullGitSha(value: string): boolean {
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);
}

/** Instrucciones para el propietario cuando el remoto no tiene main como rama por defecto. */
export const OWNER_DEFAULT_BRANCH_STEPS: readonly string[] = [
  'En GitHub abre Settings → Branches → Default branch y elige main (requiere permisos de administrador del repositorio).',
  'En local ejecuta git fetch origin && git remote set-head origin -a.',
  'Cambia a main (git switch main && git pull) y reinicia el Portal desde ahí.'
];
