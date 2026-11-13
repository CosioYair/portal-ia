import type { PortableFiles } from './portable-agent.ts';

/**
 * Portal IA 3 · Manifiesto del paquete portable y comprobación de entorno.
 *
 * Un paquete «portable» tiene que poder EJECUTARSE fuera del Portal, no solo leerse. Antes el paquete de un agente con
 * programas llevaba un requirements.txt sin versiones, ninguna forma de saber si el entorno servía y ninguna descripción
 * legible por máquina de qué se ejecuta y con qué. Esto vale para cualquier agente: nada aquí es específico de un oficio.
 *
 *  - portable.json: qué es el paquete, qué programas trae y cómo se llaman, qué necesita (Python, módulos con su versión
 *    probada, programas externos), qué permisos usa en el Portal, con qué se valida su trabajo y qué límites tiene.
 *  - herramientas/requirements.lock.txt: las versiones con las que el agente funciona en el Portal (instalación reproducible).
 *  - herramientas/selfcheck.py: lee portable.json y dice, sin instalar nada, qué falta en ESTE entorno.
 */
export const PORTABLE_MANIFEST = 'portable.json';
export const PORTABLE_MANIFEST_SCHEMA = 'portal-ia/portable@1';
export const PORTABLE_TOOLS_DIR = 'herramientas';
export const PORTABLE_LOCK = `${PORTABLE_TOOLS_DIR}/requirements.lock.txt`;
export const PORTABLE_SELFCHECK = `${PORTABLE_TOOLS_DIR}/selfcheck.py`;
/** Rutas que el paquete puede llevar además de la identidad del agente. */
export const isPortableToolPath = (rel: string): boolean => rel === PORTABLE_MANIFEST || /^herramientas\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}\.(py|txt)$/.test(rel);

/** Nombre con el que se importa un paquete de pip cuando no coincide con el del paquete. */
export const PIP_IMPORT_NAME: Record<string, string> = {
  pymupdf: 'fitz', 'python-docx': 'docx', pillow: 'PIL', 'beautifulsoup4': 'bs4', pyyaml: 'yaml', 'opencv-python': 'cv2', 'scikit-learn': 'sklearn', 'python-pptx': 'pptx', 'python-dateutil': 'dateutil'
};
const norm = (n: string) => n.trim().toLowerCase().replace(/[_.]+/g, '-');
export const importNameOf = (pip: string) => PIP_IMPORT_NAME[norm(pip)] ?? norm(pip).replace(/-/g, '_');

/** Nombres de los requisitos de un requirements.txt (sin versión, sin comentarios ni opciones). */
export function parseRequirementNames(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (m && !out.some(x => norm(x) === norm(m[1]!))) out.push(m[1]!);
  }
  return out;
}

export interface PortableRequirement { name: string; import: string; version: string | null; /** De dónde sale la versión: lo instalado con el agente, el Python del Portal, o ninguna (sin fijar). */ source: 'agente' | 'portal' | 'sin-fijar' }
export interface PortableBinary { name: string; label: string; env: string; commands: string[]; required: boolean; why: string }
export interface PortableEntrypoint { skill: string; script: string; summary: string; usage: string | null; proven: boolean }

