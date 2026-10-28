# HU-155 · Rescate de la iteración 4 sin regenerar ni gastar en IA

Proceso `98c680e1-a8dc-4143-9a80-8be875be541e`, rama `portal-ia/hu-155`, worktree
`Portal IA-worktrees/98c680e1-…`, base `608adec`.

Este análisis se hizo sin abrir `data/` y sin llamadas reales a la IA. Los metadatos del proceso se leyeron con GET de
solo lectura a la API del Portal en marcha.

## 1. Estado encontrado

| Dato | Valor |
|---|---|
| Entregables | 9 de 9 en el worktree; 25 unidades terminadas |
| Correcciones | 9 de 9 aplicadas (22 llamadas de corrección pagadas); el propietario amplió el máximo tres veces |
| Último commit | `e06ba9e` (corrección 9; la interfaz mostraba `7f1c6f2`, la 8) |
| Verificación | typecheck en verde; test en rojo (`v0121-declaraciones.test.ts`); build sin verificar sobre ese commit |
| QA | último veredicto sobre `92178b4` (corrección 5): rechazo con 8 hallazgos |
| Gasto | 10,45 USD confirmados de 41,60 autorizados |

## 2. Causa exacta del fallo

`v0121-declaraciones.test.ts` comprueba que cada ruta del catálogo (`v0121-areas.ts`) está declarada en el código real del
servidor. El catálogo usaba rutas **supuestas**. Ninguna era una ruta con prefijo ni compuesta: Fastify no usa prefijos en
este servidor (`app.ts:39-52`, `register()` sin `prefix`). Era la explicación E (referencias erróneas generadas por el equipo).

| El catálogo decía | Lo que existe de verdad |
|---|---|
| `GET /api/workspaces/{ws}/assistant/conversations` | `GET /api/assistant` (`routes/assistant.ts:8`, solo lectura: `{ info, messages }`) |
| `GET …/projects/{project}/stories` (`stories.ts`) | `GET …/projects/{project}/backlog` (`routes/processes.ts:166`) |
| `GET /api/inbox` | `GET /api/workspaces/{ws}/inbox` (`routes/inbox.ts:18`) |
| `GET /api/workspaces/{ws}/budgets` | `GET /api/budgets/:level/:id/balance` (`routes/budgets.ts:32`; empresa = slug) |
| `GET /api/usage/today` (`providers.ts`), campos `tokensIn/tokensOut/cost` | `GET /api/workspaces/{ws}/usage/today` (`routes/workspaces.ts:83`), `UsageToday` = `{ processes, tokens, costUsd, running, calls, failedCalls }` |
| sandbox y Conocimiento en `system.ts` / `workspaces.ts` | ambos en `routes/processes.ts` (`:429`, `:479`) |
| `POST …/knowledge` (`{ title, content }`) | **no existe**: el Portal no ofrece el alta de Conocimiento por HTTP |

La prueba se detenía en el primer elemento que fallaba, así que cada ronda revelaba una sola ruta. La corrección 9 resolvió
la del Asistente así: convirtió el área en «Falla prevista» y escribió una prueba que exige que la ruta inventada NO exista.
Pasaba la prueba, pero dejaba un resultado falso: sí hay un GET de solo lectura del Asistente.

**¿Faltaba el endpoint?** No. Las cinco rutas existen con otra forma. Lo único que falta de verdad es el alta HTTP en
Conocimiento: el criterio 5 (`--publicar` crea el informe) no se puede cumplir sin un endpoint nuevo. Lo decide el propietario.

## 3. Por qué el equipo falló nueve veces

| Rondas | Qué pasó | Mecanismo |
|---|---|---|
| 1-3 | Fallaron dos pruebas **del Portal** en Docker («revisión 3» y «F»); el equipo las modificó fuera del plan | El proveedor simulado guardaba su guion en caché por fecha de modificación. En Linux, dos escrituras dentro del mismo tic tienen la misma fecha y una prueba respondía con las reglas de la anterior (el «plan sin archivos» de la prueba previa). En `main`, la suite pasa en Docker; el fallo es intermitente. |
| 4 y 6 | Rechazos de QA (6 hallazgos por ronda) | Hallazgos reales: rutas y campos supuestos, contrato sin cotejar, pruebas de otros tocadas |
| 5, 7-9 | La prueba de declaraciones, una ruta cada vez | El Desarrollador **nunca vio los archivos de rutas**. Las correcciones de una prueba solo reciben la prueba y el código entregado; las referencias del plan no incluían `routes/*.ts`. Tuvo que suponer. |

Además:
- «Continuar» vacía la lista de fallos repetidos (por diseño). Por eso la detección de «el mismo fallo» nunca se disparó.
- Cada ronda recibió el diagnóstico exacto, pero solo el primer elemento.
- Ningún parche se rechazó sin explicación: los rechazos de ámbito quedaron en el manifiesto.

## 4. Corrección externa preparada (sin IA)

