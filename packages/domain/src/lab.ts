/**
 * Portal IA 4 · Laboratorio de análisis de artefactos (ingeniería inversa defensiva).
 *
 * Usa REA («Reverse Engineer Anything», github.com/morluto/rea, MIT) como herramienta externa AISLADA: versión fijada,
 * en su propio contenedor, sin red, con el artefacto montado en solo lectura. Solo análisis ESTÁTICO: nada de lo que
 * se analiza se ejecuta. Lo que REA devuelve es texto NO fiable (lo produce el análisis de un archivo ajeno) y se
 * trata como dato, nunca como instrucciones.
 */
export const REA_PIN = {
  package: 'rea-agents', version: '6.9.0',
  integrity: 'sha512-KqDn1UR5BMqHoQ3MGAnPuWiSKwgdFaz1L/uUNgrKt+1W8kPtgYP8AWEOXIF1lDIOBVyPuYIIst2iamo1Wf3r8g==',
  commit: 'd74549e495c58eb4a560279fd9f05508401ea0a0', releasedAt: '2026-11-12', reviewedAt: '2026-11-14',
  upstream: 'https://github.com/morluto/rea', image: 'portal-ia-rea:6.9.0', license: 'MIT',
  /** Días que debe llevar publicada una versión para proponer adoptarla (nunca se adopta sola). */
  cooldownDays: 7
} as const;

export type LabAnalysisId = 'exposure' | 'hardening' | 'inventory';
export interface LabAnalysisDef { id: LabAnalysisId; label: string; question: string; accepts: string; command: string; needsFile?: boolean }
/** Lista CERRADA de análisis: solo órdenes estáticas de REA, con argumentos fijos. Nada que ejecute o se conecte. */
export const LAB_ANALYSES: LabAnalysisDef[] = [
  { id: 'exposure', label: 'Qué deja ver lo que publicas', question: '¿Qué puede recuperar un tercero de este paquete: código fuente, credenciales, rutas internas?', accepts: 'La carpeta que publicas de una aplicación, comprimida en .zip, o el programa instalable', command: 'audit-release-exposure' },
  { id: 'hardening', label: 'Protecciones de un ejecutable', question: '¿Este programa lleva activadas las protecciones habituales contra ataques?', accepts: 'Un programa o biblioteca de Windows, Linux o macOS (.exe, .dll…)', command: 'inspect-binary-hardening', needsFile: true },
  { id: 'inventory', label: 'Qué es y qué contiene', question: '¿Qué es este archivo, con qué está hecho y qué lleva dentro?', accepts: 'Cualquier aplicación o programa (o su carpeta comprimida en .zip)', command: 'inspect-artifact' }
];

export type LabSeverity = 'high' | 'medium' | 'low' | null;
/** exposed = confirmado en el artefacto; unknown = no se pudo determinar; el resto no son hallazgos. */
export type LabCheckStatus = 'exposed' | 'unknown' | 'not_observed' | 'not_applicable' | 'not_assessed' | 'ok';
export interface LabFinding {
  id: string; status: LabCheckStatus; severity: LabSeverity;
  /** observed = visto directamente; inferred = deducido (no confirmado). */
  confidence: 'observed' | 'inferred' | null;
  observation: string; locations: string[]; remediation: string | null;
}
export type LabReportStatus = 'running' | 'done' | 'failed';
export interface LabReport {
  id: string; analysis: LabAnalysisId; status: LabReportStatus; error: string | null;
  target: { name: string; bytes: number; sha256: string; kind: 'file' | 'folder'; files: number };
  /** Lo que el propietario declaró: por qué puede examinar este artefacto. Sin esto no se analiza nada. */
  authorization: { statement: string; at: string };
  tool: { name: 'rea'; version: string; image: string; network: 'none' };
  findings: LabFinding[];
  /** Lo que la herramienta dice que NO establece el informe (límites declarados). */
  limitations: string[];
  summary: { confirmed: number; high: number; unknown: number; clean: number };
  createdAt: string; finishedAt: string | null;
}

export const LAB_LIMITS = { maxUploadBytes: 300 * 1024 * 1024, maxEntries: 5000, maxEntryBytes: 200 * 1024 * 1024, maxExpandedBytes: 600 * 1024 * 1024, maxRatio: 200, timeoutSec: 300, minStatement: 20 } as const;

const STATUSES = new Set<LabCheckStatus>(['exposed', 'unknown', 'not_observed', 'not_applicable', 'not_assessed', 'ok']);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, max);
/** Las rutas del contenedor (/target/…) se muestran relativas al artefacto. */
const rel = (p: string) => p.replace(/^\/target\/?/, '') || '(raíz del artefacto)';

/**
 * De la salida JSON de REA a hallazgos. La salida es DATO NO FIABLE: se acota, se le quitan caracteres de control y solo
 * se leen los campos conocidos. Una salida que no se entiende da un informe sin hallazgos y lo dice.
 */
