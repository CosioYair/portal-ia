import fs from 'node:fs';
import path from 'node:path';
import {
  PORTABLE_LOCK, PORTABLE_MANIFEST, PORTABLE_SELFCHECK, PORTABLE_TOOLS_DIR, SELFCHECK_PY, buildPortableManifest, importNameOf, normalizeText, parseRequirementNames,
  requirementsLock, type PortableFiles, type PortableManifest, type PortableRequirement
} from '@portal-ia/domain';

/**
 * Portal IA 3 · Lo que convierte el paquete en algo EJECUTABLE fuera del Portal (para cualquier agente con programas):
 * manifiesto legible por máquina, versiones fijadas de sus dependencias, comprobación de entorno y, si el Portal valida
 * su trabajo con una herramienta propia, esa misma herramienta. Sin IA. No lee ni copia documentos del propietario.
 */
export interface EnrichInput {
  agentId: string; name: string; kind: 'internal' | 'external'; exportedAt: string; bundleId: string;
  /** Carpeta original del agente externo (para leer SOLO las versiones de `.dependencias`). */
  sourceRoot?: string | null;
  grants?: { runScripts: boolean; writeDocuments: boolean } | null;
}

const normPip = (n: string) => n.trim().toLowerCase().replace(/[_.]+/g, '-');

/** Versiones de lo que viaja instalado junto al agente (`.dependencias/<paquete>-<versión>.dist-info`). Solo nombres de carpeta. */
export function installedWithAgent(sourceRoot: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!sourceRoot) return out;
  const dir = path.join(sourceRoot, '.dependencias');
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) { const m = /^(.+?)-(\d[^-]*)\.dist-info$/.exec(n); if (m) out[normPip(m[1]!)] = m[2]!; }
  return out;
}

export interface EnrichResult { files: PortableFiles; manifest: PortableManifest; warnings: string[] }

/**
 * Añade al paquete el manifiesto y, si trae programas, el candado de versiones, la comprobación de entorno y la
 * herramienta de validación. `probe` consulta las versiones instaladas en el Python del Portal (inyectable en pruebas).
 */
export async function enrichBundle(bundle: PortableFiles, i: EnrichInput, deps: {
  probe: (names: string[]) => Promise<{ python: string | null; versions: Record<string, string | null> }>;
  validationTool: () => { name: string; source: string } | null;
}): Promise<EnrichResult> {
  const out: PortableFiles = { ...bundle };
  const warnings: string[] = [];
  const hasScripts = Object.keys(out).some(p => /^skills\/[^/]+\/scripts\/[^/]+\.py$/.test(p));
  const reqNames: string[] = []; const pinned: Record<string, string> = {};
  for (const [p, c] of Object.entries(out)) if (/^skills\/[^/]+\/scripts\/requirements[^/]*\.txt$/i.test(p)) {
    for (const n of parseRequirementNames(c)) if (!reqNames.some(x => normPip(x) === normPip(n))) reqNames.push(n);
    // Lo que el propio agente ya fija (nombre==version) manda: es su declaracion.
    for (const m of c.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([A-Za-z0-9][A-Za-z0-9.!+_-]*)/gm)) pinned[normPip(m[1]!)] ??= m[2]!;
  }
  let requirements: PortableRequirement[] = []; let pythonTested: string | null = null;
  if (hasScripts && reqNames.length) {
    const own = { ...installedWithAgent(i.sourceRoot), ...pinned };
    const missing = reqNames.filter(n => !own[normPip(n)]);
    let probed: Awaited<ReturnType<typeof deps.probe>> = { python: null, versions: {} };
    try { probed = await deps.probe(missing.length ? reqNames : []); } catch { /* sin Python: quedan sin fijar */ }
    pythonTested = probed.python;
    requirements = reqNames.map(n => {
      const v = own[normPip(n)] ?? probed.versions[n] ?? probed.versions[normPip(n)] ?? null;
      return { name: n, import: importNameOf(n), version: v, source: own[normPip(n)] ? 'agente' : v ? 'portal' : 'sin-fijar' } satisfies PortableRequirement;
    });
    const loose = requirements.filter(r => !r.version).map(r => r.name);
    if (loose.length) warnings.push(`No se pudo fijar la versión de: ${loose.join(', ')}. El paquete funciona, pero fuera se instalará la más reciente.`);
  }
  let validation: PortableManifest['validation'] = null;
  if (hasScripts) {
    out[PORTABLE_SELFCHECK] = SELFCHECK_PY;
    if (requirements.length) out[PORTABLE_LOCK] = requirementsLock(requirements);
    const tool = i.grants?.writeDocuments ? deps.validationTool() : null;
    if (tool) {
      const rel = `${PORTABLE_TOOLS_DIR}/${tool.name}`;
      out[rel] = tool.source;
      validation = {
        tool: rel, command: `python ${rel} {entrada} {salida} {carpeta_qa} --informe {informe}`,
        gates: ['texto real editable (sin páginas completas como imagen, sin marcos ni VML)', 'contenido completo (cobertura de palabras ≥ 0,97 en el Word y en su render)', 'mismo número de páginas y ninguna en blanco', 'sin duplicados']
      };
    }
  }
  const limitations: string[] = [];
  if (hasScripts) limitations.push('Los programas necesitan un entorno con Python y permiso para ejecutarlos; en un chat sin ejecución el agente conserva su criterio y su memoria, pero no puede usarlos.');
  if (hasScripts && !validation) limitations.push('El paquete no trae una herramienta de validación: comprueba el resultado con los criterios de sus habilidades.');
  if (i.kind === 'internal') limitations.push('El arnés, el modelo y los permisos no viajan en el paquete: los decide quien lo usa.');
  const manifest = buildPortableManifest({ name: i.name, kind: i.kind, exportedAt: i.exportedAt, bundleId: i.bundleId, files: out, requirements, pythonTested, permissions: i.kind === 'external' ? { runScripts: !!i.grants?.runScripts, writeDocuments: !!i.grants?.writeDocuments } : null, validation, limitations });
  out[PORTABLE_MANIFEST] = `${JSON.stringify(manifest, null, 2)}\n`;
  if (hasScripts && typeof out['GUIA.md'] === 'string') {
    out['GUIA.md'] = normalizeText(`${out['GUIA.md'].trimEnd()}\n\n## Antes de empezar: comprueba el entorno\n\n1. \`python ${PORTABLE_SELFCHECK}\` dice qué hay y qué falta en este equipo. No instala nada.\n${requirements.length ? `2. \`python -m pip install -r ${PORTABLE_LOCK}\` instala las versiones con las que este agente funciona en el Portal.\n` : ''}${validation ? `3. Valida cada resultado con \`${validation.command}\`: es la misma comprobación que usa el Portal.\n` : ''}\nLa descripción completa del paquete (programas, requisitos, permisos y límites) está en \`${PORTABLE_MANIFEST}\`.\n`);
  }
  return { files: Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), manifest, warnings };
}
