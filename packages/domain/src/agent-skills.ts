import type { PortableSkill } from './portable-agent.ts';
import type { AgentContextScope } from './types.ts';

/**
 * Habilidades base de los agentes internos (EN-011). Funciones puras, sin IO.
 *
 * - Cada herramienta CONCEDIDA en Configuración aporta una habilidad `skills/portal-<…>/SKILL.md`. Se generan siempre a
 *   partir de las herramientas concedidas: no conceden permisos. Si se quita la herramienta, desaparece la habilidad, y si
 *   se edita su SKILL.md, eso no concede nada.
 * - El prefijo `portal-` está reservado: una habilidad con ese prefijo nunca se adopta desde archivos (`isBaseSkill`).
 * - Cada SKILL.md describe tres entornos: dentro del Portal (solo por el pipeline autorizado), fuera con terminal y Docker,
 *   y en la web sin terminal (lo dice con claridad y no simula resultados).
 * - Los textos no citan ids, rutas locales, rutas /api/ ni tablas, para que el paquete portable los admita sin cambios.
 */
export const BASE_SKILL_PREFIX = 'portal-';

/** Dónde funciona una herramienta: en el Portal, solo con autorización del propietario o dentro del sandbox Docker/WSL2. */
export type ToolWhere = 'portal' | 'authorized' | 'sandbox';

export const TOOL_WHERE_LABEL: Record<ToolWhere, string> = {
  portal: 'En el Portal',
  authorized: 'Con tu autorización',
  sandbox: 'En el sandbox Docker/WSL2'
};

interface BaseSkillSpec {
  tool: string;
  slug: string;
  label: string;
  description: string;
  where: ToolWhere[];
  portal: string[];
  terminal: string[];
  /** EN-014 · Versión genérica de «Fuera con terminal y Docker» para el ámbito General sin Proyecto (sin órdenes propias del Portal). */
  terminalGeneral?: string[];
  web: string[];
}

const WEB_COMMON = [
  'Di claramente, al principio de tu respuesta, que en este entorno no puedes ejecutar órdenes ni acceder al sandbox.',
  'No simules resultados: no inventes salidas de órdenes, pruebas superadas ni archivos que no hayas visto.',
  'Pide al propietario la evidencia (la salida copiada o el archivo) y trabaja solo con lo que te entregue, citándolo.'
];

