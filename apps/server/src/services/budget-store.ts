import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { createBudgetHierarchy, type BudgetHierarchy } from './budget-hierarchy.ts';

const cache = new Map<string, BudgetHierarchy>();
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * Libro jerárquico de un espacio (empresa). Una base SQLite por espacio:
 * data/workspaces/<slug>/budgets.sqlite. Se crea bajo demanda.
 */
export function budgetHierarchyFor(slug: string): BudgetHierarchy {
  if (!SLUG_RE.test(slug)) throw new Error('Espacio no válido.');
  let h = cache.get(slug);
  if (!h) {
    const dir = path.join(config.dataDir, 'workspaces', slug);
    fs.mkdirSync(dir, { recursive: true });
    h = createBudgetHierarchy(new DatabaseSync(path.join(dir, 'budgets.sqlite')), slug);
    cache.set(slug, h);
  }
  return h;
}
