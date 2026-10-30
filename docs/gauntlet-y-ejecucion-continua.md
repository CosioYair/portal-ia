# Gauntlet, ejecución continua del backlog, comunicación y aprendizaje

Fecha: 30 de octubre de 2026. Un solo sistema de ejecución: el **pipeline de historias existente**
(`services/storyPipeline.ts`) hace el trabajo; el Evaluador Gauntlet critica, el coordinador de lotes encadena historias,
la telemetría mide y las lecciones aprenden. No hay un segundo motor de historias ni un marco de agentes aparte.

## 1 · Calidad: Gauntlet en el pipeline

**Método.** Objetivo → constructor → crítico independiente → evidencia → corrección dirigida → re-evaluación, acotado.

**Rol.** «Evaluador Gauntlet» (`GAUNTLET_TEMPLATE`, `tpl.project.gauntlet@1`, clave `pj-gauntlet`, en
`packages/domain/src/gauntlet.ts`):
- Jefe: el Coordinador. Colabora con QA. Capacidad `evaluar_gauntlet`.
- Herramientas: solo `read_repo`. Nivel medio, esfuerzo medio, límites mensual y por tarea propios.
- Plantilla versionada: las prácticas promovidas crean versiones nuevas.
- **No se crea solo:** existe en un proyecto únicamente con tu aprobación
  (`POST /api/workspaces/:slug/projects/:pid/gauntlet/evaluator` con `authorized: true`, uno por proyecto).
- Nunca implementa ni se autoevalúa: si su paso apunta al implementador, no se evalúa.

**Orden de las comprobaciones** (sin pagar dos veces la misma revisión):

| Etapa | Qué hace | Quién |
|---|---|---|
| Verificación determinista | typecheck / test / build en Docker, siempre; no se repite para el mismo commit | sandbox |
| QA | una revisión por commit | Revisor |
| Gauntlet | tras la aprobación de QA, según el modo | Evaluador |
| Re-evaluación | tras una corrección del Evaluador; QA **no** repite la revisión | solo el Evaluador |
| Comprobaciones en ejecución | tras activar | Portal |
| Aceptación | siempre aparte | tú |

**Contexto nuevo.** El Evaluador recibe:
- objetivo, criterios, restricciones y entregables;
- evidencia objetiva (verificaciones y pruebas) y el diff;
- las rondas anteriores.

Nunca recibe el razonamiento del constructor. Sus afirmaciones («para el propietario», prueba manual) llegan marcadas
como **no evidencia**.

Responde con salida estructurada (`GAUNTLET_SCHEMA`): veredicto, criterios con su evidencia, hallazgos con gravedad,
archivo, evidencia y lo esperado, la mayor brecha, si otra ronda compensa, y limitaciones. Lo que no puede comprobar
(p. ej. el aspecto visual sin capturas) lo marca como no verificable y lo dice; no inventa certeza.

**Puerta de evidencia.** Un hallazgo sin evidencia se registra, pero no motiva correcciones.

**Decisión determinista** (`decideGauntlet`). En cada ronda se elige una de tres salidas:
- **Pasa.**
- **Corrige:** hasta 3 brechas bloqueantes o mayores, la más grave primero. La corrección la hacen las unidades
  dirigidas del Desarrollador, sin repetir el plan ni regenerar archivos.
- **Se detiene** por cualquiera de estos motivos:
  - el límite de rondas;
  - la misma brecha tras corregirla (sin progreso);
  - la ganancia marginal;
  - que no quedan correcciones autorizadas.

Si se detiene con brechas bloqueantes, el pipeline se pausa (`gauntlet`) con lo pendiente y su evidencia. Puedes
conceder otra ronda (máx. 3), seguir sin más evaluación (sin IA; queda documentado) o iterar. El presupuesto, la
suscripción, la cancelación y la duración son las paradas de siempre del pipeline.

**Modos** (por proyecto y por tarea):

| Modo | Evaluaciones | Correcciones |
|---|---|---|
| `off` | ninguna | ninguna (llamadas de siempre) |
| `standard` | 1–2 | 0–1 |
| `deep` | hasta 3 | 2 por defecto; tope 3 |

