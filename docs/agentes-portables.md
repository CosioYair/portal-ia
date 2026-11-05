# Agentes portables · contrato `portal-ia/agent@1`

> Un agente es una **identidad persistente que es del propietario**, no un modelo. Su definición vive en una carpeta local,
> legible fuera del Portal y transportable entre arneses (Claude Code, Codex, la API…). La base de datos del Portal sigue
> siendo la fuente de verdad **operativa**: estado, ejecuciones, autorizaciones, contabilidad, arnés y permisos concedidos.

Código: `packages/domain/src/portable-agent.ts` (contrato puro), `apps/server/src/services/agentFolders.ts` (carpetas y
revisiones), `agentIdentity.ts` (lo que llega al prompt), `agentLearning.ts` (memoria), `agentCreation.ts` (crear, importar,
exportar), `agentZipImport.ts` (importar desde ZIP con fusión a tres bandas). Pruebas:
`apps/server/test/sistema-operativo-agentes.test.ts`, `apps/server/test/agente-zip-import.test.ts`.

## 1. La carpeta

`<datos>/workspaces/<empresa>/agents/<clave>-<id8>/` — el nombre es único, ASCII y **estable** (no cambia si el agente se
renombra; el id de verdad está dentro de `agent.yaml`). Si ya existe algo en disco con ese nombre, se respeta y se usa el
siguiente libre: **nunca** se adopta en silencio una carpeta que no escribió el Portal. Nunca se escribe a través de un enlace
(symlink o junction): la carpeta del agente debe ser una carpeta real dentro de `agents/`.

```
agent.yaml            identidad y preferencias (abajo)
AGENTS.md             instrucciones propias (convención AGENTS.md: la leen personas, Codex y Claude Code)
skills/<slug>/SKILL.md   habilidades: frontmatter name/description (formato de Agent Skills) + cuerpo
memory/MEMORY.md      SOLO aprendizaje verificado por el propietario, cada entrada con su procedencia
knowledge/<slug>.md   referencias aprobadas
```

`agent.yaml` (YAML de un subconjunto estricto y documentado: mapas de bloque, listas de escalares, escalares planos o entre
comillas; nada de anclas, etiquetas, bloques literales ni colecciones en línea; un error dice la línea, nunca se adivina):

```yaml
# Agente portable de Portal IA (portal-ia/agent@1). Sin credenciales: los permisos los concede el propietario en el Portal.
schema: portal-ia/agent@1
id: 3f2c…                     # id estable del agente
name: Lucía, Marketing
role: Estrategia y campañas
department: marketing
initials: LM
summary: Investiga audiencias y canales…
responsibilities:
  - Analizar la audiencia y los canales adecuados
deliverables:
  - Plan de campaña
capabilities:
  - consultar
harness:
  preferred: claude-code      # claude-code | claude-code-terminal | codex | api
  model: claude-sonnet-5-5
  effort: medium
permissions:
  tools:
    - knowledge_write
  autonomy: ask               # ask | within_scope
created: 2026-11-02T…
```

**Nunca** hay credenciales: escribir o importar una carpeta con algo que parezca una clave (Anthropic, OpenAI, GitHub, AWS,
Google, Slack, JWT, `access_token=…`, claves privadas) se rechaza. Lo que declara `permissions` y `harness` es una
**petición**: solo el propietario concede permisos y arnés, en el Portal.

## 2. Revisiones (consistencia archivo ↔ base)

- Cada versión adoptada es una fila de `agent_revisions` con **todos** sus archivos: volver atrás no depende del disco.
- Escritura en dos fases: fila «writing» → archivos (temporal + rename) → «adopted». Si el servidor muere en medio, la
  siguiente lectura adopta la revisión si el disco quedó igual o la abandona si no (`resolveWriting`). Nada se pierde ni se
  aplica en silencio.
- Un cerrojo por agente serializa las escrituras; editar la identidad exige la revisión que viste (`expectN`, 409 si cambió).
- Adoptar un cambio externo o volver atrás es atómico para el propietario: todo bajo el cerrojo, y si algo falla la fila del
  agente queda exactamente como estaba (lo que leen los prompts nunca queda a medias). Una escritura fallida repone en disco la
  revisión adoptada para que no parezca un cambio externo.
- La huella (`hashFiles`) normaliza BOM, CRLF y Unicode (NFC): un editor de Windows que solo cambia saltos de línea no
  «cambia» la carpeta.
