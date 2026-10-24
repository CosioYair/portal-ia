import type { BacklogItem, ProviderId } from '@portal-ia/domain';
import { costUsd, estimatePricing, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, knowledgeRepo, processesRepo } from '../db/workspace.ts';
import { decryptSecret } from '../security/crypto.ts';

export interface ParsedStory { storyId: string; title: string; ownerKey: string | null; dependsOn: string | null; estimate: 'S' | 'M' | 'L' | null; criterion: string }

const EST = (v: any): ParsedStory['estimate'] => { const s = String(v ?? '').trim().toUpperCase(); return s === 'S' || s === 'M' || s === 'L' ? s : /peque/i.test(s) ? 'S' : /medi/i.test(s) ? 'M' : /grand/i.test(s) ? 'L' : null; };
const DEP = (v: any): string | null => { const s = String(v ?? '').trim(); if (!s || /^(ninguna|none|null|-|—|n\/a)$/i.test(s)) return null; const m = s.match(/HU-\d+/i); return m ? m[0].toUpperCase() : s; };

function fromObjects(list: any[]): ParsedStory[] {
  return list.filter(it => it && typeof it === 'object').map((it, i) => ({
    storyId: String(it.id ?? it.storyId ?? it.codigo ?? `HU-${String(i + 1).padStart(3, '0')}`).trim().toUpperCase(),
    title: String(it.titulo ?? it.title ?? it.nombre ?? it.historia ?? '').trim(),
    ownerKey: it.responsable ?? it.owner ?? it.agente ? String(it.responsable ?? it.owner ?? it.agente).trim() : null,
    dependsOn: DEP(it.dependeDe ?? it.dependencia ?? it.dependsOn ?? it.depende),
    estimate: EST(it.estimacion ?? it.estimate ?? it.tamano ?? it.tamaño),
    criterion: String(it.criterio ?? it.criterion ?? it.aceptacion ?? it.criterioAceptacion ?? '').trim()
  })).filter(x => x.title);
}

/** Encuentra arrays JSON balanceados dentro de un texto (respetando cadenas). */
function findJsonArrays(text: string): any[][] {
  const out: any[][] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === '[' || ch === '{') depth++; else if (ch === ']' || ch === '}') { depth--; if (depth === 0) { try { const v = JSON.parse(text.slice(i, j + 1)); if (Array.isArray(v) && v.some(x => x && typeof x === 'object')) out.push(v); } catch { /* no es JSON */ } i = j; break; } }
    }
  }
  return out;
}