Commit `5bee368` sobre `e06ba9e`, en un clon aislado; el worktree real no se ha tocado. Siete archivos, sin regenerar ningún
entregable:
- **Catálogo:** rutas reales; GET real del Asistente, sin la «Falla prevista».
- **Huella de gasto:** campos reales de `usageToday()` (`calls`, `tokens`, `costUsd`).
- **`--publicar`:** no envía un POST no declarado; informa «no publicado» con el motivo.
- **Prueba de declaraciones:** informa de **todos** los desajustes a la vez y comprueba cada ruta contra el **registro real
  de Fastify** (`buildApp()` con datos aislados, `hasRoute` e `inject`).
- **Hallazgo F7 de QA:** se revierte el cambio fuera del plan en `incremental-delivery.test.ts`.
- **Contrato e incidente:** tablas de endpoints y de campos cotejadas con el código.

| Comprobación | Resultado |
|---|---|
| Pruebas de HU-155 | 19/19 |
| Sandbox Docker real | typecheck 0, build 0; test: 250 pruebas, 242 en verde, 0 fallos, 8 omitidas |
| Catálogo anterior contra el registro real de Fastify | cuatro rutas no registradas, detectadas en una sola ejecución |

## 5. Cambios en el Portal para que no se repita

- **Proveedor simulado:** relee su guion en cada llamada (`mock-provider.test.ts`).
- **Diagnóstico enfocado** (`services/failureDiagnosis.ts`, sin IA), en cada corrección de un fallo del sandbox:
  - comando, prueba y mensaje completos, y el código de la aserción;
  - archivos que cita el fallo;
  - índice real de rutas (con prefijos de `register()`) cuando el fallo habla de rutas;
  - fallos anteriores del mismo caso;
  - tipo de fallo: entorno, prueba existente, integración, ruta inexistente, aserción frágil, contraste con el repositorio,
    progreso parcial, sin progreso o defecto de implementación.
- **Prueba ajena que falla:** si solo fallan pruebas que la historia no creó, ni planificó, ni tocó, se repite `test` una
  vez por commit, sin IA.
- **Prueba existente fuera del plan:** una corrección no la modifica (salvo para restaurarla).
- **SIN CAMBIOS ante un fallo objetivo:** si el Desarrollador responde así con evidencia, decide el propietario sin pagar
  otro intento.
- **Corrección externa autorizada** (`POST /processes/:id/external-correction`, `services/externalCorrection.ts`):
  - se registra con su commit y sus archivos reales;
  - el worktree solo avanza en avance rápido;
  - se rechazan las rutas protegidas y los cambios sin confirmar;
  - se verifica en el sandbox sin IA y se detiene antes de QA;
  - no crea pasos, tokens ni correcciones del equipo, y QA lo sabe.
- **Commit hecho fuera del equipo y sin registrar:** «Continuar» se detiene sin IA y la interfaz ofrece registrarlo.
- **Lector de TAP:** el mensaje de un bloque `error: |-` ya no queda como «-».

Las pruebas están en `correction-diagnosis.test.ts` (A-I) y `mock-provider.test.ts`. Las de diagnóstico, protección y
corrección externa fallan con el código anterior.

| Validación | Resultado |
|---|---|
| `PORTAL_REQUIRE_DOCKER=1 npm test` | 239/241 (2 omitidas por plataforma) |
| Playwright, clon aislado | 10/10 del registro desde la interfaz, también a 390 px |
| e2e de automejora (J) | 53/53, 16 llamadas al proveedor simulado y ninguna real |

La ruta nueva va al final de `routes/processes.ts`. Así las líneas que cita el contrato de HU-155 (`:166`, `:429`,
`:479`) siguen siendo correctas al integrarla.

## 6. Cómo terminar HU-155 (sin iteración 5)

1. Reiniciar el Portal con este código («Reconstruir y reiniciar»; requiere autorización).
2. Llevar el worktree al commit de rescate, en avance rápido:
   `git -C "<worktree>" merge --ff-only portal-ia/hu-155-rescate`.
3. Pulsar «Registrar la corrección externa y verificarla (sin IA)» en la historia, con una nota. Se espera la pausa
   «Corrección externa verificada: falta QA».
4. Pulsar «Pasar a QA (sin correcciones nuevas)» con un tope de ≈ 0,5 USD. Si QA aprueba, la historia queda verificada y
   la integración sigue siendo una decisión del propietario. Si rechaza, se detiene sin llamar al Desarrollador.

## 7. Decisiones del propietario que quedan

- **Criterio 5:** no hay alta HTTP en Conocimiento. Las opciones son añadir un endpoint (fuera del plan) o aceptar
  «no publicado» y publicar a mano.
- **Barra del sistema:** el catálogo exige el commit `d9b857c`, pero el Portal en marcha está en otro. Esa área saldrá
  Falla con el Portal actual.
- **Hallazgos de QA sin cerrar del todo:** QA los evaluará.
  - F1: la cadena de imports de la estimación sigue sin cotejar.
  - F4: la captura automática depende de Playwright y Chromium.
  - F8: el texto del incidente de la propia historia.