`recommendGauntlet` recomienda sin IA según tamaño, riesgo (vocabulario: seguridad, permisos, presupuesto, git,
organización…) e historial (iteraciones, rechazos de QA). Una tarea pequeña y sin riesgo → `off`. El modo, la
recomendación con sus motivos, el sobrecoste máximo y quién evalúa se muestran **antes** de autorizar.

**Trazabilidad.** Cada ronda es un paso `evaluator` en `process_steps`. `result.gauntlet` guarda rondas, criterios,
hallazgos, decisión, motivo, costo y tokens; los eventos `gauntlet` van en el pipeline. Informe en el proceso.

## 2 · Ejecución continua del backlog (lotes)

**Autorización** (`BatchAuthorization`, `packages/domain/src/batch.ts`): explícita, persistida, auditable (eventos) y
revocable. Fija:
- historias y su orden;
- orígenes de ejecución permitidos (nunca se cambia a otro facturable);
- presupuesto total y por historia;
- duración y correcciones;
- modo Gauntlet;
- concurrencia (1–3);
- tope de llamadas a la suscripción de Claude Code (no se asume ilimitada);
- comandos e instalación;
- operaciones git: integrar, activar y publicar. **Publicar está desactivado por defecto y nunca se activa solo.**

Un lote activo por proyecto.

**Plan sin IA** (`planBatch`): dependencias (`dependsOn`) primero y, a igualdad, tu orden. Las historias se agrupan en
oleadas independientes. Ciclos y dependencias externas sin terminar quedan bloqueados con su motivo; nunca se omiten
en silencio.

**Coordinador** (`services/batchRunner.ts`, determinista):
1. Por historia: `createStoryProcess` con el modo Gauntlet del lote, autorización con los límites del lote y `runStory`
   (el pipeline de siempre: worktree, Docker, QA, Gauntlet, correcciones).
2. Candidato de integración sin IA si `main` avanzó; integración de una en una (`services/storyMerge.ts`, la misma que
   la manual).
3. Activación del Portal interno solo con nada en marcha, con comprobación en ejecución al volver.
4. Siguiente historia elegible.

Fuera del lote se mantiene «un proceso a la vez».

**Fallos.** El límite de la suscripción o un sandbox caído pausan **todo** el lote. Lo demás pasa a `needs_owner` y las
historias independientes siguen; las dependientes de una fallida quedan `blocked`.

**Reinicios.** Una historia interrumpida sin llamadas en curso se retoma sola una vez. Con cobro incierto, decides tú;
nunca se reenvía una llamada posiblemente facturada.

**Aceptación del propietario**, distinta de QA. La historia pasa por estos estados:
- terminada técnicamente → `awaiting_acceptance`;
- aceptar una o varias (con los pasos marcados) → `accepted`;
- no aceptar → `rejected`, con tareas creadas a partir de los pasos que fallaron;
- iterar **solo esa** historia dentro del lote, sobre el `main` vigente y conservando la evidencia;
- reabrir.

**Interfaz.** «Ejecución continua» (`/lotes`): asistente, vista previa del plan, monitor (progreso, historia y agentes
activos, bloqueadas, decisiones pendientes, presupuesto, llamadas a la suscripción, último punto de control) con
Pausar / Reanudar / Cancelar / Revocar, y revisión de aceptación.

## 3 · Comunicación y rendimiento

**Línea base** (14 procesos reales, solo lectura de la API, antes de cambiar nada):

| Medida | p50 | p95 |
|---|---|---|
| Autorización → primer paso | 11 ms | 21 ms |
| Plan, llamada | 78 s, ~214 k tokens de entrada | 102 s, ~374 k |
| Implementación, llamada | 42 s, ~100 k | 160 s, ~463 k |
| Consulta (~2 por historia), llamada | 37 s | — |
| QA, llamada | 32 s | — |
| `test` en Docker | 117 s | — |
| Entrada por historia | 1,33 M tokens | 3,2 M |

El Portal no es el cuello de botella (≈ 0–0,2 min por historia limpia). Dominan las llamadas al modelo (contexto
grande, exploración en varios turnos) y las ejecuciones repetidas de `test`.

