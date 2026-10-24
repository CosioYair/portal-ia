export * from './types.ts';
export * from './templates.ts';
export * from './models.ts';

export const PROVIDER_META = {
  anthropic: { id: 'anthropic', name: 'Anthropic', consoleHost: 'console.anthropic.com', keyHint: 'sk-ant-…' },
  openai: { id: 'openai', name: 'OpenAI', consoleHost: 'platform.openai.com', keyHint: 'sk-…' }
} as const;
