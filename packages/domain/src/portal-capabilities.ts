import { GAUNTLET_LIMITS } from './gauntlet.ts';

/**
 * Lo que el Portal hace HOY, en un texto compacto y versionado que reciben el Asistente y los especialistas que trabajan
 * sobre el propio Portal (para no describirlo de memoria ni negar lo que existe). Cambia la versión al cambiar una
 * capacidad; una prueba acota su tamaño (no crece sin límite).
 */
export const PORTAL_CAPABILITIES_VERSION = 'portal-capabilities@1';
export const PORTAL_CAPABILITIES = `# Qué hace hoy el Portal (${PORTAL_CAPABILITIES_VERSION})
- Código: una historia del backlog (HU-n) o un encargo de desarrollo del propietario (EN-n, sin historia, de cualquier tamaño). Mismo pipeline autorizado: plan → worktree aislado con rama propia → typecheck/test/build en el sandbox (Docker/WSL2; sin él, bloqueado) → QA con evidencia → Gauntlet → «listo para tu revisión». Nunca integra, activa ni publica solo.
- Gauntlet: un Evaluador independiente, con contexto nuevo (sin la explicación del constructor), contrasta cada criterio con la evidencia. Modo por proyecto o por tarea: sin, estándar, profundo o automático (adaptativo: el Portal elige la intensidad por tamaño, riesgo e historial y dice por qué). Antes de implementar revisa el plan (si compensa); hace correcciones solo mientras hay progreso; si una brecha se repite, otro especialista hace el diagnóstico de la causa; tope duro de ${GAUNTLET_LIMITS.deep} correcciones.
- Lotes (/lotes): varias historias con UNA autorización (orden, equipo, presupuesto, tope de llamadas, Gauntlet); el coordinador del lote (sin IA) respeta dependencias, no detiene lo independiente si algo falla y deja cada historia esperando tu aceptación.
- Suscripción: con Claude Code se consumen llamadas de la suscripción, contadas contra el tope autorizado (0 USD de API); con la API, USD contra el presupuesto autorizado.
- Análisis delegado: un agente responsable estudia y entrega un documento (Conocimiento) con propuestas al backlog que aplicas tú; nunca cambia código. En una conversación: decisiones → propuesta cuestionada → revisión del equipo → borradores de historias.
- Etapas distintas de un cambio: análisis, propuesta, historias, implementación, verificación, QA, Gauntlet, integración en main, activación (Portal en marcha) y publicación.`;
