export * from './types.ts';
export * from './templates.ts';
export * from './models.ts';
export * from './manual-test.ts';
export * from './qa.ts';
export * from './pipeline.ts';
export * from './claude-code.ts';
export * from './orgEvaluation.ts';
export * from './metrics.ts';
export * from './gauntlet.ts';
export * from './batch.ts';

export const PROVIDER_META = {
  anthropic: { id: 'anthropic', name: 'Anthropic', consoleHost: 'console.anthropic.com', keyHint: 'sk-ant-…' },
  openai: { id: 'openai', name: 'OpenAI', consoleHost: 'platform.openai.com', keyHint: 'sk-…' }
} as const;
