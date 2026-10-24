import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '../routes/fs.ts';

/**
 * Contexto de solo lectura del repositorio registrado, acotado en tamaño para controlar el costo.
 * Nunca escribe ni ejecuta nada. Excluye dependencias, builds, datos y secretos.
 */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'data', '.next', 'coverage', '.cache', '.turbo', '.vite']);
const SECRET_PATTERNS = [/\.env(\..*)?$/i, /\.key$/i, /\.pem$/i, /secret/i, /credential/i];
const PRIORITY_FILES = ['README.md', 'DESIGN_HANDOFF_Portal_IA.md', 'package.json', 'tsconfig.base.json', 'packages/domain/src/types.ts', 'packages/domain/src/templates.ts', 'packages/ai-adapters/src/index.ts', 'apps/server/src/app.ts', 'apps/server/src/routes/bootstrap.ts', 'apps/server/src/db/workspace.ts', 'apps/web/src/App.tsx'];

export interface RepoContext { tree: string; files: { path: string; chars: number; content: string }[]; totalChars: number; truncated: boolean }

function walk(root: string, rel: string, depth: number, lines: string[], max: number) {
  if (depth > 3 || lines.length > max) return;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    lines.push(`${'  '.repeat(depth)}${e.isDirectory() ? e.name + '/' : e.name}`);
    if (e.isDirectory()) walk(root, p, depth + 1, lines, max);
    if (lines.length > max) { lines.push('… (árbol truncado)'); return; }
  }
}

export function buildRepoContext(repoPath: string, maxChars = 90_000): RepoContext {
  const root = path.resolve(expandHome(repoPath));
  const lines: string[] = [];
  walk(root, '', 0, lines, 400);
  const tree = lines.join('\n');
  const files: RepoContext['files'] = [];
  let total = tree.length; let truncated = false;
  for (const rel of PRIORITY_FILES) {
    const abs = path.join(root, rel);
    if (SECRET_PATTERNS.some(r => r.test(rel))) continue;
    let content: string;
    try { if (!fs.statSync(abs).isFile()) continue; content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const budget = maxChars - total;
    if (budget <= 2000) { truncated = true; break; }
    if (content.length > budget) { content = content.slice(0, budget) + '\n… (archivo truncado)'; truncated = true; }
    files.push({ path: rel, chars: content.length, content });
    total += content.length;
  }
  return { tree, files, totalChars: total, truncated };
}

export function renderRepoContext(ctx: RepoContext): string {
  return [`## Árbol del repositorio (profundidad ≤ 3)\n\`\`\`\n${ctx.tree}\n\`\`\``, ...ctx.files.map(f => `## Archivo: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``), ctx.truncated ? '_(Contexto truncado por límite de tamaño.)_' : ''].join('\n\n');
}
