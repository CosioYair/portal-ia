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
  descarga como **paquete portable (ZIP)** para usarla fuera del Portal (§8). Sin credenciales. El JSON de la carpeta
  (`GET …/agents/:id/export`) se mantiene solo por compatibilidad.
- Al eliminar un agente, su carpeta pasa a `agents/_archivadas/` (no la hereda otro agente con el mismo nombre).

## 8. Paquete portable (ZIP) · `portal-ia/agent-bundle@2`

Objetivo: que el agente trabaje fuera del Portal igual que dentro y siga mejorando allí. **«Descargar paquete (ZIP)»** está en
Ajustes › **Archivos** de un agente interno y en Ajustes › **Origen** de un agente externo. Es el mismo botón
(`BundleDownloadButton`) y la misma ruta: `GET /api/workspaces/:slug/agents/:id/export.zip`. No llama a la IA y no cuesta
nada. Código:
- `packages/domain/src/portable-bundle.ts`: `buildPortableBundle`, `buildExternalBundle`, `validatePortableBundle` y
  `EXTERNAL_BUNDLE_LIMITS`;
- `zipFile.ts`: `zipBuffers`, ZIP en memoria y determinista;
- `agentCreation.ts`: `exportFiles` y `exportBundle`;
- `documentJobs.ts`: `provenPlansForExport`.

Pruebas: `apps/server/test/agente-portable-paquete.test.ts`, `apps/server/test/agente-portable-externo.test.ts` y
`apps/server/test/en010-rutas-sistema.test.ts` (EN-010: rutas del sistema y privadas, línea y fragmento, copia byte a byte).

```
AGENTS.md             instrucciones; su primera línea remite a AUTOMEJORA.md
agent.yaml            identidad y autonomía pedida (sin id, sin modelo, sin herramientas concedidas)
skills/<s>/SKILL.md   habilidades
memory/MEMORY.md      solo memoria verificada, con procedencia neutra («Aprendido en el Portal»)
knowledge/<k>.md      referencias (si las hay)
AUTOMEJORA.md         reglas de automejora (mandan sobre lo demás)
CAMBIOS.md            historial de cambios (se conserva el que ya tenga la carpeta, si lo hay)
GUIA.md               pasos breves para Claude Code web, Cowork y ChatGPT
scripts/anotar-cambio.mjs   añade una entrada a CAMBIOS.md (Node, sin dependencias)
```

**Qué se excluye y por qué.** No sale nada que sea operativo del Portal o que pueda filtrar datos: ni el id del agente, ni
UUID de procesos (pasan a «[interno]»), ni rutas locales o de la carpeta de datos del Portal («[ruta local]», ver §8 «Rutas
del sistema y rutas privadas»), ni rutas `/api/` o nombres de tablas,
ni el modelo, ni las herramientas concedidas, ni las lecciones propuestas o retiradas, ni ninguna credencial. Si tras limpiar
queda algún secreto (`findSecret`), dato interno o ruta fuera de la lista blanca, **no se exporta**: el Portal responde 409
con la lista de problemas y el panel la muestra. Los archivos de la carpeta portable se pueden volver a importar con
`filesToDefinition`; los que son propios del paquete solo generan avisos que no bloquean.

**Agente interno: todo lo que llega a sus prompts.** El paquete lleva las instrucciones, las habilidades, la memoria
verificada y las referencias. Si hay lecciones validadas de su papel, añade también `knowledge/lecciones-del-papel.md`.
Esas lecciones salen de la misma consulta que las inyecta en los prompts (`lessonsFor`). Si no hay ninguna, el archivo no se
crea. Su texto pasa por la misma limpieza que el resto de `knowledge/`.

**Agente externo (EN-007).** `exportFiles` parte de su **revisión adoptada**, no de `definitionFor`: solo lo que admite
`isIdentityPath`. `buildExternalBundle` arma el paquete:

```
AGENTS.md                      sus instrucciones, sin reescribir (arriba: remite a AUTOMEJORA.md y GUIA.md)
contexto/*.md · memoria/*.md   contexto y TODA su memoria: también lo aprendido desde el chat (HU-178) y en reintentos verificados (HU-179)
skills/<s>/SKILL.md            habilidades
skills/<s>/scripts/*.py|*.txt  scripts y requirements, copiados byte a byte
PLANES.json                    planes que ya funcionaron, por SHA-256 del PDF
agent.yaml · memory/MEMORY.md  mínimos, para que el ZIP se pueda reimportar (HU-183); MEMORY.md remite a memoria/
AUTOMEJORA.md · CAMBIOS.md · GUIA.md · scripts/anotar-cambio.mjs
```

No salen las dependencias instaladas (`.dependencias`, venv), los binarios, `bandeja-de-entrada/`, `documentos/` ni los
documentos convertidos.