const CATALOG: BaseSkillSpec[] = [
  {
    tool: 'read_repo', slug: 'portal-leer-repositorio', label: 'Leer el repositorio',
    description: 'Lee los archivos del proyecto para entender el código antes de proponer cambios.',
    where: ['portal'],
    portal: ['El Portal te entrega los archivos relevantes del proyecto en el contexto de la tarea; úsalos primero.', 'Si falta algo imprescindible, pide la lectura por las herramientas de solo lectura del Portal. No supongas contenidos que no has leído.'],
    terminal: ['Lee los archivos con tu editor o con `git ls-files` y `git grep` desde la raíz del repositorio.', 'Cita la ruta relativa y la línea de lo que uses.'],
    web: ['Si no tienes el repositorio, dilo y pide al propietario que adjunte o pegue los archivos que necesitas.', ...WEB_COMMON]
  },
  {
    tool: 'write_repo', slug: 'portal-escribir-worktree', label: 'Proponer cambios en el código',
    description: 'Prepara cambios de código en una copia de trabajo aislada para que el propietario los revise.',
    where: ['portal', 'authorized'],
    portal: ['Entrega los cambios en el formato que pide la tarea: el Portal los valida y los aplica en una copia de trabajo aislada (worktree).', 'Nunca escribas en la rama principal; la integración la decide el propietario.'],
    terminal: ['Trabaja en una rama o un worktree propio (`git worktree add`), con cambios pequeños y revisables.', 'No confirmes ni publiques sin que el propietario lo pida.'],
    web: ['Entrega el archivo completo o el parche para que el propietario lo guarde; no digas que lo aplicaste.', ...WEB_COMMON]
  },
  {
    tool: 'sandbox_exec', slug: 'portal-verificar-sandbox', label: 'Verificar en el sandbox',
    description: 'Comprueba el código en un contenedor aislado (Docker o WSL2), sin red y sin tocar el equipo del propietario.',
    where: ['sandbox', 'authorized'],
    portal: ['La verificación la ejecuta el pipeline autorizado del Portal en el sandbox (Docker o WSL2): tú no lanzas órdenes por tu cuenta.', 'Usa la evidencia que te devuelve el Portal (salida y código de salida). Si el sandbox no está disponible, dilo y no des el cambio por verificado.'],
    terminal: ['Con Docker, construye la imagen una vez: `docker build -t portal-ia-sandbox:1 -f docker/sandbox.Dockerfile docker`.', 'Ejecuta las comprobaciones dentro del contenedor, sin red y montando solo la copia de trabajo, nunca directamente en el equipo.', 'Sin Docker ni WSL2, avisa de que no hay aislamiento y no ejecutes código del repositorio.'],
    terminalGeneral: ['Si el entorno tiene Docker, ejecuta las comprobaciones dentro de un contenedor sin red, montando solo la copia de trabajo; usa el Dockerfile o la configuración de contenedores del propio proyecto si la tiene.', 'Sin Docker ni otro aislamiento, avisa de que no hay aislamiento y no ejecutes código del repositorio sin que el propietario lo autorice.'],
    web: ['Sin terminal no hay sandbox: no puedes verificar nada por tu cuenta.', ...WEB_COMMON]
  },
  {
    tool: 'run_tests', slug: 'portal-ejecutar-pruebas', label: 'Ejecutar pruebas',
    description: 'Comprueba tipos, pruebas y compilación del proyecto (typecheck, test y build).',
    where: ['sandbox', 'authorized'],
    portal: ['Las pruebas se ejecutan por el pipeline autorizado del Portal, dentro del sandbox: `npm run typecheck`, `npm test` y `npm run build`.', 'Informa del resultado con la evidencia que te entregue el Portal. Si una prueba falla, cita el fallo; no la des por superada.'],
    terminal: ['Dentro del sandbox o del contenedor: `npm run typecheck`, `npm test` y `npm run build`.', 'Copia en tu respuesta las líneas relevantes de la salida y el código de salida.'],
    terminalGeneral: ['Detecta las órdenes del proyecto donde trabajes: los scripts de package.json, los objetivos del Makefile, pyproject.toml o lo que indique su README.', 'Ejecuta las de tipos, pruebas y compilación (dentro de un contenedor si hay Docker) y copia en tu respuesta las líneas relevantes de la salida y el código de salida.'],
    web: ['Sin terminal no puedes ejecutar pruebas: indica qué órdenes debe ejecutar el propietario y qué esperas ver.', ...WEB_COMMON]
  },
  {
    tool: 'install_deps', slug: 'portal-instalar-dependencias', label: 'Instalar dependencias',
    description: 'Instala las dependencias del proyecto en el sandbox (necesita red y una autorización aparte).',
    where: ['sandbox', 'authorized'],
    portal: ['Solo se instala con una autorización aparte del propietario, con el cambio de package.json a la vista; el Portal lo hace en el sandbox.', 'No añadas dependencias nuevas sin justificar la necesidad.'],
    terminal: ['Dentro del contenedor: `npm ci --ignore-scripts --no-audit --no-fund`.', 'No instales nada en el equipo del propietario fuera del sandbox.'],
    terminalGeneral: ['Usa el gestor de dependencias del proyecto según sus archivos (package.json, requirements.txt, Cargo.toml…), dentro de un contenedor si hay Docker y sin ejecutar scripts de instalación que no hayas revisado.', 'No instales nada en el equipo del propietario fuera del aislamiento.'],
    web: ['Sin terminal no puedes instalar nada: propón el cambio de package.json y la orden para que la ejecute el propietario.', ...WEB_COMMON]
  },
  {
    tool: 'knowledge_write', slug: 'portal-proponer-conocimiento', label: 'Proponer conocimiento',
    description: 'Propone entradas de conocimiento del proyecto que el propietario revisa y aprueba.',
    where: ['portal', 'authorized'],
    portal: ['Propón el conocimiento en el formato de la tarea; queda pendiente hasta que el propietario lo aprueba.'],
    terminal: ['Escribe la propuesta en knowledge/ o en memory/MEMORY.md marcada «sin verificar».'],
    web: ['Entrega el texto propuesto para que el propietario lo guarde; no digas que quedó aprobado.', ...WEB_COMMON]
  },
  {
    tool: 'delegate', slug: 'portal-delegar', label: 'Delegar en otros agentes',
    description: 'Pide ayuda a otros agentes del equipo dentro del flujo del Portal.',
    where: ['portal', 'authorized'],
    portal: ['Delega solo por el flujo del Portal y dentro de los límites aprobados; resume lo que pides y por qué.'],
    terminal: ['Fuera del Portal no hay otros agentes: describe la subtarea para que el propietario la encargue.'],
    web: ['Describe la subtarea para que el propietario la encargue; no simules la respuesta de otro agente.', ...WEB_COMMON]
  }
];