export function parseReaOutput(raw: unknown): { findings: LabFinding[]; limitations: string[]; recognized: boolean } {
  const j = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const checks = Array.isArray(j.normalized_result?.checks) ? j.normalized_result.checks.slice(0, 200) : null;
  const limitations = (Array.isArray(j.limitations) ? j.limitations : []).slice(0, 10).map((l: unknown) => text(l, 400)).filter(Boolean);
  if (!checks) {
    // Análisis sin lista de comprobaciones (inventario, protecciones): un único resultado descriptivo.
    const nr = j.normalized_result;
    if (!nr || typeof nr !== 'object') return { findings: [], limitations, recognized: false };
    return { findings: [{ id: text(j.operation, 80) || 'resultado', status: 'ok', severity: null, confidence: 'observed', observation: text(nr, 6000), locations: [], remediation: null }], limitations, recognized: true };
  }
  const findings: LabFinding[] = checks.map((c: any): LabFinding => {
    const status: LabCheckStatus = STATUSES.has(c?.status) ? c.status : 'unknown';
    const obs = c?.observation ?? {};
    const samples = Array.isArray(obs.samples) ? obs.samples.slice(0, 5).map((s: unknown) => rel(text(s, 300))) : [];
    const counts = obs.counts && typeof obs.counts === 'object' ? Object.entries(obs.counts).filter(([, v]) => typeof v === 'number' && v > 0).map(([k, v]) => `${text(k, 40)}: ${v}`).join(', ') : '';
    return {
      id: text(c?.id, 80) || 'comprobación', status, severity: c?.severity === 'high' || c?.severity === 'medium' || c?.severity === 'low' ? c.severity : null,
      confidence: c?.confidence === 'observed' || c?.confidence === 'inferred' ? c.confidence : null,
      observation: [counts, ...samples].filter(Boolean).join(' · ').slice(0, 1200),
      locations: (Array.isArray(c?.locations) ? c.locations : []).slice(0, 8).map((l: any) => rel(text(l?.path ?? l, 300))).filter(Boolean),
      remediation: c?.remediation ? text(c.remediation, 600) : null
    };
  });
  return { findings, limitations, recognized: true };
}

export function labSummary(findings: LabFinding[]): LabReport['summary'] {
  const confirmed = findings.filter(f => f.status === 'exposed');
  return { confirmed: confirmed.length, high: confirmed.filter(f => f.severity === 'high').length, unknown: findings.filter(f => f.status === 'unknown').length, clean: findings.filter(f => f.status === 'not_observed' || f.status === 'ok').length };
}

export interface LabComparison { fixed: string[]; stillExposed: string[]; newlyExposed: string[]; sameTarget: boolean }
/** Verificar una corrección: qué hallazgos confirmados del informe anterior ya no están en el nuevo. */
export function compareLabReports(before: Pick<LabReport, 'findings' | 'target'>, after: Pick<LabReport, 'findings' | 'target'>): LabComparison {
  const exp = (r: Pick<LabReport, 'findings'>) => new Set(r.findings.filter(f => f.status === 'exposed').map(f => f.id));
  const a = exp(before), b = exp(after);
  return { fixed: [...a].filter(x => !b.has(x)), stillExposed: [...a].filter(x => b.has(x)), newlyExposed: [...b].filter(x => !a.has(x)), sameTarget: before.target.sha256 === after.target.sha256 };
}

/** Nombres llanos de las comprobaciones conocidas (las demás se muestran con su identificador). */
export const LAB_CHECK_LABELS: Record<string, string> = {
  'javascript.source_map_sources': 'Los mapas de código incluyen el código fuente original',
  'javascript.source_maps': 'Se publican mapas de código junto a la aplicación',
  'text.credential_markers': 'Hay marcas de credenciales o claves en el texto',
  'packaging.extractable_payload': 'El paquete se puede desempaquetar',
  'native.debug_companions': 'Se publican archivos de depuración',
  'native.pdb_path': 'El ejecutable revela rutas del equipo donde se compiló',
  'native.hardening': 'Protecciones del ejecutable',
  'go.build_paths': 'El binario Go revela rutas de compilación',
  'rust.dependency_metadata': 'El binario Rust revela sus dependencias',
  'electron.run_as_node': 'Electron: se puede ejecutar como Node',
  'electron.asar_integrity': 'Electron: integridad del paquete ASAR',
  'electron.only_load_from_asar': 'Electron: solo carga desde ASAR',
  'electron.node_cli_inspect': 'Electron: admite depuración por línea de órdenes',
  'macho.hardened_runtime': 'macOS: entorno de ejecución reforzado',
  'android.manifest': 'Android: manifiesto de la aplicación'
};

/** Cómo corregir cada hallazgo conocido, en llano (si no hay, se muestra el texto de la herramienta). */
export const LAB_CHECK_FIXES: Record<string, string> = {
  'javascript.source_map_sources': 'Publica la aplicación sin el código fuente dentro de los mapas: quita los archivos .map de lo que publicas, o genera los mapas sin «sourcesContent».',
  'javascript.source_maps': 'No publiques los mapas de código (.map) junto a la aplicación.',
  'text.credential_markers': 'Quita la clave del código que se publica y cámbiala por una nueva (la que se vio ya no es secreta). Las claves van en el servidor o en variables de entorno, nunca en el paquete.',
  'native.debug_companions': 'No publiques los archivos de depuración (.pdb, .dSYM, .debug) junto al programa.',
  'native.pdb_path': 'Compila la versión de publicación sin la ruta del archivo de depuración.',
  'packaging.extractable_payload': 'Da por hecho que cualquiera puede desempaquetarlo: no metas dentro nada que deba ser secreto.'
};

export interface ReaUpdateCheck {
  checkedAt: string; pinned: string; latest: string | null; latestPublishedAt: string | null; ageDays: number | null;
  integrity: string | null; maintainers: string[]; engines: string | null;
  /** up_to_date · wait (aún no cumple el plazo de espera) · review (lista para que la revises) · unavailable. */
  verdict: 'up_to_date' | 'wait' | 'review' | 'unavailable'; notes: string[];
}