- **PLANES.json** (`schemaVersion: 1`). Cada plan lleva `{ sha256, skill, script, args, reason }`, ordenado por `sha256`.
  Solo entran los planes que pasaron la QA del Portal (`passed=true`) y cuyo script sigue en el paquete con la misma huella.
  Si hay varios para el mismo PDF, queda el más reciente. Los argumentos usan los marcadores `{entrada}`, `{salida}`,
  `{informe}` y `{trabajo}`. No lleva ids de trabajos ni de lotes, UUID, rutas ni títulos. Incluye una nota: un plan que ya
  funcionó **no garantiza** el mismo resultado.
- **GUIA.md** explica paso a paso cómo procesar sin el Portal un PDF y un ZIP con PDFs:
  1. descomprimir el ZIP (solo `.pdf`, sin rutas `..`);
  2. calcular el SHA-256 (`sha256sum` o `Get-FileHash`);
  3. si el hash está en PLANES.json, usar ese script con esos argumentos;
  4. si no está, elegir el script según `skills/<s>/SKILL.md`;
  5. ejecutar `python skills/<s>/scripts/<x>.py`;
  6. aplicar las comprobaciones de la habilidad;
  7. si fallan, reintentar con otro plan;
  8. anotar lo aprendido en `memoria/` y en `CAMBIOS.md` según AUTOMEJORA.md.

  También indica qué necesita la plataforma: Python 3, los paquetes de `requirements*.txt` y los programas externos que
  aparecen en los scripts (p. ej. LibreOffice). En «Requisitos de la plataforma» enumera además las **rutas del sistema** que
  citan los `.py` (únicas, ordenadas, como mucho 20; p. ej. `C:\Windows\Fonts`, `/usr/share/fonts`). Pide comprobar que
  existen en el equipo o ajustarlas si la instalación está en otra carpeta. Y qué hacer donde no se pueden ejecutar scripts, como ChatGPT sin intérprete:
  explicar los pasos sin prometer ni simular resultados. Solo cita rutas que existan en el ZIP, y la prueba lo comprueba.
- **Topes.** Para un externo, `EXTERNAL_BUNDLE_LIMITS`:
  - por archivo, `EXTERNAL_TEXT_LIMIT`;
  - en total, `EXTERNAL_TOTAL_LIMIT` más 512 KB para los archivos que genera el paquete;
  - como mucho 2000 archivos.

  Para un interno siguen valiendo los de `PORTABLE_LIMITS`.
- **Los scripts nunca se limpian.** Los `.py` y `.txt` no pasan por `scrub` ni se normalizan, porque cambiarlos los
  rompería. Los `.md` sí se limpian como en un interno.

**Sin paquetes parciales.** `validatePortableBundle` revisa todos los archivos del paquete. Si alguno contiene un secreto,
una ruta local, un UUID, el id del agente o una ruta o tabla interna, o si supera los topes, la exportación se niega
**entera**. La respuesta es un 409 con `payload.problems`, y el panel muestra esa lista. Nunca se quita un archivo en
silencio. La solución es corregir el archivo en la carpeta del agente, adoptarlo y volver a exportar.

