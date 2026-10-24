// Textos de UI en español para identificadores de dominio.
export const TOOL_LABELS: Record<string, { name: string; desc: string }> = {
  delegate: { name: 'Delegación de tareas', desc: 'Asignar tareas a otros agentes dentro de su ámbito.' },
  knowledge_write: { name: 'Escritura en el conocimiento', desc: 'Guardar notas y decisiones en el conocimiento del proyecto.' },
  read_repo: { name: 'Lectura del repositorio', desc: 'Leer archivos del repositorio registrado.' },
  write_repo: { name: 'Escritura en el repositorio', desc: 'Crear ramas de trabajo y proponer cambios para revisión.' },
  sandbox_exec: { name: 'Ejecución en sandbox', desc: 'Ejecutar comandos en el entorno aislado (Docker / WSL2).' },
  run_tests: { name: 'Ejecución de pruebas', desc: 'Lanzar la batería de pruebas del proyecto en el sandbox.' },
  install_deps: { name: 'Instalación de dependencias', desc: 'Añadir o actualizar paquetes del monorepositorio.' },
  web_search: { name: 'Acceso a red', desc: 'Consultar documentación y recursos externos.' }
};
export const KNOWLEDGE_LABELS: Record<string, string> = {
  objectives: 'Objetivos del proyecto',
  context: 'Contexto aprobado (arquitectura y alcance)',
  repo: 'Repositorio registrado (solo lectura)',
  history: 'Historial de ejecución',
  memory: 'Memoria persistente del espacio'
};
export const EFFORT_LABELS: Record<string, string> = { low: 'Bajo', medium: 'Medio', high: 'Alto' };
export const INIT_STEP_LABELS: Record<string, { title: string; sub: string }> = {
  workspace: { title: 'Crear el espacio interno «Portal IA»', sub: 'Espacio aislado de futuras empresas y clientes, con base de datos local propia.' },
  project: { title: 'Crear el proyecto «Desarrollo del Portal»', sub: 'Proyecto interno dedicado a construir la plataforma.' },
  objectives: { title: 'Preparar objetivos y contexto aprobado', sub: 'Objetivos iniciales, arquitectura y alcance que los agentes podrán consultar.' },
  persistence: { title: 'Crear estructuras persistentes', sub: 'Conocimiento, historial de ejecución y memoria versionada del espacio.' },
  team: { title: 'Preparar el equipo inicial desde plantillas aprobadas', sub: '3 agentes del espacio y 5 del proyecto. Configurados e inactivos; sin llamadas a modelos.' }
};
export const INIT_STEP_ORDER = ['workspace', 'project', 'objectives', 'persistence', 'team'] as const;
export const fmtUsd = (n: number) => n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USD';
export const BACKLOG_STATUS: Record<string, { label: string; tone: '' | 'ok' | 'warn' | 'err' | 'accent' }> = {
  pending: { label: 'Pendiente', tone: '' }, in_progress: { label: 'En ejecución', tone: 'warn' }, review: { label: 'Para revisar', tone: 'accent' }, done: { label: 'Completada', tone: 'ok' }, blocked: { label: 'Bloqueada', tone: 'err' }, discarded: { label: 'Descartada', tone: '' }
};
