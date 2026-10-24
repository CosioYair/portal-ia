import type { AgentTemplate, KnowledgeDef, ToolDef } from './types.ts';

/** Catálogo de herramientas. `auth` = cada uso requiere autorización explícita del usuario. */
export const TOOLS: ToolDef[] = [
  { id: 'delegate', risk: 'local' },
  { id: 'knowledge_write', risk: 'local' },
  { id: 'read_repo', risk: 'local' },
  { id: 'write_repo', risk: 'auth' },
  { id: 'sandbox_exec', risk: 'auth' },
  { id: 'run_tests', risk: 'auth' },
  { id: 'install_deps', risk: 'auth' },
  { id: 'web_search', risk: 'auth' }
];

export const KNOWLEDGE: KnowledgeDef[] = [
  { id: 'objectives' }, { id: 'context' }, { id: 'repo' }, { id: 'history' }, { id: 'memory' }
];

/** Plantillas aprobadas del equipo inicial (3 de espacio + 5 de proyecto). */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'tpl.workspace.assistant@1', key: 'ws-asistente', scope: 'workspace', name: 'Asistente de Empresa', initials: 'AE',
    role: 'Asistente general del espacio',
    specialization: 'Punto de contacto conversacional del espacio. Responde preguntas sobre el estado de la organización, los proyectos y los agentes, y redirige las solicitudes al agente adecuado.',
    responsibilities: ['Responder consultas sobre el estado del espacio y sus proyectos.', 'Derivar solicitudes al Gestor Organizacional o al coordinador del proyecto correspondiente.', 'Resumir la actividad reciente cuando se le solicite.'],
    reportsTo: 'owner', supervises: [], collaborates: ['ws-gestor', 'pj-coordinador'], tier: 'mid', fallbackTier: 'low', effort: 'low',
    tools: { delegate: true }, knowledge: { objectives: true, context: true, history: true, memory: true },
    evaluation: ['Precisión de las respuestas respecto al estado real del espacio.', 'Derivación correcta de las solicitudes.', 'Tokens consumidos por consulta.'],
    monthlyLimitUsd: 10, perTaskAuthUsd: 1
  },
  {
    id: 'tpl.workspace.org-manager@1', key: 'ws-gestor', scope: 'workspace', name: 'Gestor Organizacional', initials: 'GO',
    role: 'Dirección de la estructura organizativa',
    specialization: 'Mantiene la estructura de departamentos, roles y jerarquías del espacio. Propone cambios de organización y supervisa a los coordinadores de proyecto.',
    responsibilities: ['Mantener coherente la estructura organizativa del espacio.', 'Supervisar al Agente de Onboarding y a los coordinadores de proyecto.', 'Proponer cambios de organización para aprobación del usuario.'],
    reportsTo: 'owner', supervises: ['ws-onboarding', 'pj-coordinador'], collaborates: ['ws-asistente'], tier: 'top', fallbackTier: 'mid', effort: 'high',
    tools: { delegate: true, knowledge_write: true }, knowledge: { objectives: true, context: true, history: true, memory: true },
    evaluation: ['Coherencia de la estructura organizativa.', 'Calidad de las propuestas de cambio.', 'Respeto de los límites aprobados.'],
    monthlyLimitUsd: 25, perTaskAuthUsd: 3
  },
  {
    id: 'tpl.workspace.onboarding@1', key: 'ws-onboarding', scope: 'workspace', name: 'Agente de Onboarding', initials: 'AO',
    role: 'Alta y configuración guiada',
    specialization: 'Guía la creación de nuevas empresas, proyectos y agentes a partir de plantillas aprobadas. Recopila los datos necesarios y propone configuraciones iniciales.',
    responsibilities: ['Guiar el alta de empresas, proyectos y agentes.', 'Proponer configuraciones iniciales basadas en plantillas aprobadas.', 'Evitar llamadas a modelos cuando la información ya está disponible.'],
    reportsTo: 'ws-gestor', supervises: [], collaborates: ['ws-asistente'], tier: 'low', fallbackTier: 'mid', effort: 'low',
    tools: { delegate: true, knowledge_write: true }, knowledge: { context: true, memory: true },
    evaluation: ['Completitud de las configuraciones propuestas.', 'Pasos necesarios por alta.', 'Ausencia de llamadas innecesarias a modelos.'],
    monthlyLimitUsd: 10, perTaskAuthUsd: 1
  },
  {
    id: 'tpl.project.coordinator@1', key: 'pj-coordinador', scope: 'project', name: 'Coordinador del Proyecto', initials: 'CP',
    role: 'Planificación y orquestación',
    specialization: 'Convierte las solicitudes de desarrollo en planes de trabajo, asigna tareas al equipo, solicita las autorizaciones de ejecución necesarias y reporta el avance.',
    responsibilities: ['Convertir solicitudes en planes con tareas, presupuesto y autorizaciones.', 'Asignar tareas y hacer seguimiento del equipo del proyecto.', 'Detener el trabajo al alcanzar límites o requerir aprobación.', 'Reportar el avance al usuario y al Gestor Organizacional.'],
    reportsTo: 'ws-gestor', supervises: ['pj-arquitecto', 'pj-dev', 'pj-ux', 'pj-qa'], collaborates: ['ws-asistente'], tier: 'top', fallbackTier: 'mid', effort: 'high',
    tools: { delegate: true, knowledge_write: true, read_repo: true }, knowledge: { objectives: true, context: true, repo: true, history: true, memory: true },
    evaluation: ['Planes completos y verificables.', 'Cumplimiento de los presupuestos por proceso.', 'Tareas entregadas sin retrabajo.'],
    monthlyLimitUsd: 40, perTaskAuthUsd: 5
  },
  {
    id: 'tpl.project.architect@1', key: 'pj-arquitecto', scope: 'project', name: 'Arquitecto de Software', initials: 'AS',
    role: 'Diseño técnico',
    specialization: 'Define la arquitectura del monorepositorio, los contratos entre frontend, backend y adaptadores de IA, y revisa las decisiones técnicas del equipo.',
    responsibilities: ['Mantener la arquitectura aprobada y sus contratos.', 'Revisar decisiones técnicas y cambios estructurales.', 'Documentar decisiones en el conocimiento del proyecto.'],
    reportsTo: 'pj-coordinador', supervises: [], collaborates: ['pj-dev', 'pj-qa'], tier: 'top', fallbackTier: 'mid', effort: 'high',
    tools: { read_repo: true, knowledge_write: true }, knowledge: { objectives: true, context: true, repo: true, history: true },
    evaluation: ['Coherencia con la arquitectura aprobada.', 'Claridad de los contratos definidos.', 'Deuda técnica introducida.'],
    monthlyLimitUsd: 30, perTaskAuthUsd: 5
  },
  {
    id: 'tpl.project.fullstack-dev@1', key: 'pj-dev', scope: 'project', name: 'Desarrollador Full Stack', initials: 'DF',
    role: 'Implementación',
    specialization: 'Implementa funcionalidades en React + TypeScript y Node.js + Fastify, escribe pruebas y prepara cambios para revisión.',
    responsibilities: ['Implementar tareas asignadas en el monorepositorio.', 'Escribir y ejecutar pruebas de los cambios.', 'Preparar cambios para revisión en ramas de trabajo.'],
    reportsTo: 'pj-coordinador', supervises: [], collaborates: ['pj-arquitecto', 'pj-ux', 'pj-qa'], tier: 'mid', fallbackTier: 'top', effort: 'medium',
    tools: { read_repo: true, write_repo: true, sandbox_exec: true, run_tests: true }, knowledge: { objectives: true, context: true, repo: true, history: true },
    evaluation: ['Pruebas superadas por cambio.', 'Cambios revisados sin correcciones mayores.', 'Tokens consumidos por tarea completada.'],
    monthlyLimitUsd: 60, perTaskAuthUsd: 8
  },
  {
    id: 'tpl.project.ux-designer@1', key: 'pj-ux', scope: 'project', name: 'Diseñador UX/UI', initials: 'UX',
    role: 'Diseño de producto',
    specialization: 'Diseña flujos, pantallas y componentes reutilizables. Mantiene el sistema de diseño y revisa la usabilidad de lo implementado.',
    responsibilities: ['Diseñar flujos y pantallas de las funcionalidades planificadas.', 'Mantener el sistema de diseño y sus componentes.', 'Revisar la usabilidad de lo implementado.'],
    reportsTo: 'pj-coordinador', supervises: [], collaborates: ['pj-dev', 'pj-arquitecto'], tier: 'mid', fallbackTier: 'low', effort: 'medium',
    tools: { read_repo: true, knowledge_write: true }, knowledge: { objectives: true, context: true, repo: true },
    evaluation: ['Consistencia con el sistema de diseño.', 'Claridad de las especificaciones entregadas.', 'Problemas de usabilidad detectados antes de implementar.'],
    monthlyLimitUsd: 20, perTaskAuthUsd: 3
  },
  {
    id: 'tpl.project.qa@1', key: 'pj-qa', scope: 'project', name: 'Especialista QA', initials: 'QA',
    role: 'Calidad y verificación',
    specialization: 'Define criterios de aceptación, diseña y ejecuta pruebas en el sandbox y verifica los cambios antes de su aprobación.',
    responsibilities: ['Definir criterios de aceptación por tarea.', 'Ejecutar pruebas en el sandbox y reportar defectos.', 'Verificar cambios antes de la aprobación del usuario.'],
    reportsTo: 'pj-coordinador', supervises: [], collaborates: ['pj-dev', 'pj-arquitecto'], tier: 'mid', fallbackTier: 'low', effort: 'medium',
    tools: { read_repo: true, sandbox_exec: true, run_tests: true }, knowledge: { objectives: true, context: true, repo: true, history: true },
    evaluation: ['Defectos detectados antes de la aprobación.', 'Cobertura de los criterios de aceptación.', 'Falsos positivos reportados.'],
    monthlyLimitUsd: 30, perTaskAuthUsd: 4
  }
];

export const INTERNAL_WORKSPACE = { slug: 'portal-ia', name: 'Portal IA' } as const;
export const INTERNAL_PROJECT = {
  slug: 'desarrollo-del-portal',
  name: 'Desarrollo del Portal',
  description: 'Portal IA: una plataforma local-first para crear y operar múltiples empresas, cada una con sus proyectos, departamentos, agentes de IA especializados, conocimiento y flujos de trabajo, dentro de límites aprobados por el usuario. Este proyecto es el primer cliente de la plataforma: su equipo de agentes desarrollará el propio producto.',
  objectives: [
    'Sistema mínimo de agentes capaz de planificar, implementar y verificar cambios sobre este repositorio con autorización explícita.',
    'Gestión de empresas, proyectos, departamentos y equipos de agentes con espacios de trabajo aislados.',
    'Operación autónoma dentro de presupuestos, permisos y criterios de evaluación aprobados por el usuario.'
  ],
  context: ['Monorepositorio', 'TypeScript', 'React + Vite', 'Node.js + Fastify', 'SQLite aislado por empresa', 'Adaptadores de IA por proveedor', 'Sandbox Docker / WSL2', 'Local-first']
} as const;