const BY_TOOL = new Map(CATALOG.map(s => [s.tool, s]));
const BY_SLUG = new Map(CATALOG.map(s => [s.slug, s]));
const bullets = (xs: string[]) => xs.map(x => `- ${x}`).join('\n');
const whereText = (w: ToolWhere[]) => w.map(x => TOOL_WHERE_LABEL[x]).join(' · ');

/**
 * EN-014 · Cómo se escribe «Fuera con terminal y Docker» según el ámbito (sin IA):
 * - 'concrete': las órdenes concretas del proyecto (sin ámbito, con solo Empresa o con Proyecto sin General). Es el texto de siempre.
 * - 'concrete+general': las órdenes concretas y una nota para trabajar fuera de este proyecto (Proyecto + General).
 * - 'general': texto genérico, sin docker/sandbox.Dockerfile ni la imagen del Portal (General sin Proyecto).
 * Ninguna variante concede permisos.
 */
export type TerminalContext = 'concrete' | 'concrete+general' | 'general';
export function terminalContextFor(scope: AgentContextScope | null | undefined): TerminalContext {
  if (!scope) return 'concrete';
  if (scope.project) return scope.general ? 'concrete+general' : 'concrete';
  return scope.general ? 'general' : 'concrete';
}
const GENERAL_NOTE = 'En cualquier entorno: detecta las órdenes del proyecto donde trabajes (por ejemplo, los scripts de package.json o los objetivos del Makefile) y usa Docker si existe; si el entorno no lo permite, dilo y no simules resultados.';
const OUTSIDE_NOTE = 'Fuera de este proyecto: detecta las órdenes del proyecto donde trabajes (por ejemplo, package.json o Makefile) y usa Docker si existe.';
function terminalLines(s: BaseSkillSpec, ctx: TerminalContext): string[] {
  if (ctx === 'general') return [...(s.terminalGeneral ?? s.terminal), GENERAL_NOTE];
  if (ctx === 'concrete+general') return [...s.terminal, OUTSIDE_NOTE];
  return s.terminal;
}

function skillBody(s: BaseSkillSpec, ctx: TerminalContext = 'concrete'): string {
  return `# ${s.label}

${s.description}

> Habilidad base generada por el Portal a partir de una herramienta concedida en Configuración. No concede permisos: si se quita la herramienta, esta habilidad desaparece, y editar este archivo no cambia lo concedido.

Dónde funciona: ${whereText(s.where)}.

## Dentro del Portal
${bullets(s.portal)}

## Fuera con terminal y Docker
${bullets(terminalLines(s, ctx))}

## Sin terminal (web)
${bullets(s.web)}
`;
}