- **Los prompts usan siempre una revisión adoptada (de la base), nunca lo que haya en disco.** Un trabajo nuevo fija la
  revisión con la que se creó (`pins` del encargo).

## 3. Cambios hechos fuera del Portal

Si el disco no coincide con la revisión adoptada, el agente aparece «Te necesita» y su pestaña **Archivos** muestra el diff:
- **Adoptar** (con la huella de lo revisado: si la carpeta vuelve a cambiar, se revisa otra vez): nombre, papel, resumen,
  responsabilidades, departamento, instrucciones, habilidades, entregables y referencias pasan a la nueva revisión. **No se
  adoptan nunca** desde la carpeta: arnés, modelo, esfuerzo, herramientas, autonomía, capacidades, id ni memoria (se reponen
  desde la base y se dice por qué).
- **Descartar**: la carpeta vuelve a la revisión adoptada.
- Mientras no se resuelva, el Portal no escribe encima (409).
- Una carpeta borrada fuera del Portal se restaura desde la revisión adoptada.

Si el agente se editó fuera y vuelve como **ZIP** (§7), no hace falta revisar a mano. Lo que solo cambió fuera se adopta
**automáticamente** como revisión nueva de origen `import`, con la nota «Importado desde ZIP (adoptado automáticamente)»,
y se ofrece **Deshacer**. Deshacer crea una revisión `restore` igual a la anterior y retira la memoria creada por esa
importación. Los prompts vuelven a usar lo de antes. Si después hubo otra revisión, ya no se puede deshacer (409).

## 4. Memoria verificada

Una sola fuente: las lecciones del Portal (`lessons`) con `agent_id`. Flujo: opinión del propietario sobre un entregable o
una respuesta → **propuesta** ligada a esa tarea o mensaje → el propietario la **verifica** (puede editarla) → entra en los
prompts de ese agente y en `memory/MEMORY.md` con su procedencia → se puede retirar. Nada generado por un modelo se verifica
solo, y editar `MEMORY.md` a mano no crea memoria verificada. Las lecciones de un agente no aparecen en las listas ni en las
inyecciones de la organización (todas las existentes tienen `agent_id` NULL).
Excepción acotada: al importar el ZIP de un agente **que ya existe**, las entradas nuevas de su `MEMORY.md` (las que no
estaban al exportar ni existen ya) pasan a ser lecciones verificadas de ese agente. Llevan la evidencia del ZIP y la
etiqueta `zip`, y Deshacer las retira. Para un agente nuevo, la memoria importada sigue llegando como propuesta.
Decisión del propietario (HU-183): la confirmó en el criterio de aceptación («si ya existe, lo que cambió fuera —memoria,
habilidades, CAMBIOS.md— se incorpora automáticamente como revisión nueva con Deshacer») y en el detalle de la historia
(«se adoptan automáticamente salvo conflicto»). La razón es que la memoria de ese agente ya es del propietario: la exportó
él y la trae de vuelta él. Límites de la excepción:
- solo vale para un agente de este mismo espacio (un marcador de otro espacio lo trata como nuevo);
- entran como mucho 50 entradas;
- nunca entra una que ya estaba al exportar o que ya existe;
- lo que entró se ve en la vista previa antes de confirmar y queda en `imported_zip` con sus `lessonIds`;
- Deshacer o un fallo al escribir la revisión las retiran.
Si el propietario cambia de criterio, basta con usar `'proposed'` en `applyZipImport` (`setLessons`) y ajustar
`agente-zip-import.test.ts`.

## 5. Lo que llega al prompt

`identityBlock()` añade, **solo si existen**: instrucciones propias (no las generadas por defecto), habilidades (nombre,
descripción y un extracto) y memoria verificada; acotado a ~10 000 caracteres y con la advertencia de que no amplía permisos.
Para los agentes existentes (sin contenido propio) está vacío: **sus prompts no cambian**. Hoy lo usan: conversaciones
directas, encargos directos, peticiones a departamentos y los encargos delegados creados a partir de esta versión. Las
historias y los lotes no lo usan todavía (para no cambiar el comportamiento del pipeline de desarrollo).

## 6. Migración de los agentes existentes

**Aditiva y bajo demanda.** Al desplegar no se escribe nada en `data/` salvo tablas y columnas nuevas (`agent_folders`,
`agent_revisions`, `agent_events`, `agent_messages`, `departments`, `lessons.agent_id`). La carpeta de un agente existente se
crea cuando el propietario lo pide (pestaña Archivos → «Crear su carpeta», o `POST /agent-folders` para todos): revisión 1
«migrated» generada desde su fila, que **no cambia**. Leer la oficina o un panel no escribe nada (probado).

