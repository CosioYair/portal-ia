import { workspacesRepo } from '../db/platform.ts';
import { migrateAgentContextScopes, setCompanyNameResolver } from './agentFolders.ts';

/**
 * EN-014 · Arranque: registra cómo se resuelve el nombre de la empresa (del registro de espacios, nunca escrito a mano)
 * y ejecuta en cada espacio la migración idempotente del ámbito (Empresa + General, una revisión «portal» por agente).
 * Sin IA ni costo; no cambia arnés, permisos, memoria ni carpeta.
 */
export function registerCompanyNameResolver(): void {
  setCompanyNameResolver(slug => workspacesRepo.get(slug)?.name ?? null);
}

export async function runContextScopeMigration(log: (o: any, m: string) => void = () => {}): Promise<{ migrated: number; failed: number }> {
  registerCompanyNameResolver();
  let migrated = 0; let failed = 0;
  for (const ws of workspacesRepo.list()) {
    try {
      const r = await migrateAgentContextScopes(ws.slug, ws.name ?? null);
      migrated += r.migrated.length; failed += r.failed.length;
      if (r.migrated.length) log({ workspace: ws.slug, migrated: r.migrated.length }, 'ámbito inicial de los agentes: Empresa + General');
      for (const f of r.failed) log({ workspace: ws.slug, agentId: f.agentId, error: f.error }, 'ámbito inicial no aplicado a un agente');
    } catch (e) { failed++; log({ workspace: ws.slug, err: (e as Error).message }, 'migración del ámbito omitida en este espacio'); }
  }
  return { migrated, failed };
}

// Al importar el módulo el resolver ya queda registrado (también para quien llame a buildApp sin pasar por index.ts).
registerCompanyNameResolver();
