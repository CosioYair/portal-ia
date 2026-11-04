import { GAUNTLET_LIMITS } from './gauntlet.ts';

/**
 * Lo que el Portal hace HOY, en un texto compacto y versionado que reciben el Asistente y los especialistas que trabajan
 * sobre el propio Portal (para no describirlo de memoria ni negar lo que existe). Cambia la versión al cambiar una
 * capacidad; una prueba acota su tamaño (no crece sin límite).
 */
export const PORTAL_CAPABILITIES_VERSION = 'portal-capabilities@2';
export const PORTAL_CAPABILITIES = `# Qué hace hoy el Portal (${PORTAL_CAPABILITIES_VERSION})
- Código: historia (HU-n) o encargo (EN-n, sin historia, de cualquier tamaño) que el Asistente prepara y supervisa. Pipeline autorizado: plan → worktree aislado → typecheck/test/build en el sandbox (Docker/WSL2; sin él, bloqueado; lo que ya fallaba en la base no se carga al cambio) → QA → Gauntlet → diff y evidencia en el chat. Nunca integra, activa ni publica solo.
- Asistente: lee el repositorio (solo lectura) y ejecuta de verdad typecheck/test/build sobre main (run_checks) con tu autorización; crea historias solo si las pides.
- Gauntlet: Evaluador independiente con contexto nuevo; contrasta cada criterio con la evidencia; revisa el plan antes de implementar (si compensa). Modo sin, estándar, profundo o automático (elige la intensidad por tamaño, riesgo e historial). Corrige solo mientras hay progreso; una brecha repetida la diagnostica otro especialista; tope duro de ${GAUNTLET_LIMITS.deep} correcciones.
- Lotes (/lotes): varias historias con UNA autorización; respeta dependencias y deja cada historia esperando tu aceptación.
- Suscripción: Claude Code consume llamadas de la suscripción contra el tope autorizado (0 USD de API); la API, USD contra el presupuesto.
- Análisis delegado: un agente entrega un documento (Conocimiento) con propuestas que aplicas tú; nunca cambia código.
- Lecciones: «aprendida» solo cuando una tarea posterior la demuestra; si su error vuelve con ella, se retira.
- Etapas de un cambio: análisis, propuesta, historias, implementación, verificación, QA, Gauntlet, integración en main, activación (Portal en marcha) y publicación.`;