**Telemetría por llamada** (`call_metrics`, `GET /api/workspaces/:slug/metrics/calls`):
- espera del modelo frente a preparación del Portal;
- tokens, incluida la caché, turnos y herramientas (lecturas del repositorio por MCP);
- llamadas repetidas con el mismo prompt, fallos por clase;
- p50/p95 solo con 10 muestras o más;
- **secciones del contexto recibido** por llamada y, por papel, cuáles pesan más.

**Trabajo duplicado.**
- Verificación y QA no se repiten para el mismo commit (ya existía; un commit nuevo vuelve a verificarse).
- El Evaluador no re-evalúa un commit decidido.
- QA no repite tras una corrección del Evaluador.
- Una caché de verificación aparte no aportaría nada (medido).

**Paralelismo.** Las consultas de especialistas son independientes y van en paralelo **solo** si el presupuesto restante
cubre todas a la vez con su estimación máxima. La estimación cuenta el sistema real, con lecciones y prácticas, y el
precio de la API si Claude Code puede ceder a ella. Mismas llamadas, mismo resultado y mismo orden. Las unidades de
implementación, dependientes entre sí, siguen en serie; la integración, siempre de una en una.

**Antes / después** (proveedor simulado con latencias fijas; **no** prueba el comportamiento de un modelo real):

| Medida | Antes | Después |
|---|---|---|
| Historia con 2 consultas, duración total | 4,97 s / 4,84 s / 4,89 s | 3,36 s / 3,32 s / 3,30 s |
| Fase de consultas | 3,0 s | 1,5 s |
| Llamadas | 15 | 15 |
| Historias verificadas | 3 de 3 | 3 de 3 |

## 4 · Aprendizaje

Las brechas del Evaluador entran en el ciclo de lecciones existente (`services/lessons.ts`, detector `gauntlet_gap`).

**Detección.** Solo cuentan los hallazgos bloqueantes o mayores **con evidencia**, y solo cuando su resultado está
decidido:
- «corregida en la ronda N»;
- «persistió tras la corrección»;
- «sin corregir: …».

Una corrección en curso se detecta en la siguiente parada.

**Qué se registra:** qué falló, evidencia, archivo, criterio, quién evaluó, ronda y modo, el agente y el papel
implicados y el proyecto.

**Ciclo:**
1. Detectada: nunca se inyecta sin validar.
2. Propuesta: una llamada de IA, con autorización.
3. Validada por ti.
4. Aplicada: se inyecta al implementador, también en la corrección dirigida. No llega al Evaluador, que conserva su
   contexto nuevo.
5. Medida: usos por paso y reincidencias; con la lección presente, la misma clase de brecha la marca «candidata a
   obsoleta».

Medir no cambia nada solo. Promoverla a práctica crea una versión nueva de la plantilla; los agentes existentes no
cambian hasta que los actualices.

## 5 · Pruebas (proveedor y CLI simulados, 0 USD)

| Archivo | Escenarios |
|---|---|
| `gauntlet.test.ts` | A, B, C, D, E, Q, R + modo `off`, sin Evaluador y recomendación |
| `batch-execution.test.ts` | F–Q, activación serializada, «depende de» |
| `performance.test.ts` | S, T |
| `call-metrics.test.ts` | telemetría |

## 6 · Limitaciones

- **Sin validación con un modelo real.** Lo simulado no prueba el comportamiento real; ver el plan de prueba en
  `IMPLEMENTATION_HANDOFF.md`.
- **El Evaluador no recibe capturas del navegador.** Evalúa el diff y la evidencia del sandbox; lo visual queda como no
  verificable. Las comprobaciones en ejecución siguen siendo posteriores a la activación.
- **La reincidencia de `gauntlet_gap` se cuenta por detector,** no por brecha concreta: es conservadora (pide revisión,
  no cambia nada).
- **El tamaño del contexto se mide, pero no se recorta.** Ya se sabe qué secciones pesan más por papel; recortar es el
  siguiente paso, con antes/después real.
- **No hay escalado automático de modelo o esfuerzo.** Siguen configurándose por agente, como antes.
- **No activo en el Portal en marcha** hasta reconstruir y reiniciar con tu autorización. El esquema 0.15 copia `data/`
  antes de migrar.