**Rutas del sistema y rutas privadas (EN-010).** `findLocalPaths(texto, { privatePaths })` recorre el texto línea a línea
(`\r?\n`) y clasifica cada ruta que encuentra:
- `system`: rutas genéricas del sistema. Son `C:\Windows\…`, `C:\Program Files\…`, `C:\Program Files (x86)\…`, `/usr/…`,
  `/bin/…`, `/opt/…`, `/etc/…`, `/Library/Fonts` y `/System/Library/…`. En Windows no se distinguen mayúsculas, y se
  aceptan `\`, `\\` (escapado) y `/`.
- `profile`: el perfil del usuario: `X:\Users\<nombre>\…`, `/home/<nombre>/…` y `/Users/<nombre>/…`.
- `source`: la carpeta original del agente externo (`src.root`).
- `portal-data`: la carpeta de datos del Portal. Se detecta por su ruta absoluta (`config.dataDir`) o por
  `data/workspaces`, `data/evidence`, `data/platform.sqlite` y `data/master.key`.
- `other`: cualquier otra ruta local. Incluye otra unidad, una ruta de red UNC (`\\servidor\recurso`) y `/tmp`, `/var`,
  `/mnt`, `/root` o `/private`.

`privatePaths` se compara sin distinguir mayúsculas y con `/` como separador. Para un externo, `exportBundle` pasa como
rutas privadas la carpeta original y `config.dataDir`. Para un interno no pasa ninguna.

Qué bloquea:
- En los scripts que se copian tal cual (`.py` y `.txt`) y en `GUIA.md`, las rutas `system` **no bloquean**: un script puede
  citar `C:\Windows\Fonts`, `C:\Program Files\LibreOffice\program\soffice.exe` o `/usr/bin/soffice`.
- En el resto de archivos, una ruta del sistema con unidad de Windows (`C:\Windows\…`) sigue bloqueando como antes.
- Siempre bloquean, en cualquier archivo, `profile`, `source`, `portal-data` y `other`.
- Tampoco cambia nada para los secretos (`findSecret`), los UUID, el id del agente, las rutas `/api/` ni las tablas internas.

**La regla de `data/`.** Un «data/» cualquiera **ya no bloquea**: `os.path.join('data/', x)`, `metadata/` o `./data/input.csv`
pasan. Solo bloquea cuando apunta a la carpeta de datos del Portal, como en los ejemplos de arriba. `scrub` usa la misma
regla al limpiar los `.md`, y los scripts se siguen copiando **byte a byte**: ni `scrub` ni normalización. Una prueba lo
comprueba con un `.py` que tiene CRLF, tabulaciones, espacios finales y una ruta del sistema.

**Línea y fragmento.** Cada problema de ruta lleva estos campos:
- `line`: la línea, contada desde 1;
- `snippet`: el fragmento detectado, recortado a 80 caracteres; si parece un secreto se muestra «[oculto]»;
- `reason`: el motivo;
- `message`: `Línea N: «fragmento» — motivo`.

Hay un problema por línea, con un máximo de 5 por archivo y un resumen «Y N línea(s) más». Los UUID y las rutas o tablas
internas también indican su línea. En el 409, cada elemento del mensaje usa la forma `archivo:línea — mensaje`, y
`payload.problems` trae `line`, `snippet` y `hint`. En Ajustes › **Origen** (y Ajustes › Archivos), la lista muestra `ruta:línea`,
el fragmento y el motivo.

**Automejora desde el chat.** Algunos archivos los escribió el propio agente: sus `.py`, `.txt` y `.md`, no los que genera
el paquete. En esos archivos, el problema añade `hint`: «Puedes pedirle al agente en su chat que cambie la línea N de
<archivo> (automejora con copia y Deshacer).». El panel lo muestra debajo de la lista. El Portal **nunca** cambia los scripts
por su cuenta. El cambio lo pide el propietario en la pestaña Chat. Ese mensaje tiene el costo normal de una conversación y
requiere su autorización. Queda como automejora, con respaldo, una entrada en CAMBIOS.md y Deshacer en Memoria › Historial
de automejoras.

**Privacidad del fragmento.** El fragmento puede mostrar el nombre del usuario o una carpeta privada. Se enseña solo en la
respuesta 409 y en el panel local, y no debe guardarse en evidencias, registros de proceso ni conocimiento del proyecto.

**Reimportar.** El ZIP de un externo sigue entrando por el flujo de HU-183. Los archivos propios del paquete no bloquean la
importación. Al exportar o importar nunca salen ni cambian el id, el modelo, el arnés, los permisos concedidos ni los
secretos. Los scripts modificados fuera del Portal no se adoptan automáticamente.

**Frontera.** Exportar es una función replicable: funciona igual en cualquier empresa y con cualquier agente.
`AUTOMEJORA.md` es el aprendizaje **local** del agente fuera del Portal (su memoria y `CAMBIOS.md`). No es la automejora del
Portal, que sigue siendo exclusiva del sistema principal.

**Reglas de automejora (AUTOMEJORA.md).** 1) Aplica lo que el usuario pida en el archivo que corresponda. 2) Aplica lo que
corrija un reintento, en el archivo que evite repetir el error. 3) Anota cada cambio en CAMBIOS.md con fecha, qué, motivo
(«Petición del usuario» o «Corrección tras un reintento») y archivo. 4) La memoria nueva se marca «sin verificar». Prohibido:
ampliar permisos, guardar secretos y marcar memoria como verificada. Formato de cada entrada de CAMBIOS.md, que debe usar
también «Automejora desde el chat»:
`## AAAA-MM-DD — Qué cambió` + `- Motivo: …` + `- Archivo: …` (+ `- Detalle: …`). Las entradas nuevas van al final.

**Prueba manual por entorno.** Desde el código no se puede garantizar la efectividad fuera del Portal. Con el mismo ZIP, en
**Claude Code web**, **Cowork** y **ChatGPT**, siguiendo GUIA.md: (1) comprobar que el agente actúa según AGENTS.md; (2) pedir
un cambio («a partir de ahora, …») y ver que queda en su archivo y en CAMBIOS.md; (3) rechazar un resultado, corregirlo en un
reintento y ver que la corrección también queda anotada. En ChatGPT, el agente entrega el archivo y la entrada de CAMBIOS.md
y el usuario los guarda.