## 7. Importar y exportar

- **Importar** (asistente → «¿Ya tienes la carpeta de un agente?»): ruta local absoluta (sin rutas de red UNC, dentro de las
  carpetas permitidas, fuera de los datos del Portal, comparando rutas reales: nombres cortos 8.3, junctions en carpetas padre
  y unidades de red asignadas incluidos), sin seguir enlaces ni junctions, sin enlaces físicos, solo archivos de la lista blanca,
  con límites de tamaño. La vista previa muestra lo que pide y sus problemas **y todo lo que llegaría a sus prompts**
  (instrucciones, habilidades y referencias completas). El propietario concede arnés, permisos, papeles en el equipo
  (capacidades; por defecto ninguno) y departamento: nada pedido viene concedido. El agente recibe un **id nuevo**; la memoria
  importada llega como **propuesta**.
- **Importar desde ZIP** (asistente → «¿Ya tienes el ZIP de un agente?»). Sirve para un agente nuevo o para uno que ya existe.
  Sin costo de IA. El ZIP se valida **entero antes de escribir nada** y se rechaza completo (400) si:
  - alguna entrada tiene problemas: `../`, ruta absoluta, enlace o cifrado;
  - alguna ruta está fuera de la lista blanca (fuera de la carpeta del agente);
  - hay duplicados, aunque solo cambien mayúsculas y minúsculas;
  - hay texto que no es UTF-8, se superan los límites o algo parece un secreto.

  Se aceptan una carpeta raíz común y separadores `\`. El único archivo extra admitido es el marcador `portal-export.json`:
  `{ workspace, agentId, n, hash, exportedAt }`.
  - **Nuevo**: el id de `agent.yaml` no existe en este espacio, o el marcador es de otro espacio, porque nunca se adopta un
    agente ajeno. Se sigue el mismo flujo que con la carpeta: vista previa, el propietario concede arnés, permisos y
    departamento, el agente recibe un id nuevo y la memoria llega como propuesta.
  - **Existente**: se fusiona a tres bandas, archivo por archivo, con `mergePortableFiles`:
    - el punto de partida es la revisión exportada;
    - lo del Portal es la revisión adoptada;
    - lo de fuera es el ZIP.

    La revisión de partida es la del marcador, si su huella coincide. Si no la hay, se usa la revisión con más archivos
    idénticos al ZIP. Si ninguna se parece, todo archivo que difiera de lo adoptado es conflicto. Las reglas son:
    - si fuera no cambió, se queda lo del Portal;
    - si el Portal no cambió, se toma lo de fuera;
    - si cambiaron los dos, hay **conflicto**: de ese archivo no se aplica nada hasta que el propietario elija «la del
      Portal» o «la del ZIP» (409 con la lista);
    - los archivos sin conflicto se fusionan.

    Borrar un archivo cuenta como cambio.
  - **Nunca se adoptan desde el ZIP**: arnés, modelo, esfuerzo, herramientas, autonomía, capacidades ni id. Se reponen desde
    el Portal y la vista previa explica qué no se adoptó y que se cambia en Configuración.
  - Se escribe bajo el cerrojo del agente (`writeImportedRevision`). Responde 409 si la revisión adoptada cambió desde la
    vista previa o si hay un cambio externo en disco sin revisar. Si la huella del ZIP cambió entre la vista previa y la
    confirmación, también responde 409. Todo queda registrado como `imported_zip` / `imported_zip_undone`.
  - Rutas: `POST /api/workspaces/:slug/agents/import-zip/preview` (subida `application/octet-stream`; devuelve un token
    que caduca a los 30 min), `POST …/agents/import-zip/confirm` (`token`, `hash`, `resolutions`, `grant` solo para uno
    nuevo) y `POST …/agents/:id/import-zip/:n/undo`.
  - Todo vive en la base de cada espacio: funciona igual en cualquier empresa y no añade nada al núcleo.
- **Exportar**: copia la revisión adoptada a una carpeta elegida (nunca sobrescribe; fuera de la instalación del Portal) o la
  descarga como `.agente.json`. Sin credenciales.
- Al eliminar un agente, su carpeta pasa a `agents/_archivadas/` (no la hereda otro agente con el mismo nombre).
