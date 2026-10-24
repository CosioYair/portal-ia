import tseslint from 'typescript-eslint';

// Reglas de dependencia entre paquetes del monorepo (ver docs/adr/0001-monorepo-y-reglas-de-dependencia.md).
// En flat config, una regla definida en un override REEMPLAZA a la anterior (no se fusiona),
// por eso cada override repite los patrones comunes mediante restringir().

const TS_FILES = ['**/*.ts', '**/*.tsx'];

// Imports relativos que salen de un paquete hacia otro (por ejemplo ../../domain/src/index.ts).
const cruceEntrePaquetes = [
  {
    regex: '^([.][.]/)+(packages|apps)/',
    message:
      'Prohibido importar por ruta relativa hacia otro paquete o app. Usa el nombre del paquete (@portal/...) si la dependencia está permitida.'
  },
  {
    regex: '^([.][.]/)+[^./][^/]*/src(/|$)',
    message:
      'Prohibido importar por ruta relativa el código fuente de otro paquete. Usa el nombre del paquete (@portal/...) si la dependencia está permitida.'
  }
];

// Módulos de entrada/salida de Node y equivalentes.
const MODULOS_IO = [
  'node:*',
  'fs',
  'fs/*',
  'path',
  'os',
  'child_process',
  'http',
  'https',
  'net',
  'dgram',
  'dns',
  'tls',
  'stream',
  'worker_threads',
  'cluster'
];

const restringir = (...patterns) => ({
  'no-restricted-imports': ['error', { patterns: [...patterns, ...cruceEntrePaquetes] }]
});

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'coverage/**']
  },

  // Reglas recomendadas de typescript-eslint, limitadas a archivos TypeScript.
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: TS_FILES })),

  {
    files: TS_FILES,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },

  // Global: ningún paquete ni app importa por ruta relativa el código de otro.
  {
    files: ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'],
    rules: restringir()
  },

  // domain: sin dependencias, sin IO. Solo imports relativos dentro del propio paquete.
  {
    files: ['packages/domain/**/*.{ts,tsx}'],
    rules: restringir(
      {
        group: ['@portal/*'],
        message: 'packages/domain no puede depender de ningún otro paquete @portal/*.'
      },
      {
        group: MODULOS_IO,
        message: 'packages/domain no admite IO ni módulos de Node.'
      },
      {
        group: ['fastify', 'fastify/*', '@fastify/*', 'react', 'react/*', 'react-dom', 'react-dom/*', 'zod'],
        message: 'packages/domain no puede depender de frameworks ni de librerías de validación.'
      },
      {
        regex: '^(?![.]{1,2}/).',
        message: 'packages/domain no admite dependencias externas: solo imports relativos dentro del paquete.'
      }
    )
  },

  // contracts: solo puede depender de @portal/domain.
  {
    files: ['packages/contracts/**/*.{ts,tsx}'],
    rules: restringir(
      {
        regex: '^@portal/(?!domain$)',
        message: 'packages/contracts solo puede depender de @portal/domain (y solo por su entrada pública).'
      },
      {
        group: MODULOS_IO,
        message: 'packages/contracts no admite IO ni módulos de Node.'
      },
      {
        group: ['fastify', 'fastify/*', '@fastify/*', 'react', 'react/*', 'react-dom', 'react-dom/*'],
        message: 'packages/contracts no puede depender de frameworks de servidor ni de interfaz.'
      }
    )
  },

  // ai-adapters: no depende de las apps.
  {
    files: ['packages/ai-adapters/**/*.{ts,tsx}'],
    rules: restringir({
      group: ['@portal/server', '@portal/server/*', '@portal/web', '@portal/web/*'],
      message: 'packages/ai-adapters no puede depender de apps/server ni de apps/web.'
    })
  },

  // web: no importa servidor ni adaptadores de IA ni módulos de Node.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: restringir(
      {
        group: ['@portal/server', '@portal/server/*', '@portal/ai-adapters', '@portal/ai-adapters/*'],
        message: 'apps/web no puede importar el servidor ni los adaptadores de IA; se comunica por HTTP usando @portal/contracts.'
      },
      {
        group: ['node:*'],
        message: 'apps/web no puede usar módulos de Node.'
      }
    )
  },

  // server: no importa la web.
  {
    files: ['apps/server/**/*.{ts,tsx}'],
    rules: restringir({
      group: ['@portal/web', '@portal/web/*'],
      message: 'apps/server no puede depender de apps/web.'
    })
  }
);
