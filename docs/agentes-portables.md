# Agentes portables · contrato `portal-ia/agent@1`

> Un agente es una **identidad persistente que es del propietario**, no un modelo. Su definición vive en una carpeta local,
> legible fuera del Portal y transportable entre arneses (Claude Code, Codex, la API…). La base de datos del Portal sigue
> siendo la fuente de verdad **operativa**: estado, ejecuciones, autorizaciones, contabilidad, arnés y permisos concedidos.

Código: `packages/domain/src/portable-agent.ts` (contrato puro), `apps/server/src/services/agentFolders.ts` (carpetas y
revisiones), `agentIdentity.ts` (lo que llega al prompt), `agentLearning.ts` (memoria), `agentCreation.ts` (crear, importar,
exportar). Pruebas: `apps/server/test/sistema-operativo-agentes.test.ts`.

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

## 4. Memoria verificada

Una sola fuente: las lecciones del Portal (`lessons`) con `agent_id`. Flujo: opinión del propietario sobre un entregable o
una respuesta → **propuesta** ligada a esa tarea o mensaje → el propietario la **verifica** (puede editarla) → entra en los
prompts de ese agente y en `memory/MEMORY.md` con su procedencia → se puede retirar. Nada generado por un modelo se verifica
solo, y editar `MEMORY.md` a mano no crea memoria verificada. Las lecciones de un agente no aparecen en las listas ni en las
inyecciones de la organización (todas las existentes tienen `agent_id` NULL).

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
- **Exportar**: copia la revisión adoptada a una carpeta elegida (nunca sobrescribe; fuera de la instalación del Portal) o la
  descarga como `.agente.json`. Sin credenciales.
- Al eliminar un agente, su carpeta pasa a `agents/_archivadas/` (no la hereda otro agente con el mismo nombre).
