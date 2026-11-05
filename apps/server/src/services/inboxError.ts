/**
 * Error con código HTTP para que la ruta lo traduzca tal cual. Vive en su propio módulo, sin dependencias, para que
 * storyClosure.ts pueda heredarlo sin cerrar el ciclo inbox → delegation → storyPipeline → storyClosure → inbox: con
 * ese ciclo, `extends InboxError` se evaluaba antes de inicializar la clase cuando se cargaba primero storyExecution.ts.
 */
export class InboxError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
