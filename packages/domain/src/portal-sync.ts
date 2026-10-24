// Reglas puras para decidir si un cambio en el propio Portal exige recargar o reiniciar,
// extraer las historias afectadas y evaluar la publicación. Sin IO.

export const CHANGE_ACTIONS = ['none', 'reload', 'restart'] as const;

/** Acción necesaria para ver un cambio: nada, recargar la página o reiniciar el Portal. */
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

export const CHANGE_AREAS = [
  'web',
  'servidor',
  'paquetes',
  'configuracion',
  'documentacion',
  'pruebas',
  'otros'
] as const;

export type ChangeArea = (typeof CHANGE_AREAS)[number];

export interface PathImpact {
  readonly action: ChangeAction;
  readonly area: ChangeArea;
}

const ACTION_RANK: Readonly<Record<ChangeAction, number>> = { none: 0, reload: 1, restart: 2 };

function normalizePath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function isConfigFile(name: string): boolean {
  return (
    name === 'package.json' ||
    name === 'package-lock.json' ||
    name.startsWith('tsconfig') ||
    name.startsWith('.env')
  );
}

function isTestFile(path: string): boolean {
  return path.split('/').includes('test') || /\.test\.[cm]?[jt]sx?$/.test(path);
}

function isWebRuntimeFile(path: string): boolean {
  return (
    path.startsWith('apps/web/src/') ||
    path.startsWith('apps/web/public/') ||
    path === 'apps/web/index.html'
  );
}

/** Impacto de un único archivo cambiado (ruta relativa a la raíz del monorepositorio). */
export function classifyPath(rawPath: string): PathImpact {
  const path = normalizePath(rawPath);
  if (path.startsWith('docs/')) return { action: 'none', area: 'documentacion' };
  if (isConfigFile(baseName(path))) return { action: 'restart', area: 'configuracion' };
  if (isTestFile(path)) return { action: 'none', area: 'pruebas' };
  if (path.startsWith('apps/server/')) return { action: 'restart', area: 'servidor' };
  if (path.startsWith('packages/')) return { action: 'restart', area: 'paquetes' };
  if (isWebRuntimeFile(path)) return { action: 'reload', area: 'web' };
  if (path.startsWith('apps/web/')) return { action: 'restart', area: 'configuracion' };
  return { action: 'none', area: 'otros' };
}

/** Devuelve la acción más fuerte de entre todos los archivos cambiados. */
export function classifyChangeImpact(paths: readonly string[]): ChangeAction {
  return paths.reduce<ChangeAction>((strongest, path) => {
    const { action } = classifyPath(path);
    return ACTION_RANK[action] > ACTION_RANK[strongest] ? action : strongest;
  }, 'none');
}

/** Áreas tocadas por los archivos cambiados (únicas, sin «otros»), en orden estable. */
export function describeChangedAreas(paths: readonly string[]): ChangeArea[] {
  const found = new Set<ChangeArea>();
  for (const path of paths) {
    const { area } = classifyPath(path);
    if (area !== 'otros') found.add(area);
  }
  return CHANGE_AREAS.filter((area) => found.has(area));
}

/** Extrae las historias (HU-NNN) citadas en mensajes de commit: únicas y ordenadas por número. */
export function extractStoryIds(commitMessages: readonly string[]): string[] {
  const ids = new Map<number, string>();
  for (const message of commitMessages) {
    for (const match of message.matchAll(/\bHU-(\d+)\b/gi)) {
      const value = Number(match[1] ?? '');
      if (Number.isSafeInteger(value) && value > 0) ids.set(value, `HU-${value}`);
    }
  }
  return [...ids.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
}

export const PUBLICATION_VERDICTS = ['ok', 'pendiente', 'divergente'] as const;

export type PublicationVerdict = (typeof PUBLICATION_VERDICTS)[number];

export interface PublicationFacts {
  /** El commit está contenido en la rama main local. */
  readonly integratedInMain: boolean;
  /** El commit está contenido en origin/main (última referencia conocida). */
  readonly publishedToRemote: boolean;
  /** Existe una referencia origin/main conocida. */
  readonly remoteTracked: boolean;
  /** main local y origin/main tienen cada una commits que la otra no tiene. */
  readonly mainDivergedFromRemote: boolean;
}

export interface PublicationEvaluation {
  readonly verdict: PublicationVerdict;
  readonly detail: string;
}

/** Decide el veredicto del vigía a partir de hechos ya obtenidos. */
export function evaluatePublication(facts: PublicationFacts): PublicationEvaluation {
  if (facts.integratedInMain && facts.publishedToRemote) {
    return { verdict: 'ok', detail: 'Integrado en main y publicado en origin/main.' };
  }
  if (facts.publishedToRemote && !facts.integratedInMain) {
    return {
      verdict: 'divergente',
      detail: 'El commit está en origin/main pero no en la rama main local.'
    };
  }
  if (facts.integratedInMain && facts.mainDivergedFromRemote) {
    return {
      verdict: 'divergente',
      detail: 'main local y origin/main han divergido; hay que resolverlo manualmente.'
    };
  }
  if (!facts.integratedInMain) {
    return { verdict: 'pendiente', detail: 'El commit aún no está integrado en main.' };
  }
  if (!facts.remoteTracked) {
    return {
      verdict: 'pendiente',
      detail: 'No hay referencia origin/main conocida: no se puede confirmar la publicación.'
    };
  }
  return {
    verdict: 'pendiente',
    detail: 'Integrado en main, pendiente de publicar en origin/main.'
  };
}

/** Rol de vigilancia: determinista, solo lectura, sin modelos, sin red y sin coste. */
export const PUBLICATION_WATCHER_ROLE = {
  name: 'Vigía de publicación',
  description:
    'Tras cada aplicación o publicación verifica que el commit esté integrado en main y publicado en origin, y registra el veredicto en la actividad.',
  permissions: ['leer_git_local', 'registrar_actividad'],
  usesModels: false,
  usesNetwork: false
} as const;
