/**
 * HU-171 · Índice de Conocimiento: lógica pura (sin React ni IO) para agrupar los documentos con el mismo título,
 * deducir su tipo por el prefijo del título y filtrar por texto, autor y tipo. Sirve igual para cualquier empresa.
 * Supuestos: el autor y el tipo se filtran sobre la versión más reciente; solo se agrupan títulos idénticos tras
 * normalizar mayúsculas y espacios.
 */
export interface KnowledgeDocLike {
  id: string;
  title: string;
  body: string;
  authorAgentName: string | null;
  version: number;
  createdAt: string;
}

export type KnowledgeKind = 'encargo' | 'propuesta' | 'revision' | 'historias' | 'analisis' | 'evaluacion' | 'linea-base' | 'plan-historia' | 'otro';

export const KIND_LABELS: Record<KnowledgeKind, string> = {
  encargo: 'Encargo',
  propuesta: 'Propuesta',
  revision: 'Revisión del equipo',
  historias: 'Historias propuestas',
  analisis: 'Análisis',
  evaluacion: 'Evaluación organizativa',
  'linea-base': 'Línea base',
  'plan-historia': 'Plan de historia',
  otro: 'Otro'
};

const KIND_ORDER = Object.keys(KIND_LABELS) as KnowledgeKind[];

/** Minúsculas y sin acentos (NFD), para comparar texto. */
export const fold = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Clave de agrupación: sin espacios en los extremos, en minúsculas y con los espacios colapsados. */
export const normalizeTitle = (title: string): string => title.trim().toLowerCase().replace(/\s+/g, ' ');

const KIND_RULES: [RegExp, KnowledgeKind][] = [
  [/^encargo\b/, 'encargo'],
  [/^propuesta\b/, 'propuesta'],
  [/^revision del equipo\b/, 'revision'],
  [/^historias propuestas\b/, 'historias'],
  [/^analisis\b/, 'analisis'],
  [/^evaluacion organizativa\b/, 'evaluacion'],
  [/^linea base\b/, 'linea-base'],
  [/^hu-\d+\s*·\s*plan\b/, 'plan-historia']
];

export function docKind(title: string): KnowledgeKind {
  const t = fold(title.trim()).replace(/\s+/g, ' ');
  for (const [re, kind] of KIND_RULES) if (re.test(t)) return kind;
  return 'otro';
}

export const authorOf = (d: Pick<KnowledgeDocLike, 'authorAgentName'>): string => d.authorAgentName ?? 'sistema';

export interface DocGroup<T extends KnowledgeDocLike = KnowledgeDocLike> {
  key: string;
  latest: T;
  older: T[];
  kind: KnowledgeKind;
  author: string;
}

const newestFirst = (a: KnowledgeDocLike, b: KnowledgeDocLike): number =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : (b.version ?? 0) - (a.version ?? 0);

/** Un grupo por título normalizado; dentro, la más reciente primero. Los grupos van del más reciente al más antiguo. */
export function groupByTitle<T extends KnowledgeDocLike>(docs: T[]): DocGroup<T>[] {
  const byKey = new Map<string, T[]>();
  for (const d of docs) {
    const key = normalizeTitle(d.title);
    const list = byKey.get(key);
    if (list) list.push(d); else byKey.set(key, [d]);
  }
  const groups: DocGroup<T>[] = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort(newestFirst);
    const latest = sorted[0]!;
    groups.push({ key, latest, older: sorted.slice(1), kind: docKind(latest.title), author: authorOf(latest) });
  }
  return groups.sort((a, b) => newestFirst(a.latest, b.latest));
}

export interface KnowledgeFilter { q?: string; author?: string; kind?: KnowledgeKind | '' }

/** Texto: título o cuerpo de cualquier versión del grupo (sin mayúsculas ni acentos). Autor y tipo: versión más reciente. */
export function filterGroups<T extends KnowledgeDocLike>(groups: DocGroup<T>[], f: KnowledgeFilter): DocGroup<T>[] {
  const q = fold((f.q ?? '').trim());
  return groups.filter(g => {
    if (f.author && g.author !== f.author) return false;
    if (f.kind && g.kind !== f.kind) return false;
    if (!q) return true;
    return [g.latest, ...g.older].some(d => fold(d.title).includes(q) || fold(d.body).includes(q));
  });
}

/** Autores presentes (solo los de la versión más reciente), ordenados alfabéticamente. */
export function authorsOf(groups: DocGroup[]): string[] {
  return [...new Set(groups.map(g => g.author))].sort((a, b) => a.localeCompare(b, 'es'));
}

/** Tipos presentes, en el orden del catálogo. */
export function kindsOf(groups: DocGroup[]): KnowledgeKind[] {
  const present = new Set(groups.map(g => g.kind));
  return KIND_ORDER.filter(k => present.has(k));
}

/** Grupo que contiene el documento (sea la versión más reciente o una anterior). */
export function groupOf<T extends KnowledgeDocLike>(groups: DocGroup<T>[], id: string | null): DocGroup<T> | null {
  if (!id) return null;
  return groups.find(g => g.latest.id === id || g.older.some(o => o.id === id)) ?? null;
}
