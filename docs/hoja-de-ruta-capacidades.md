# Portal IA · Mapa de capacidades y hoja de ruta

> 31 de octubre de 2026. Acompaña a `docs/vision-producto.md`. Es una **propuesta priorizada**, no un backlog
> autorizado: cada épica se convierte en encargos o historias cuando el propietario la aprueba. Prioridad = valor de
> negocio × desbloqueo de dependencias ÷ riesgo.

## 1. Estado actual

### Implementado

| Capacidad | Dónde |
|---|---|
| Empresas y proyectos con equipo propio y repositorio registrado (cualquier carpeta git) | `services/companies.ts`, `routes/workspaces.ts` |
| Historias con pipeline completo: plan, revisión del plan, implementación incremental por unidades en worktree aislado, sandbox Docker, QA con evidencia, Gauntlet adaptativo, correcciones dirigidas | `storyExecution.ts`, `storyUnits.ts`, `storyPipeline.ts`, `gauntlet.ts` |
| Lotes autorizados de una vez | `batchRunner.ts` |
| Integración al aceptar (nuevo) | `batchRunner.ts`, `batchIntegration.ts` |
| Orden de integración explicado (nuevo) | `integrationOrder` en `packages/domain/src/batch.ts` |
| Puesta al día de candidatos con huella de cambios (nuevo) | `batchIntegration.ts` |
| Concurrencia por historia, carril de integración por repositorio, tiempo real, «Atrás» con contexto | `executionLocks.ts`, `repoLock.ts`, `live.ts`, `lib/nav.ts` |
| Encargos directos (sin historia) | `assignments.ts` |
| Pedir cambios sobre la misma rama (nuevo) | `prepareOwnerRound` |
| «Continuar» desde el chat (nuevo) | `ConversationPanel.tsx` |
| Asistente que lee el código del proyecto en solo lectura (nuevo) | `assistant.ts` |
| Carril propio del Asistente en Claude Code (nuevo) | `claudeCode/backend.ts` |
| Suscripción de Claude Code con topes de llamadas por proceso y por lote, sin cambio silencioso a la API | `claudeCode/callCap.ts`, `executionPolicy.ts` |
| Lecciones con procedencia, versión, alcance y validación del propietario; uso auditado en prompts | `lessons.ts` |
| Delegación con síntesis y cuestionamiento independiente | `delegation.ts` |
| Registro de decisiones en conversaciones | `conversations.ts` |
| Evaluación organizativa con propuestas, auditoría y deshacer | `orgEvaluation.ts`, `orgProposalApply.ts` |
| Descubrimiento de proyectos existentes en solo lectura (nuevo) | `projectDiscovery.ts`, `GET …/discovery` |

### Parcial

| Capacidad | Qué falta |
|---|---|
| Conocimiento (`knowledge`) | Solo añade; sin estado, aprobación ni alcance. El puente lo llama «aprobado» sin que nadie lo apruebe. |
| Verificación de proyectos externos | Comandos npm fijos e imagen Node única. La verificación mínima ya no da falso verde (corregido). La puerta de integración externa solo exige typecheck. |
| Bucle de desarrollo | El Desarrollador propone parches en texto y el Portal los aplica y verifica. No hay «editar → probar → corregir» dentro de una misma llamada. |
| Sesiones | Cada llamada de Claude Code empieza de cero (`--no-session-persistence`); el contexto se reconstruye. |
| Roles | Lista fija de roles de equipo y herramientas; el compositor de equipos solo sabe de desarrollo. |

### Falta

- Perfil de proyecto (comandos, imagen, puerta de integración, rutas protegidas propias).
- Ramas apiladas para historias dependientes.
- Entorno de previsualización del candidato (probar la interfaz antes de aceptar).
- Reuniones internas como entidad (objetivo, participantes, decisiones, acciones).
- Gobierno del conocimiento.
- Departamentos no técnicos.
- Conectores externos (imagen, vídeo, redes, analítica, anuncios).
- Medición de resultados de negocio.

## 2. Hoja de ruta priorizada

### Ahora (desbloquean lo demás; bajo riesgo)

