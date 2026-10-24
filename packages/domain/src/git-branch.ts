// Reglas puras sobre ramas de git y redacción de credenciales. Sin IO.

const CARACTERES_PROHIBIDOS = '~^:?*[\\';

function tieneCaracterProhibido(name: string): boolean {
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || /\s/.test(char) || CARACTERES_PROHIBIDOS.includes(char)) {
      return true;
    }
  }
  return false;
}

/** Indica si el nombre es una rama de git aceptable (subconjunto conservador de git check-ref-format). */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255 || name === '@') return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) {
    return false;
  }
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  if (tieneCaracterProhibido(name)) return false;
  return name.split('/').every((tramo) => !tramo.startsWith('.') && !tramo.endsWith('.lock'));
}

/** Rama principal sobre la que se crea cada rama de historia. */
export const MAIN_BRANCH = 'main';

const MAX_SLUG_LENGTH = 40;

/** Normaliza un texto libre a un slug: sin tildes, en minúsculas, con guiones y longitud acotada. */
function slugify(text: string, maxLength: number): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/**
 * Deriva el nombre de la rama de una historia con la convención «hu-NNN/descripcion»
 * (por ejemplo, «hu-125/rama-por-cambio»). Devuelve null si el identificador o la
 * descripción no permiten construir un nombre válido.
 */
export function storyBranchName(storyId: string, description: string): string | null {
  const match = /^HU-(\d+)$/i.exec(storyId.trim());
  if (match === null) return null;
  const number = Number(match[1] ?? '');
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const slug = slugify(description, MAX_SLUG_LENGTH);
  if (slug.length === 0) return null;
  const name = `hu-${number}/${slug}`;
  return isValidBranchName(name) ? name : null;
}

/** Prefijo de las ramas que se publican al aplicar los cambios de una historia (HU-128). */
export const STORY_BRANCH_PREFIX = 'historia/';

const MAX_PUBLISH_SLUG_LENGTH = 50;

/**
 * Deriva la rama publicada de una historia: «historia/hu-XXX-slug» (por ejemplo,
 * «historia/hu-128-flujo-git-minimo»). El ID lleva al menos tres dígitos y el slug
 * no tiene tildes, va en minúsculas y está acotado a 50 caracteres.
 * Devuelve null si el identificador o el título no permiten construir un nombre válido.
 */
export function storyPublishBranchName(storyId: string, title: string): string | null {
  const match = /^HU-(\d+)$/i.exec(storyId.trim());
  if (match === null) return null;
  const number = Number(match[1] ?? '');
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const slug = slugify(title, MAX_PUBLISH_SLUG_LENGTH);
  if (slug.length === 0) return null;
  const name = `${STORY_BRANCH_PREFIX}hu-${String(number).padStart(3, '0')}-${slug}`;
  return isValidStoryBranch(name) ? name : null;
}

/** Indica si el nombre tiene la forma «historia/hu-XXX-slug» y es una rama de git válida. */
export function isValidStoryBranch(name: string): boolean {
  return /^historia\/hu-\d{3,}-[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && isValidBranchName(name);
}

export interface StoryBranchBaseFacts {
  /** Rama desde la que se creó (o se va a crear) la rama de la historia. */
  readonly baseBranch: string;
  /** Commits de origin/main que la main local aún no tiene (0 = al día). */
  readonly behindRemoteMain: number;
}

export interface StoryBranchBaseCheck {
  readonly ok: boolean;
  /** Motivo en español (null si la base es correcta). */
  readonly reason: string | null;
}

/** Comprueba que la rama de la historia parte de main y que main está actualizada. */
export function checkStoryBranchBase(facts: StoryBranchBaseFacts): StoryBranchBaseCheck {
  if (facts.baseBranch !== MAIN_BRANCH) {
    return { ok: false, reason: `La rama debe crearse desde ${MAIN_BRANCH}, no desde «${facts.baseBranch}»` };
  }
  if (facts.behindRemoteMain > 0) {
    return {
      ok: false,
      reason: `main local está ${facts.behindRemoteMain} commit(s) por detrás de origin/main: actualízala antes de crear la rama`
    };
  }
  return { ok: true, reason: null };
}

const PATRONES_SECRETOS: ReadonlyArray<readonly [RegExp, string]> = [
  // https://usuario:token@host y https://token@host
  [/(https?:\/\/)[^\s/@]+@/gi, '$1***@'],
  [/\bAuthorization:[^\r\n]*/gi, 'Authorization: ***'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***'],
  [/\bgh[pousr]_[A-Za-z0-9_]+/g, '***'],
  [/\bglpat-[A-Za-z0-9_-]+/g, '***']
];

/** Oculta credenciales habituales en un texto (salida de git, mensajes de error). */
export function redactCredentials(text: string): string {
  return PATRONES_SECRETOS.reduce((acc, [patron, reemplazo]) => acc.replace(patron, reemplazo), text);
}
