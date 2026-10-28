import type { Agent, BacklogItem } from '@portal-ia/domain';

/** Textos de los prompts de una historia (compartidos por la ejecución, la reparación de la entrega y las correcciones). */
export const CONVENTIONS = `Convenciones del repositorio: monorepositorio npm workspaces; TypeScript estricto con ESM e imports con extensión .ts/.tsx; dominio compartido en packages/domain (tipos y plantillas, sin IO); adaptadores en packages/ai-adapters (toda llamada a modelos pasa por complete() y registra tokens/costo); backend Fastify en apps/server (rutas delgadas que validan con zod y delegan en services/; una base SQLite por espacio vía node:sqlite); frontend React 19 + Vite en apps/web (pantallas en src/screens, componentes en src/components, textos en español, estados explícitos, ninguna acción con costo sin autorización explícita en la UI). Pruebas: node --test en apps/server/test. No introducir dependencias nuevas salvo necesidad justificada.`;

export const DEV_MAX_TOKENS = 16000;

export function sys(agent: Agent, project: { name: string; description: string }, story: BacklogItem): string {
  return `Eres «${agent.config.name}», ${agent.template.role.toLowerCase()} del proyecto «${project.name}» en Portal IA.
Especialización: ${agent.config.specialization}
Responsabilidades: ${agent.config.responsibilities.map(r => '- ' + r).join('\n')}
Contexto del proyecto: ${project.description}
Historia a ejecutar: ${story.storyId} · ${story.title}
Criterio de aceptación: ${story.criterion || '(no definido; propón uno verificable)'}
${story.description ? `Detalle del propietario: ${story.description}` : ''}
${CONVENTIONS}
Responde en español. Cuando se te pida JSON, responde SOLO con JSON válido, sin texto alrededor ni bloques de código.`;
}

export const FILE_FORMAT = `=== RESUMEN ===
(2-6 frases: qué se hizo y por qué)
=== ARCHIVO: ruta/relativa/al/repo | create ===
(contenido íntegro del archivo, tal cual, sin cercas de código)
=== FIN ARCHIVO ===
=== ARCHIVO: otra/ruta.ts | modify ===
(contenido íntegro final; úsalo solo para archivos pequeños o reescritos casi por completo)
=== FIN ARCHIVO ===
=== ARCHIVO: archivo/grande.ts | patch ===
<<<< BUSCAR
(fragmento EXACTO del archivo actual, con suficientes líneas de contexto para ser único)
==== REEMPLAZAR
(el fragmento nuevo que lo sustituye)
>>>> FIN
(puedes poner varios bloques BUSCAR/REEMPLAZAR en el mismo archivo)
=== FIN ARCHIVO ===
=== ARCHIVO: ruta/a/borrar.ts | delete ===
=== FIN ARCHIVO ===
=== VERIFICAR: typecheck, test, build ===
=== PARA EL PROPIETARIO ===
(OBLIGATORIO, en lenguaje llano y sin tecnicismos, 3-8 líneas: qué cambia para quien usa el Portal y DÓNDE lo verá —menú, botón, pantalla o ruta exacta— tras integrar y reconstruir. Si no hay nada visible, dilo: "sin cambios visibles; afecta a X por dentro".)
=== PRUEBA MANUAL ===
(OBLIGATORIO: lista numerada de 3-10 pasos concretos que el propietario seguirá en el Portal para comprobar que la historia funciona. Cada paso: acción + resultado esperado. Ej.: "1. Abre Backlog y pulsa «Ejecutar» en una historia pendiente. Esperado: se abre el diálogo con la estimación.")
=== COMPROBACIONES ===
(OBLIGATORIO si el cambio es observable desde fuera: 1-4 comprobaciones automáticas que el Portal ejecutará contra sí mismo una vez activado el cambio. Una por línea:
- http GET /ruta | texto o /expresión regular/ que debe contener la respuesta
- ui /ruta | selector CSS | texto o /expresión regular/ que debe contener ese elemento
Ej.: "- http GET /api/system/status | version" · "- ui /backlog | h1 | /\\(\\d+ abiertas\\)/". Si nada es observable, escribe "- ninguna: <motivo>".)
=== NOTAS ===
(opcional: decisiones, riesgos, pasos manuales)
Reglas: la acción es create, modify, patch o delete; PREFIERE patch para modificar archivos existentes (mucho más rápido y barato) y modify solo para archivos pequeños; cada archivo abre con "=== ARCHIVO:" y cierra con "=== FIN ARCHIVO ==="; nada fuera de estos bloques salvo RESUMEN, PARA EL PROPIETARIO, PRUEBA MANUAL, COMPROBACIONES, VERIFICAR y NOTAS. Para renombrar: delete del antiguo + create del nuevo. Puedes tocar cualquier archivo del repositorio salvo .git, data/, node_modules y archivos de secretos (.env reales, claves).
Si después de analizarlo la historia NO requiere cambios de código, no inventes cambios: responde solo con "=== RESUMEN ===" y "=== SIN CAMBIOS ===" seguido del motivo verificable.
Si NO puedes implementarla porque te falta algo que no está en tu contexto, no escribas una explicación libre ni código a medias: responde solo con
=== RESUMEN ===
(1-2 frases)
=== BLOQUEO ===
tipo: informacion | permiso | capacidad
necesito: (qué te falta exactamente: un archivo con su ruta, un dato, una decisión, un permiso o una herramienta)
pregunta: (la pregunta concreta que lo resolvería)
consultar: (agente o papel del equipo que podría saberlo, o «ninguno»)
El equipo te dará ese contexto (o se lo preguntará al especialista o al propietario) y volverás a intentarlo. Los datos reales del propietario (carpeta data/, credenciales, .env) NO son accesibles para ningún agente.`;

/** Formato reducido para reparaciones y correcciones (sin repetir las secciones para el propietario si ya llegaron). */
export const PATCH_ONLY_FORMAT = `=== RESUMEN ===
(1-3 frases: qué corriges)
=== ARCHIVO: ruta/relativa | patch ===
<<<< BUSCAR
(fragmento EXACTO del archivo ACTUAL que se te muestra, con contexto suficiente para ser único)
==== REEMPLAZAR
(fragmento corregido)
>>>> FIN
=== FIN ARCHIVO ===
(para archivos nuevos: "=== ARCHIVO: ruta | create ===" con el contenido íntegro y "=== FIN ARCHIVO ===")
Reglas: solo bloques de archivo y RESUMEN; nada de explicaciones fuera de ellos; copia el texto a buscar tal cual aparece en el archivo actual.`;
