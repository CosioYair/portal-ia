# ADR 0001 · Monorepo y reglas de dependencia

- Estado: propuesto (pendiente de aprobación del propietario)
- Historia: HU-001

## Contexto

Portal IA se desarrolla en un único repositorio con varios paquetes. Para que la arquitectura no se degrade, la dirección de las dependencias debe imponerse con una herramienta y no solo con convención. El criterio de aceptación exige que la compilación estricta pase y que el lint falle ante un import prohibido entre paquetes.

## Decisión

1. Monorepositorio con **npm workspaces** (`packages/*` y `apps/*`), TypeScript estricto, ESM e imports con extensión `.ts`/`.tsx`.
2. Las dependencias se imponen con la regla nativa **`no-restricted-imports`** de ESLint (flat config), con un override por carpeta. No se añaden plugins adicionales.
3. Los imports relativos que cruzan paquetes están prohibidos en todo el monorepo. Se debe importar por nombre de paquete (`@portal/...`) y solo si la matriz lo permite.
4. Una prueba con `node --test` (`scripts/dependency-rules.test.mjs`) usa la API de ESLint para demostrar que un import prohibido falla y uno permitido pasa.

## Matriz de dependencias permitidas

| Origen \ Destino | domain | contracts | ai-adapters | server | web | node:* / IO | fastify / zod / react |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `packages/domain` | (propio) | No | No | No | No | No | No |
| `packages/contracts` | Sí | (propio) | No | No | No | No | No |
| `packages/ai-adapters` | Sí | Sí | (propio) | No | No | Sí | No |
| `apps/server` | Sí | Sí | Sí | (propio) | No | Sí | Sí |
| `apps/web` | Sí | Sí | No | No | (propio) | No | Sí (react) |

Notas:

- `domain` no admite ninguna dependencia externa: solo imports relativos dentro del propio paquete.
- `contracts` solo puede depender de `@portal/domain`, por su entrada pública.
- `web` se comunica con el servidor por HTTP usando los tipos de `@portal/contracts`.
- Las reglas de `ai-adapters`, `server` y `web` están definidas desde ya, aunque esos paquetes se crearán en historias posteriores. Hoy solo se ejercitan con rutas virtuales en la prueba.

## Dependencias de desarrollo

Son las únicas añadidas, imprescindibles para el criterio de aceptación:

- `typescript`: compilación estricta (`npm run typecheck`).
- `eslint`: motor de lint y regla `no-restricted-imports` (`npm run lint`).
- `typescript-eslint`: analizador de TypeScript para ESLint y la regla `no-explicit-any`.

## Alternativas descartadas

- Script propio que analice imports: más frágil y no equivale al «lint» que pide el criterio.
- Plugins adicionales de ESLint para límites entre módulos: añaden dependencias y la regla nativa basta para esta matriz.

## Consecuencias

- Añadir un paquete nuevo exige actualizar `eslint.config.js` y esta matriz.
- La prueba de reglas vive en `scripts/` porque `apps/server` aún no existe. Deberá reubicarse o reconocerse como excepción cuando se cree el servidor.
- `allowImportingTsExtensions` obliga a `noEmit`. La estrategia de ejecución y build (Node con soporte de TypeScript, Vite) se decidirá en historias posteriores y puede requerir ajustes en el `tsconfig`.
- Se fija `engines.node >= 22.5` por `node:sqlite` y el soporte de TypeScript en Node.