/** Programas externos conocidos: cómo se detecta su uso en los scripts y dónde suelen estar. */
const KNOWN_BINARIES: { name: string; label: string; env: string; detect: RegExp; commands: string[]; paths: string[] }[] = [
  { name: 'libreoffice', label: 'LibreOffice', env: 'SOFFICE', detect: /\bsoffice\b|libreoffice/i, commands: ['soffice', 'libreoffice'], paths: ['C:\\Program Files\\LibreOffice\\program\\soffice.com', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com', '/usr/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'] },
  { name: 'tesseract', label: 'Tesseract OCR', env: 'TESSERACT', detect: /\btesseract\b/i, commands: ['tesseract'], paths: ['C:\\Program Files\\Tesseract-OCR\\tesseract.exe', '/usr/bin/tesseract', '/opt/homebrew/bin/tesseract'] },
  { name: 'poppler', label: 'Poppler (pdftoppm)', env: 'PDFTOPPM', detect: /\bpdftoppm\b|\bpdftotext\b/i, commands: ['pdftoppm'], paths: ['/usr/bin/pdftoppm', '/opt/homebrew/bin/pdftoppm'] },
  { name: 'ffmpeg', label: 'FFmpeg', env: 'FFMPEG', detect: /\bffmpeg\b/i, commands: ['ffmpeg'], paths: ['/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'] }
];

const SCRIPT_RE = /^skills\/([^/]+)\/scripts\/([^/]+\.py)$/;

/** Primera frase del docstring de un script y su línea «Uso:» (si la tiene). */
function describeScript(source: string): { summary: string; usage: string | null } {
  const doc = /^\s*(?:#[^\n]*\n)*\s*(?:r|u)?("""|''')([\s\S]*?)\1/.exec(source)?.[2] ?? '';
  const first = doc.trim().split('\n')[0]?.trim() ?? '';
  const usage = /^\s*Uso:\s*(.+(?:\n\s{4,}.+)*)/m.exec(doc)?.[1]?.replace(/\s*\n\s+/g, ' ').trim() ?? null;
  return { summary: first.slice(0, 240), usage: usage ? usage.slice(0, 400) : null };
}

export function detectBinaries(files: PortableFiles): PortableBinary[] {
  const scripts = Object.entries(files).filter(([p]) => SCRIPT_RE.test(p));
  const out: PortableBinary[] = [];
  for (const k of KNOWN_BINARIES) {
    const users = scripts.filter(([, c]) => k.detect.test(c)).map(([p]) => p);
    if (users.length) out.push({ name: k.name, label: k.label, env: k.env, commands: k.commands, required: true, why: `Lo usan: ${users.slice(0, 4).join(', ')}` });
  }
  return out;
}

export function listEntrypoints(files: PortableFiles): PortableEntrypoint[] {
  let proven = new Set<string>();
  try { proven = new Set(((JSON.parse(files['PLANES.json'] ?? '{}') as { planes?: { script?: string }[] }).planes ?? []).map(p => String(p.script ?? ''))); } catch { /* sin planes */ }
  const out: PortableEntrypoint[] = [];
  for (const p of Object.keys(files).sort()) {
    const m = SCRIPT_RE.exec(p); if (!m) continue;
    const skill = files[`skills/${m[1]}/SKILL.md`] ?? '';
    const d = describeScript(files[p]!);
    // Punto de entrada: lo cita su habilidad o ya funcionó en un plan probado. El resto son programas de apoyo.
    if (proven.has(p) || skill.includes(m[2]!)) out.push({ skill: m[1]!, script: p, summary: d.summary, usage: d.usage, proven: proven.has(p) });
  }
  return out;
}

export interface PortableManifestInput {
  name: string; kind: 'internal' | 'external'; exportedAt: string; bundleId: string;
  files: PortableFiles;
  requirements: PortableRequirement[];
  pythonTested: string | null;
  permissions: { runScripts: boolean; writeDocuments: boolean } | null;
  validation: { tool: string; command: string; gates: string[] } | null;
  limitations: string[];
}

export interface PortableManifest {
  schema: string; name: string; kind: 'internal' | 'external'; exportedAt: string; bundle: string;
  contents: { instructions: string[]; skills: string[]; scripts: string[]; memory: string[]; context: string[]; generated: string[] };
  entrypoints: PortableEntrypoint[];
  runtime: { python: { minimum: string; tested: string | null } | null; requirements: PortableRequirement[]; lock: string | null; binaries: PortableBinary[] };
  permissions: PortableManifestInput['permissions'];
  validation: PortableManifestInput['validation'];
  harnesses: { id: string; label: string; runsScripts: boolean; note: string }[];
  limitations: string[];
}

/** Dónde puede trabajar el paquete y con qué alcance (los programas solo donde hay un intérprete y permiso para usarlo). */
const HARNESSES = [
  { id: 'claude-code', label: 'Claude Code (terminal o escritorio)', runsScripts: true, note: 'Abre la carpeta del paquete: lee AGENTS.md y puede ejecutar los programas del agente.' },
  { id: 'codex', label: 'Codex CLI', runsScripts: true, note: 'Abre la carpeta del paquete: lee AGENTS.md y puede ejecutar los programas del agente.' },
  { id: 'cowork', label: 'Claude Cowork', runsScripts: true, note: 'Selecciona la carpeta del paquete; ejecuta los programas en su entorno aislado (instala antes los requisitos).' },
  { id: 'chat', label: 'Chat sin ejecución (Claude.ai, ChatGPT)', runsScripts: false, note: 'Adjunta AGENTS.md y las habilidades: el agente conserva su criterio y su memoria, pero no puede ejecutar sus programas.' }
];

export function buildPortableManifest(i: PortableManifestInput): PortableManifest {
  const keys = Object.keys(i.files).sort();
  const scripts = keys.filter(p => SCRIPT_RE.test(p));
  const has = scripts.length > 0;
  return {
    schema: PORTABLE_MANIFEST_SCHEMA, name: i.name, kind: i.kind, exportedAt: i.exportedAt, bundle: i.bundleId,
    contents: {
      instructions: keys.filter(p => /^(AGENTS|CLAUDE|COMO_EMPEZAR|README)\.md$/i.test(p)),
      skills: [...new Set(keys.map(p => /^skills\/([^/]+)\/SKILL\.md$/.exec(p)?.[1]).filter((s): s is string => !!s))],
      scripts,
      memory: keys.filter(p => /^memoria\/|^memory\//i.test(p)),
      context: keys.filter(p => /^contexto\/|^knowledge\//i.test(p)),
      generated: keys.filter(p => /^(GUIA|AUTOMEJORA|CAMBIOS)\.md$|^PLANES\.json$|^scripts\/|^herramientas\//.test(p))
    },
    entrypoints: listEntrypoints(i.files),
    runtime: {
      python: has ? { minimum: '3.9', tested: i.pythonTested } : null,
      requirements: i.requirements,
      lock: i.requirements.length ? PORTABLE_LOCK : null,
      binaries: detectBinaries(i.files)
    },
    permissions: i.permissions, validation: i.validation,
    harnesses: HARNESSES.filter(h => has || h.id !== 'cowork' || true),
    limitations: i.limitations
  };
}

/** requirements con las versiones probadas; lo que no se pudo fijar va sin versión y con un aviso encima. */
export function requirementsLock(reqs: PortableRequirement[]): string {
  const lines = ['# Versiones con las que este agente funciona en el Portal. Instalación reproducible:', '#   python -m pip install -r herramientas/requirements.lock.txt', ''];
  for (const r of reqs) {
    if (r.version) lines.push(`${r.name}==${r.version}`);
    else lines.push(`# AVISO: no se pudo fijar la versión de ${r.name}; se instalará la más reciente.`, r.name);
  }
  return `${lines.join('\n')}\n`;
}

/** Comprobación de entorno genérica (Python sin dependencias): lee portable.json y dice qué falta. No instala nada. */
const SELFCHECK_TEMPLATE = `# -*- coding: utf-8 -*-
"""Comprueba si ESTE entorno puede ejecutar los programas del agente. No instala ni modifica nada.

Uso: python herramientas/selfcheck.py [--json]
Sale 0 si todo lo necesario está; 1 si falta algo (y dice cómo conseguirlo).
"""
import importlib
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Dónde suele estar cada programa externo (además de su variable de entorno y del PATH).
KNOWN_PATHS = __KNOWN_PATHS__


def version_of(dist):
    try:
        from importlib import metadata
        return metadata.version(dist)
    except Exception:
        return None


def find_binary(b):
    env = os.environ.get(b.get("env") or "")
    if env and Path(env).exists():
        return env
    for c in b.get("commands", []):
        hit = shutil.which(c)
        if hit:
            return hit
    for p in KNOWN_PATHS.get(b.get("name") or "", []):
        if Path(p).exists():
            return p
    return None


def main():
    manifest = json.loads((ROOT / "portable.json").read_text(encoding="utf-8"))
    rt = manifest.get("runtime") or {}
    rows = []
    ok = True
    py = rt.get("python")
    if py:
        need = tuple(int(x) for x in str(py.get("minimum", "3.9")).split(".")[:2])
        good = sys.version_info[:2] >= need
        ok = ok and good
        rows.append({"que": "Python", "necesita": ">= " + str(py.get("minimum")), "hay": sys.version.split()[0], "ok": good,
                     "nota": "" if good else "Instala Python " + str(py.get("minimum")) + " o posterior."})
    # Dependencias que viajan junto al agente (carpeta .dependencias), si existen.
    deps = ROOT / ".dependencias"
    if deps.is_dir() and str(deps) not in sys.path:
        sys.path.insert(0, str(deps))
    for r in rt.get("requirements", []):
        found = None
        try:
            importlib.import_module(r["import"])
            found = version_of(r["name"]) or "instalado"
        except Exception:
            found = None
        good = found is not None
        ok = ok and good
        nota = ""
        if not good:
            nota = "python -m pip install -r herramientas/requirements.lock.txt"
        elif r.get("version") and found not in (r["version"], "instalado"):
            nota = "funciona con " + r["version"] + "; aquí hay " + found + " (puede comportarse distinto)"
        rows.append({"que": r["name"], "necesita": r.get("version") or "cualquiera", "hay": found or "falta", "ok": good, "nota": nota})
    for b in rt.get("binaries", []):
        hit = find_binary(b)
        good = hit is not None or not b.get("required", True)
        ok = ok and good
        rows.append({"que": b.get("label", b.get("name")), "necesita": "instalado", "hay": hit or "falta", "ok": good,
                     "nota": "" if hit else "Instálalo o indica su ruta en la variable " + str(b.get("env")) + "."})
    # En Windows, una carpeta con una ruta muy larga hace fallar a programas externos (LibreOffice se cierra al arrancar).
    if os.name == "nt" and len(str(ROOT)) > 120:
        rows.append({"que": "Ruta de la carpeta", "necesita": "corta (menos de 120 caracteres)", "hay": str(len(str(ROOT))) + " caracteres", "ok": True,
                     "nota": "AVISO: mueve el paquete a una carpeta con una ruta mas corta si un programa externo falla al arrancar."})
    if "--json" in sys.argv:
        print(json.dumps({"ok": ok, "comprobaciones": rows}, ensure_ascii=False, indent=1))
    else:
        print("Entorno para " + str(manifest.get("name")) + ":")
        for r in rows:
            print(("  [ok]    " if r["ok"] else "  [FALTA] ") + r["que"] + ": " + str(r["hay"]) + " (necesita " + str(r["necesita"]) + ")" + (" - " + r["nota"] if r["nota"] else ""))
        print("Resultado: " + ("listo para trabajar." if ok else "falta algo de lo anterior."))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
`;
export const SELFCHECK_PY = SELFCHECK_TEMPLATE.replace('__KNOWN_PATHS__', JSON.stringify(Object.fromEntries(KNOWN_BINARIES.map(k => [k.name, k.paths]))));