/** Extrae historias del markdown de la síntesis: JSON (en bloques o suelto), tablas markdown o listas con HU-xxx. */
export function parseBacklogFromMarkdown(md: string): ParsedStory[] {
  // 1) Bloques de código: cualquier lenguaje.
  for (const m of md.matchAll(/```[a-zA-Z]*\s*([\s\S]*?)```/g)) {
    try { const v = JSON.parse(m[1]); const arr = Array.isArray(v) ? v : Object.values(v).find(x => Array.isArray(x)); if (Array.isArray(arr)) { const r = fromObjects(arr); if (r.length) return r; } } catch { /* seguir */ }
    const arrs = findJsonArrays(m[1]); for (const a of arrs) { const r = fromObjects(a); if (r.length) return r; }
  }
  // 2) Arrays JSON sueltos en el texto.
  for (const a of findJsonArrays(md)) { const r = fromObjects(a); if (r.length) return r; }
  // 3) Tablas markdown con una columna HU-xxx.
  const rows = md.split('\n').filter(l => /^\s*\|/.test(l) && /HU-\d+/i.test(l));
  if (rows.length) {
    const header = md.split('\n').find(l => /^\s*\|/.test(l) && /(t[ií]tulo|historia)/i.test(l));
    const cols = header ? header.split('|').slice(1, -1).map(c => c.trim().toLowerCase()) : [];
    const idx = (re: RegExp) => cols.findIndex(c => re.test(c));
    const iTitle = idx(/t[ií]tulo|historia|nombre/), iOwner = idx(/responsable|agente|owner/), iDep = idx(/depend/), iEst = idx(/estim|tama/), iCrit = idx(/criterio|acept/);
    const r = rows.map(l => { const c = l.split('|').slice(1, -1).map(x => x.trim().replace(/\*\*/g, '')); const id = (l.match(/HU-\d+/i) ?? [''])[0].toUpperCase();
      const title = iTitle >= 0 ? c[iTitle] : (c.find((x, k) => k > 0 && x && !/^HU-/i.test(x)) ?? '');
      return { storyId: id, title: title.replace(/^HU-\d+\s*[·:\-—]\s*/i, ''), ownerKey: iOwner >= 0 ? c[iOwner] || null : null, dependsOn: DEP(iDep >= 0 ? c[iDep] : ''), estimate: EST(iEst >= 0 ? c[iEst] : ''), criterion: iCrit >= 0 ? c[iCrit] ?? '' : '' }; }).filter(x => x.storyId && x.title);
    if (r.length) return r;
  }
  // 4) Encabezados o viñetas "HU-005 — Título" (solo título).
  const seen = new Set<string>(); const r: ParsedStory[] = [];
  for (const l of md.split('\n')) { const m = l.match(/\b(HU-\d{2,3})\b\s*[·:\-—–)]*\s*\**\s*([^|*\n]{6,160})/i); if (m && !seen.has(m[1].toUpperCase())) { seen.add(m[1].toUpperCase()); r.push({ storyId: m[1].toUpperCase(), title: m[2].trim().replace(/[*_`]+$/, ''), ownerKey: null, dependsOn: null, estimate: null, criterion: '' }); } }
  return r;
}

function resolveOwner(slug: string, owner: string | null): string | null {
  if (!owner) return null;
  const agents = agentsRepo(slug).list();
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const o = norm(owner);
  const byKey = agents.find(a => a.key === owner); if (byKey) return byKey.key;
  const byName = agents.find(a => norm(a.config.name) === o || norm(a.template.role) === o); if (byName) return byName.key;
  const words = o.split(/\W+/).filter(w => w.length > 3);
  const partial = agents.find(a => { const n = norm(a.config.name) + ' ' + norm(a.template.role); return words.some(w => n.includes(w)); });
  return partial?.key ?? null;
}

export function findSynthesis(slug: string, projectId: string) {
  const docs = knowledgeRepo(slug).list(projectId);
  return docs.find(d => /^S[ií]ntesis/i.test(d.title)) ?? docs.find(d => /backlog/i.test(d.title)) ?? docs.find(d => /HU-\d+/.test(d.body)) ?? null;
}

function insertStories(slug: string, projectId: string, items: ParsedStory[], sourceProcessId: string | null): number {
  const repo = backlogRepo(slug);
  const existing = new Set(repo.list(projectId).map(b => b.storyId));
  let imported = 0;
  for (const it of items) {
    if (existing.has(it.storyId)) continue; existing.add(it.storyId);
    repo.add({ projectId, storyId: it.storyId, title: it.title, ownerKey: resolveOwner(slug, it.ownerKey), dependsOn: it.dependsOn, estimate: it.estimate, criterion: it.criterion, description: '', sourceProcessId });
    imported++;
  }
  return imported;
}

/** Importa el backlog desde la síntesis sin IA. */
export function importBacklogFromKnowledge(slug: string, projectId: string): { imported: number; total: number; source: string | null; parsed: number } {
  const synthesis = findSynthesis(slug, projectId);
  if (!synthesis) return { imported: 0, total: backlogRepo(slug).count(projectId), source: null, parsed: 0 };
  const items = parseBacklogFromMarkdown(synthesis.body);
  const imported = insertStories(slug, projectId, items, synthesis.processId);
  return { imported, total: backlogRepo(slug).count(projectId), source: synthesis.title, parsed: items.length };
}

export function estimateExtraction(slug: string, projectId: string): { model: string; byAgent: string; estimatedUsd: number } | null {
  const synthesis = findSynthesis(slug, projectId); if (!synthesis) return null;
  const coord = agentsRepo(slug).list().find(a => a.key === 'pj-coordinador' && a.projectId === projectId) ?? agentsRepo(slug).list().find(a => a.key === 'pj-coordinador');
  if (!coord) return null;
  const p = estimatePricing(coord.config.provider, coord.config.model);
  return { model: coord.config.model, byAgent: coord.config.name, estimatedUsd: ((synthesis.body.length / 3.5 + 800) * p.inPerM + 2500 * p.outPerM) / 1_000_000 };
}

/** Si el parseo falla, el Coordinador convierte la síntesis en historias (1 llamada real, autorizada por el usuario). */
export async function extractBacklogWithAI(slug: string, projectId: string, maxUsd: number): Promise<{ imported: number; total: number; source: string | null; costUsd: number }> {
  const synthesis = findSynthesis(slug, projectId);
  if (!synthesis) throw Object.assign(new Error('No hay una síntesis en Conocimiento. Ejecuta primero la evaluación inicial.'), { statusCode: 409 });
  const est = estimateExtraction(slug, projectId);
  if (!est) throw Object.assign(new Error('Falta el Coordinador del Proyecto.'), { statusCode: 409 });
  if (est.estimatedUsd > maxUsd) throw Object.assign(new Error(`La extracción cuesta aprox. ${est.estimatedUsd.toFixed(3)} USD, por encima del tope (${maxUsd.toFixed(2)} USD).`), { statusCode: 409 });
  const coord = agentsRepo(slug).list().find(a => a.key === 'pj-coordinador' && a.projectId === projectId) ?? agentsRepo(slug).list().find(a => a.key === 'pj-coordinador')!;
  const providerId = coord.config.provider as ProviderId;
  const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
  if (!cred || prow.status !== 'connected') throw Object.assign(new Error('El proveedor del Coordinador no está conectado.'), { statusCode: 409 });
  const agents = agentsRepo(slug).list().map(a => `${a.key}: ${a.config.name}`).join(', ');
  const startedAt = new Date().toISOString();
  try {
    const res = await getAdapter(providerId)!.complete(decryptSecret(cred.ciphertext), { workspaceId: prow.workspace_id }, {
      model: coord.config.model, maxTokens: 3000, effort: 'low', supportsEffort: false,
      system: `Eres «${coord.config.name}». Conviertes un documento de dirección en un backlog estructurado. Agentes disponibles (key: nombre): ${agents}. Responde SOLO con JSON válido.`,
      user: `Extrae TODAS las historias del siguiente documento. Responde SOLO con un array JSON de objetos {"id":"HU-0xx","titulo":string,"responsable":key de agente o null,"dependeDe":"HU-0xx"|null,"estimacion":"S"|"M"|"L"|null,"criterio":string}. Mantén los ids del documento; si no tiene, numera desde HU-005.\n\n${synthesis.body.slice(0, 40_000)}`
    });
    const cost = costUsd(providerId, coord.config.model, res.inputTokens, res.outputTokens);
    processesRepo(slug).logExecution({ projectId, agentId: coord.id, kind: 'backlog_extract', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
    const items = parseBacklogFromMarkdown(res.text);
    const imported = insertStories(slug, projectId, items, synthesis.processId);
    return { imported, total: backlogRepo(slug).count(projectId), source: synthesis.title, costUsd: cost };
  } catch (e) {
    processesRepo(slug).logExecution({ projectId, agentId: coord.id, kind: 'backlog_extract', status: 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt });
    if (e instanceof ProviderRequestError) throw Object.assign(new Error(e.error.message), { statusCode: 502 });
    throw e;
  }
}

/** Alta manual (solicitud de desarrollo del propietario o del asistente). */
export function addManualItem(slug: string, projectId: string, input: { title: string; description?: string; criterion?: string; ownerKey?: string | null; estimate?: 'S' | 'M' | 'L' | null }): BacklogItem {
  const repo = backlogRepo(slug);
  const ids = new Set(repo.list(projectId).map(b => b.storyId));
  // Numeración continua: siguiente número tras el mayor existente (HU-014 → HU-015).
  let k = Math.max(0, ...Array.from(ids).map(id => parseInt(id.replace(/\D+/g, ''), 10)).filter(Number.isFinite)) + 1;
  let storyId = `HU-${String(k).padStart(3, '0')}`;
  while (ids.has(storyId)) storyId = `HU-${String(++k).padStart(3, '0')}`;
  const hasCoord = agentsRepo(slug).list().some(a => a.key === 'pj-coordinador' && (a.projectId === projectId || a.projectId === null));
  return repo.add({ projectId, storyId, title: input.title, ownerKey: input.ownerKey ?? (hasCoord ? 'pj-coordinador' : null), dependsOn: null, estimate: input.estimate ?? null, criterion: input.criterion ?? '', description: input.description ?? '', sourceProcessId: null });
}

/**
 * Devuelve una historia a «pendiente» (p. ej. se rechaza el diff en revisión o se replantea). El proceso anterior se
 * conserva y queda marcado como superado; la historia vuelve a ser ejecutable.
 */
export function resetStory(slug: string, itemId: string, reason: string): BacklogItem {
  const repo = backlogRepo(slug); const it = repo.get(itemId);
  if (!it) throw Object.assign(new Error('Historia no encontrada'), { statusCode: 404 });
  if (it.status === 'in_progress') throw Object.assign(new Error('La historia está en ejecución; cancela el proceso primero.'), { statusCode: 409 });
  const procs = processesRepo(slug);
  const last = (it.lastProcessId ? procs.get(it.lastProcessId) : undefined) ?? procs.list(it.projectId).find(p => p.backlogItemId === it.id && p.kind === 'story_execution');
  if (last?.result && !last.result.applied && !last.result.rejected) procs.setResult(last.id, { ...last.result, rejected: { at: new Date().toISOString(), reason } });
  repo.update(it.id, { description: `${it.description ? it.description + '\n' : ''}[${new Date().toISOString().slice(0, 10)}] Devuelta a pendiente: ${reason}` });
  repo.setStatus(it.id, 'pending', last?.id ?? null);
  return repo.get(it.id)!;
}