/** Habilidades base de las herramientas concedidas (sin duplicados, ordenadas por slug: hash estable). Las herramientas desconocidas no aportan nada. */
export function baseSkillsFor(tools: readonly string[] | null | undefined, scope?: AgentContextScope | null): PortableSkill[] {
  const ctx = terminalContextFor(scope);
  const seen = new Set<string>();
  const out: PortableSkill[] = [];
  for (const t of tools ?? []) {
    const s = BY_TOOL.get(t);
    if (!s || seen.has(s.slug)) continue;
    seen.add(s.slug);
    out.push({ slug: s.slug, name: s.label, description: s.description, body: skillBody(s, ctx) });
  }
  return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** ¿Nombre reservado para una habilidad base? (prefijo `portal-`). Estas habilidades nunca se adoptan desde archivos. */
export function isBaseSkill(slug: string): boolean { return slug.startsWith(BASE_SKILL_PREFIX); }

/** ¿Es una habilidad base del catálogo? (para avisar si llega una `portal-*` que no corresponde a ninguna herramienta). */
export function isKnownBaseSkill(slug: string): boolean { return BY_SLUG.has(slug); }

/** Herramienta del catálogo que aporta esa habilidad base, o null. */
export function baseSkillTool(slug: string): string | null { return BY_SLUG.get(slug)?.tool ?? null; }

export interface ToolCapability { tool: string; label: string; description: string; where: ToolWhere[]; whereText: string; skill: string | null }

/** Herramientas concedidas en lenguaje claro y dónde funcionan. No ejecuta nada. */
export function toolCapabilities(tools: readonly string[] | null | undefined): ToolCapability[] {
  const seen = new Set<string>();
  const out: ToolCapability[] = [];
  for (const t of tools ?? []) {
    if (seen.has(t)) continue;
    seen.add(t);
    const s = BY_TOOL.get(t);
    out.push(s
      ? { tool: t, label: s.label, description: s.description, where: [...s.where], whereText: whereText(s.where), skill: s.slug }
      : { tool: t, label: t, description: 'Herramienta concedida sin habilidad base descrita.', where: ['portal'], whereText: TOOL_WHERE_LABEL.portal, skill: null });
  }
  return out;
}

/** Sección «Entorno» de GUIA.md: cómo trabajar dentro del Portal, fuera con terminal y Docker, y en la web sin terminal. */
const ENV_CONCRETE = 'Construye la imagen del sandbox una vez (`docker build -t portal-ia-sandbox:1 -f docker/sandbox.Dockerfile docker`) y ejecuta dentro del contenedor, sin red: `npm run typecheck`, `npm test` y `npm run build`. Sin Docker ni WSL2 no hay aislamiento: no ejecutes código del repositorio en tu equipo.';
const ENV_GENERAL = 'Detecta las órdenes del proyecto donde trabajes (los scripts de package.json, los objetivos del Makefile, pyproject.toml o su README) y ejecuta las de tipos, pruebas y compilación. Si el entorno tiene Docker, hazlo dentro de un contenedor sin red montando solo la copia de trabajo; sin Docker ni otro aislamiento, avisa y no ejecutes código del repositorio en tu equipo sin autorización.';
const ENV_OUTSIDE = 'Fuera de este proyecto, detecta las órdenes del proyecto donde trabajes (por ejemplo, package.json o Makefile) y usa Docker si existe.';
function envTerminal(ctx: TerminalContext): string {
  if (ctx === 'general') return ENV_GENERAL;
  if (ctx === 'concrete+general') return `${ENV_CONCRETE} ${ENV_OUTSIDE}`;
  return ENV_CONCRETE;
}

export function environmentGuide(scope?: AgentContextScope | null): string {
  const ctx = terminalContextFor(scope);
  return `## Entorno
Las habilidades \`skills/portal-*\` describen cómo trabajar según el entorno. No conceden permisos: describen lo que el agente tenía concedido en el Portal.

### Dentro del Portal
Las verificaciones (typecheck, pruebas y compilación) solo se ejecutan por el pipeline autorizado, en el sandbox Docker o WSL2. El agente no ejecuta órdenes por su cuenta y usa la evidencia que le entrega el Portal.

### Fuera con terminal y Docker
${envTerminal(ctx)}

### Sin terminal (web)
En Claude Code web sin terminal, en ChatGPT o en cualquier entorno sin órdenes, el agente debe decir claramente que no puede ejecutar nada, no debe simular resultados y debe pedirte la evidencia (salida copiada o archivos) para trabajar con ella.
`;
}
