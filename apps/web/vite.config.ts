import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Commit corto de HEAD; null si no hay git, no es un repo o la salida no es un hash válido.
function headCommit(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
    }).toString().trim();
    return /^[0-9a-f]{7,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

function rootVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

// Escribe build-info.json en el outDir de cualquier `vite build` (también `--outDir dist.next`),
// para que /api/system/status muestre el buildCommit real. Si el build falla, no se escribe.
function portalBuildInfo(): Plugin {
  let outDir = 'dist';
  let written = false;
  return {
    name: 'portal-build-info',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      written = true;
    },
    closeBundle() {
      if (!written) return;
      const info = { commit: headCommit(), builtAt: new Date().toISOString(), version: rootVersion() };
      writeFileSync(path.join(outDir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n', 'utf8');
    }
  };
}

// En desarrollo, /api se redirige al backend local (apps/server). En producción el backend sirve dist/.
export default defineConfig({
  plugins: [react(), portalBuildInfo()],
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4310', changeOrigin: false } } },
  build: { outDir: 'dist', sourcemap: false }
});
