// HU-211 · Genera la Edición distribuible desde el Estudio con el árbol limpio.
// Uso: npm run edition:build [-- --out <carpeta>]
// El ZIP se escribe en la carpeta hermana «<repo>-ediciones» (o en --out), nunca dentro del repositorio ni de data/.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, SELF_IMPROVEMENT_ENABLED, config } from '../src/config.ts';
import { assertCleanTree, buildEditionZip } from '../src/services/editionBundle.ts';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function outArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--out') return argv[i + 1]?.trim() || null;
    if (a.startsWith('--out=')) return a.slice('--out='.length).trim() || null;
  }
  return null;
}

function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    const v = typeof pkg.version === 'string' ? pkg.version.trim() : '';
    return /^[0-9A-Za-z.+-]+$/.test(v) ? v : '0.0.0';
  } catch { return '0.0.0'; }
}

async function main(): Promise<void> {
  if (!SELF_IMPROVEMENT_ENABLED) throw new Error('Solo el Estudio (PORTAL_EDITION=studio) genera la Edición distribuible.');
  let porcelain: string;
  let head: string;
  try {
    porcelain = git('status', '--porcelain');
    head = git('rev-parse', 'HEAD').trim();
  } catch {
    throw new Error('No se pudo consultar git en la raíz del repositorio: la Edición solo se genera desde un checkout de git.');
  }
  assertCleanTree(porcelain);
  if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error(`HEAD no es un commit válido («${head}»).`);

  const given = outArg(process.argv.slice(2));
  const outDir = given ? path.resolve(process.cwd(), given) : path.join(path.dirname(REPO_ROOT), `${path.basename(REPO_ROOT)}-ediciones`);
  const outFile = path.join(outDir, `portal-ia-edicion-${version()}-${head.slice(0, 7)}.zip`);
  const rel = path.relative(path.resolve(REPO_ROOT), outFile);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('La carpeta de salida no puede estar dentro del repositorio.');
  fs.mkdirSync(outDir, { recursive: true });

  const res = await buildEditionZip({ root: REPO_ROOT, webDist: config.webDist, dataDir: config.dataDir, outFile, expectedCommit: head });
  console.log('[portal-ia] Edición distribuible generada');
  console.log(`  archivo:  ${res.outFile}`);
  console.log(`  commit:   ${head}`);
  console.log(`  entradas: ${res.entries}`);
  console.log(`  tamaño:   ${res.bytes} bytes`);
  console.log(`  sha256:   ${res.sha256}`);
  console.log('  Para lanzarla: descomprime, ejecuta «npm ci» y luego «npm run start:edition».');
}

main().catch((e: unknown) => {
  console.error(`[portal-ia] No se generó la Edición: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