**R1 · Perfil de proyecto**
- Comandos por etapa, gestor de paquetes, imagen del sandbox, puerta de integración y rutas protegidas propias.
- Se propone desde el descubrimiento y lo aprueba el propietario.
- Toca `types.ts` (proyecto), una migración aditiva, `sandbox.ts` (comandos e imagen), `verification.ts`,
  `storyMerge.ts` (puerta) y la interfaz de ajustes del proyecto.
- El perfil por defecto es el flujo npm actual: el propio Portal no cambia.
- *Valor:* Orbiventt y cualquier proyecto no-npm. *Riesgo:* medio (el sandbox).

**R2 · Bucle de desarrollo con herramientas del Portal**
- El Desarrollador recibe, por el puente MCP, herramientas validadas por el Portal:
  - `portal_write_file` / `portal_edit_file`: rutas protegidas, `writablePath`, sin secretos, solo su worktree;
  - `portal_run_check`: typecheck, prueba o build en el sandbox, contado y con plazo.
- Así itera explorar → editar → probar → corregir dentro de una llamada.
- Se conserva la sesión con `--resume` para continuaciones y correcciones.
- Sin herramientas nativas del anfitrión (sin Bash ni Edit de Claude Code fuera del puente). Todo cambio se confirma y
  verifica como hoy.
- *Valor:* el mayor salto hacia la capacidad práctica de Claude Code en la terminal. *Riesgo:* alto. Exige su propio
  Gauntlet de seguridad y una prueba controlada con la suscripción, autorizada aparte.

**R3 · Gobierno del conocimiento**
- Estado (propuesto, validado, obsoleto), alcance, procedencia, validado por quién y cuándo, y qué reemplaza.
- Solo lo validado llega a prompts y al puente.
- Se reutiliza el modelo de lecciones.

**R4 · Entorno de previsualización del candidato**
- Arrancar el Portal o el proyecto desde el worktree del candidato, aislado, con datos de prueba.
- Así el propietario prueba la interfaz antes de «Aceptar e integrar».

### Después

**R5 · Ramas apiladas para dependencias de un lote**
- La dependiente parte de la rama de su dependencia (lectura y plan desde ella).
- Se pone al día al integrarse esa dependencia, y se bloquea si se rechaza.
- Diseño en `docs/empresa-autonoma-lotes-y-asistente.md` §6.

**R6 · Reuniones internas**
- Entidad sin IA: objetivo, participantes, evidencia, decisiones, acciones con responsable y vencimiento, vínculos a
  historias o encargos.
- Se alimenta de la delegación y la evaluación organizativa; solo se convoca con un detonante medido (p. ej. conflictos
  de integración recurrentes).

**R7 · Incorporación guiada de proyectos existentes**
- Asistente de incorporación: descubrimiento → perfil → equipo y permisos propuestos → importación o reconstrucción del
  backlog.
- Primer caso real: Orbiventt, con autorización explícita para su carpeta.

**R8 · Proyecto nuevo desde una idea**
- Plantilla de «definición viva» (problema, usuarios, objetivos, alcance, restricciones, riesgos, éxito, presupuesto)
  sobre el registro de decisiones existente.
- Al aprobar el concepto: validación, arquitectura, equipo, backlog y hoja de ruta.

### Más adelante (con autorizaciones propias y terceros)

**R9 · Roles y flujos no técnicos**
- Composición de equipos por tipo de trabajo (investigación, contenido, campaña).
- Entregables no de código con su propia verificación (fuentes citadas, revisión editorial).

**R10 · Conectores de marketing**
- Imagen, vídeo, redes sociales, analítica y anuncios.
- Cada uno se evalúa (requisitos, coste, alcance de credenciales) y se autoriza aparte.
- Publicar y gastar siempre exigen permiso explícito.

**R11 · Medición y mejora continua**
- Métricas reales por proyecto y campaña: duración, defectos, conflictos, intervenciones, conversiones medidas.
- Propuestas de mejora con evidencia, nunca con datos inventados.

## 3. Lo que NO se hace sin autorización aparte

- Acceder o modificar el repositorio de Orbiventt (u otro externo).
- Activar conectores externos.
- Crear credenciales.
- Publicar contenido.
- Gastar en anuncios.
- Probar R2 con llamadas reales a la suscripción.
- Conceder permisos nuevos a agentes.

Que algo figure en esta hoja de ruta no lo autoriza.
