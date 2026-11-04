# Lotes de documentos, adjuntos del chat y mejoras desde la conversación

Tres capacidades del Portal, reutilizables por cualquier agente (no solo PDF Word Fiel):

1. **Lotes**: un ZIP con cualquier número de PDF (dentro de límites explicados antes de aceptar nada) se convierte en un
   lote con un registro por PDF, una cola acotada, reintentos solo de lo que falló y un entregable.
2. **Adjuntos del chat**: capturas, PDF, ZIP y texto en la conversación con cualquier agente, con registro propio,
   control de acceso y aviso de qué recibe el modelo de cada uno.
3. **Mejoras desde el chat**: el agente clasifica lo que pides y, si es una mejora, la encamina al proceso que le toca —
   la del agente a su flujo de propuestas; la del Portal al backlog de desarrollo del Portal. El agente nunca cambia el
   código del Portal.

## Por qué había un límite de 10 PDF (causa raíz)

En la versión 56421a3, `readZipPdfs` (`apps/server/src/services/documentJobs.ts`) tenía `ZIP_MAX_PDFS = 10`: a partir del
undécimo PDF cada entrada se apuntaba en `skipped` con «solo se toman 10 PDF por ZIP» y **no se importaba**. Además:

- el ZIP llegaba como JSON en base64 (≤ 60 MB, cuerpo ≤ 90 MB) y se descomprimía **entero en memoria** (todo el ZIP más
  todos los PDF a la vez, hasta 200 MB);
- el ZIP original **no se conservaba** (solo los PDF extraídos), así que lo omitido no podía recuperarse sin volver a
  subirlo;
- cada PDF era un trabajo suelto que se procesaba con un clic; no había cola ni lote.

**Qué protegía**: la memoria del servidor (todo en memoria) y que nadie lanzara decenas de conversiones sin control. Esas
dos protecciones se mantienen, pero ya no con un número fijo que descarta archivos:

| Antes | Ahora |
|---|---|
| ZIP en base64 dentro de JSON, en memoria | Subida en flujo (`PUT …/documents/upload`, `application/octet-stream`) a un archivo temporal |
| Descompresión de todo a la vez | Directorio central leído del disco; cada entrada se extrae de una en una con tope de salida y CRC |
| 10 PDF; el resto «omitido» | Hasta 500 PDF por lote; si el ZIP supera un límite **no se acepta nada** y se explica cómo dividirlo |
| ZIP original descartado | ZIP original guardado en `documentos/<lote>/origen/` |
| Trabajos sueltos | Un lote independiente con un registro por entrada del ZIP (aceptada o excluida con su motivo) |
| Sin cola | Cola global acotada (1 conversión a la vez por defecto) con espera si falta memoria |

## Lotes de documentos

### Recepción (lo que pasa al subir un ZIP)

1. La subida se escribe en disco por partes (`apps/server/src/routes/uploads.ts`): `Content-Length` comprobado, contador
   de bytes con tope y limpieza del temporal pase lo que pase.
2. `listZip` lee el directorio central (`apps/server/src/services/zipFile.ts`) y valida cada entrada **sin extraerla**:
   recorridos (`..`, rutas absolutas, unidades, NUL), enlaces simbólicos, cifrado, métodos distintos de stored/deflate,
   ZIP64, tamaño por entrada y relación de compresión (bombas).
3. Clasificación de **todas** las entradas: PDF candidato, archivo de sistema (`__MACOSX/`, `._*`, `Thumbs.db`,
   `desktop.ini`, `.DS_Store`), «no es PDF» o el problema de seguridad encontrado.
4. **Límites antes de aceptar nada** (`BATCH_LIMITS`): ZIP ≤ 1 GB, ≤ 5000 entradas, ≤ 500 PDF, cada PDF ≤ 100 MB,
   PDF descomprimidos ≤ 4 GB y espacio libre en el disco de la carpeta del agente (ZIP + 2 × PDF + 512 MB de margen). Si
   algo no cabe: 413/507 con el motivo y la salida («divídelo en ZIP de hasta 500 PDF») y **no se escribe nada**.
5. Se guarda el ZIP original (`documentos/<lote>/origen/<nombre>.zip`, sin reemplazar nada) y se crea el lote.
6. Cada PDF se extrae (CRC comprobado, cabecera `%PDF-`) y se registra como documento propio en
   `documentos/<lote>/<documento>/original/`, con su `HISTORIAL.md`. La duplicidad se decide **por SHA-256 y solo dentro
   del mismo lote** (ver «Independencia de los lotes»). Dos PDF con el mismo nombre en carpetas distintas del ZIP tienen
   carpetas distintas.
7. `MANIFIESTO.json` del lote: cada entrada con su resultado, su motivo, su documento y, cuando esté listo, su Word
   (asociación PDF↔DOCX determinista por entrada).

Nada se reorganiza: los documentos que ya existían siguen donde estaban; un lote nuevo solo añade su carpeta.

### Independencia de los lotes (HU-177)

**Causa encontrada en el código**: `registerPdf` (`documentBatches.ts`) llamaba a `jobs.bySha(agentId, sha)`, que
buscaba en **todos** los trabajos del agente sin mirar el lote. Un PDF que ya había llegado en cualquier lote anterior se
marcaba como «duplicado», se reutilizaba el trabajo antiguo y en el lote nuevo se quedaba con 0 versiones y el mensaje
«ya recibido antes como «nombre»». El nombre del mensaje no era la causa: el criterio ya era el SHA, pero se aplicaba
fuera del lote.

Regla actual:

- **Nombre repetido no es un error.** Mismo nombre con contenido distinto → documento nuevo con su propia carpeta.
- **Duplicidad = mismo SHA-256 dentro del mismo lote.** `bySha(agentId, sha, batchId)` filtra por `batch_id`. El mismo
  PDF que llegó en otro lote crea en este lote **un trabajo nuevo**, con su carpeta, sus versiones y su historial. El
  registro del lote anterior no cambia.
- **Carpetas sin sobrescritura**: `uniqueSlug(agentId, base, carpeta)` devuelve `base`, `base-2`, `base-3`… si ya existe
  un trabajo o una carpeta con ese nombre. Dos lotes recibidos a la vez no comparten ni sobrescriben carpetas ni trabajos.
- **Repetido dentro del mismo ZIP**: queda «excluido» con el motivo «repetido dentro del ZIP: mismo contenido que «X»» y
  nunca entra en la cola.
- **PDF suelto** (sin lote): no cambia. El mismo contenido reutiliza su documento.
- **Coste**: volver a convertir un PDF que ya se convirtió en otro lote gasta conversiones del tope diario. «Procesar el
  lote» siempre pide tu confirmación.

### Conteos del lote

Cada documento del lote cuenta en **un solo estado**, y siempre se cumple:

`total = listos + rechazados + fallidos + cancelados + excluidos + pendientes`

En «pendientes» entran también los que están en cola y en proceso, así que los conteos cuadran también con el lote en
marcha. `total` es el número de archivos del lote. Los registros antiguos sin `total` usan `detected`. `duplicates` es
solo informativo y **no se suma**. La comprobación es pura y sin IO: `batchCountsAddUp` / `batchCountsSum`
(`packages/domain/src/batch.ts`). Todo documento que no esté listo tiene su motivo. Las cifras de las capturas
(11 + 4 + 10 = 25 con 13 aceptados; «27 de 28 · 3 excluidos») venían de contar los duplicados de otros lotes aparte de
los estados.

### Procesamiento (cola acotada)

- **Procesar el lote** (lo confirmas) comprueba antes permisos, programas, arnés, scripts sin cambios externos y topes
  diarios; si no hay margen para todo el lote, no empieza nada.
- El agente hace **un plan para todo el lote** (una llamada a tu suscripción), validado como cualquier plan; cada PDF se
  convierte con ese plan y su propia QA del Portal (`tools/doc_qa.py`), su versión y su informe (del Portal, a partir de
  las cifras: sin llamada por documento). Al terminar, el agente redacta **un resumen** (otra llamada). Total: 2 llamadas
  por lote, no una por documento. El texto de los PDF no se envía al modelo.
- Cola global en memoria con `PORTAL_DOC_CONCURRENCY` conversiones a la vez (1 por defecto) y **espera por memoria**: si
  quedan menos de `PORTAL_DOC_MIN_FREE_MB` (1500 MB por defecto) libres, el lote espera y lo dice. Nunca 25 a la vez.
- Un documento que falla no detiene el lote: queda «Falló» con su motivo y el resto sigue.
- **Pausar**: el documento en curso termina; lo demás queda «En cola» (persistido). **Cancelar**: no empieza ninguno más,
  el que está en curso termina y lo hecho se conserva; cancelar nunca consulta al modelo.
- **Reintentar**: solo lo que falló o se canceló (y, si lo pides, lo que no pasó las comprobaciones). Lo aprobado nunca se
  repite. También por documento.
- **Reinicio del Portal**: un lote «en marcha» que el proceso ya no atiende pasa a **En pausa** con el aviso; lo que
  estaba en curso vuelve a «En cola». «Reanudar» sigue con lo que falta (el documento interrumpido se repite como versión
  nueva; las anteriores no se tocan).
- Topes diarios por agente: 600 versiones y 80 llamadas al modelo (`VERSIONS_PER_DAY`, `MODEL_CALLS_PER_DAY`).

### Entregables

Al terminar: `documentos/<lote>/entregables/Word-aprobados-<fecha>.zip` con la última versión aprobada de cada documento
(nombres únicos; nunca reemplaza un ZIP anterior), el resumen del lote y el manifiesto actualizado. Cada documento conserva
su carpeta, sus versiones, sus comprobaciones y su historial, y se puede abrir desde el lote para revisar, corregir o dar
feedback. El ZIP original no se descarga desde la interfaz (está en la carpeta del agente).

## Adjuntos del chat (cualquier agente)

- Tipos por **contenido** (no por extensión; un ZIP se reconoce antes que un PDF): PNG, JPEG, GIF, WEBP (≤ 3,5 MB: en
  base64 quedan bajo los 5 MB por imagen del modelo; ≤ 15 MB de imágenes por mensaje), PDF (≤ 100 MB), ZIP (≤ 1 GB) y
  texto `txt/md/csv/json/log` (≤ 1 MB). Hasta 10 por mensaje. Copia y huella sin bloquear el servidor.
- Registro `chat_attachments` en la base de la empresa: agente, proyecto, nombre, tipo, tamaño, SHA-256, metadatos
  (dimensiones, páginas, listado del ZIP), estado (`uploaded` → `attached`; `deleted`/`expired`), mensajes en los que se
  envió y quién lo subió. Archivos en la carpeta de datos de la empresa (`adjuntos/<agente>/<id>.<ext>`), nunca rutas
  elegidas por el usuario o el modelo.
- Control de acceso: un adjunto solo existe para su agente y su empresa (otro agente → 404). Descarga con `nosniff`, CSP
  `sandbox` y, salvo imágenes, como descarga. Se puede **quitar** mientras no se ha enviado; lo enviado queda con la
  conversación. Lo subido y no enviado caduca a las 24 h (y al recargar la página vuelve a la caja de mensaje).
- **Qué recibe el modelo** (se dice antes de enviar y queda anotado en cada mensaje):
  - imagen: la ve solo si su arnés envía imágenes de verdad (Claude Code y API); con Codex o la consola, solo el nombre;
  - texto: su contenido (hasta 20 000 caracteres), marcado como DATOS del propietario y dentro de una valla más larga
    que cualquiera de su contenido (no puede «cerrarla» ni colar instrucciones); los nombres de archivo se limpian;
  - PDF y ZIP: **solo el nombre y datos básicos** (páginas, listado); su contenido no se envía. Para convertirlos, el
    agente propone la acción «Procesar documentos» y el Portal hace el lote como si lo hubieras subido en Documentos.
- Con un arnés facturable (API) la casilla «Autorizo esta llamada facturable» sigue siendo obligatoria; el costo
  estimado (y el límite mensual) incluye lo que se envía de los adjuntos (texto e imágenes). Nunca hay paso silencioso a
  la API. Un agente sin arnés fijado usa la API: la interfaz lo dice al adjuntar una imagen.
- «El modelo recibió…» solo se afirma si la llamada terminó bien; si falló o se interrumpió, el mensaje lo dice.

## Mejoras desde la conversación

El agente recibe en su contexto qué es **suyo** (cómo convierte, qué opciones o scripts usa, cómo revisa, qué recuerda) y
qué es **del Portal** (subidas, ZIP y lotes, límites, chat y adjuntos, interfaz, colas, QA del Portal, permisos). Si
pides algo (no solo preguntas), termina su respuesta con un bloque `accion`; el Portal lo valida y lo registra
(`agent_actions`), y la conversación muestra su estado actual y el enlace:

| Acción | Qué hace | Confirmación |
|---|---|---|
| `mejorar_agente` | Agente externo: `classifyFeedback` → propuesta en **Mejoras** (nada cambia hasta que la apruebes). Agente del Portal: aprendizaje propuesto en **Memoria** | **Sí** en agentes externos (una consulta a tu suscripción); en agentes del Portal no (no gasta y ya se verifica en Memoria) |
| `mejorar_portal` | Historia en el backlog del proyecto conectado al repositorio del Portal, con tus palabras, la evidencia y la conversación de origen; sigue el proceso de desarrollo del Portal (análisis, implementación aislada, pruebas, revisión y tu aprobación) | **Sí** |
| `procesar_documentos` | Los PDF/ZIP adjuntos → un lote por ZIP y otro con los PDF sueltos (mismas reglas que Documentos); la tarjeta dice cuántos PDF y cuántas consultas como máximo | **Sí** |
| `corregir_documento` | Nueva versión de un documento con una corrección solo para él | **Sí** |

- **La ruta la decide el propietario**: el agente propone «del agente» o «del Portal» y la tarjeta permite cambiarla
  («Es del Portal, no del agente» / al revés) antes de confirmar. El modelo nunca ejecuta su elección por su cuenta.
- **Tus palabras**: la propuesta o la historia se crean con el texto de tu mensaje; la interpretación del agente va
  aparte, señalada como suya.
- Exactamente un bloque por respuesta (si hay varios, ninguno cuenta y ninguno queda visible); tipos desconocidos se
  ignoran; las inválidas quedan «Falló» con el motivo; una acción cortada por un reinicio se muestra como fallida.
- No es un segundo sistema de mejoras: usa las propuestas, la memoria y el backlog que ya existían; y cuenta en el tope
  diario de consultas del agente.

## Seguridad (resumen)

Subidas en flujo con topes; ZIP validado sin extraer y extraído por entrada (sin recorridos, enlaces, cifrado, ZIP64 ni
bombas; un tamaño declarado que no cabe en el archivo se rechaza antes de reservar memoria); rutas con una sola forma
(sin «:», flujos NTFS, NUL ni segmentos con punto o espacio final); escritura solo en la zona `documentos/` de la carpeta
del agente y nunca reemplazando (`wx`/`COPYFILE_EXCL`); descargas acotadas a la carpeta del lote o del documento (el
original no: se compara la ruta real); adjuntos aislados por agente y empresa, servidos con `nosniff` y su CSP
(`sandbox`) intacta; el modelo no recibe rutas ni contenido de PDF, y lo que lee de los adjuntos va marcado como datos;
las acciones que ejecutan programas, gastan o crean historias piden tu confirmación; el agente no puede tocar el código
del Portal.

## Robustez de los lotes

- La cola nunca se queda parada: si el agente está ocupado (p. ej. con un documento suelto) se vuelve a mirar cada 2 s.
- Un lote termina cuando no le queda nada PROPIO en cola ni en curso: una conversión manual no lo deja «en marcha» para
  siempre. Cada lote tiene sus propios trabajos y no comparte documentos con otros lotes.
- Preparar (plan, comprobaciones) es exclusivo: doble «Procesar» → 409; cancelar mientras se prepara gana (el lote
  queda cancelado y no se pide el resumen al agente). Los cambios de estado son condicionales.
- Cerrar un lote nunca tumba el Portal: entregable, historial, manifiesto y registro se intentan uno a uno y lo que
  falle queda anotado en el lote. El entregable se reutiliza si nada cambió (pedirlo dos veces no crea otro ZIP).
- Importar un ZIP grande no bloquea el servidor (cede el turno entre entradas). Un error de disco a mitad no da 500: el
  lote dice cuántos PDF faltan por registrar y «Procesar el lote» los registra desde el ZIP guardado.
- Tope diario: si se alcanza a mitad de un lote, el lote se pausa con el motivo. Las consultas de plan y resumen se
  anotan con su hora (un lote antiguo tocado hoy no vuelve a contar).
- Dentro de un lote, un PDF llamado «entregables» u «origen» tiene su carpeta como «documento-…» (no choca con las del
  lote).

## Cómo subir el ZIP original de PDF Word Fiel

1. Oficina → PDF Word Fiel → pestaña **Documentos**.
2. Arrastra el ZIP a la zona «Dar PDF o un ZIP con PDF» (o «Elegir PDF o ZIP…»). Verás el progreso de la subida y luego
   «revisando el archivo en el servidor…».
3. Lee el resumen: cuántos archivos hay (total), cuántos PDF se aceptaron y qué se excluyó y por qué («Ver el detalle»).
   Los PDF que ya llegaron en un lote anterior se aceptan en este lote con su propia carpeta y se vuelven a convertir.
   El lote anterior no cambia.
4. Abre el lote y pulsa **Procesar el lote**; lee el aviso (programa en este equipo, de uno en uno, 2 consultas a tu
   suscripción en total) y confirma. Puedes pausar, reanudar o cancelar.
5. Al terminar: **Descargar los Word aprobados (ZIP)**, el resumen y el manifiesto. Revisa los que «No pasaron las
   comprobaciones» o «Fallaron» desde la lista (Abrir → versiones, comparación página a página, corrección o feedback) y
   usa **Reintentar los que fallaron**.

## Interfaz

- Pestañas del panel del agente: pasan de línea en vez de desplazarse (todas visibles en cualquier ancho).
- Chat: «Adjuntar», arrastrar y soltar, pegar una captura; fichas con nombre, tipo, tamaño, estado y progreso; quitar
  antes de enviar; miniaturas y descargas en el historial; tarjetas de acción con estado y enlace.
- Documentos: zona para soltar con los límites a la vista; resumen de la importación con detalle desplegable; tarjeta por
  lote con barra de progreso, cifras, avisos, acciones, filtros (todos, con problemas, por hacer, listos) y la lista de
  documentos con su estado, su Word y «Abrir».

## API

`PUT /api/workspaces/:slug/agents/:id/documents/upload?name=` (octet-stream) · `POST …/documents` (JSON base64,
compatibilidad: `{ jobs, skipped, batch? }`) · `GET …/documents` (`{ jobs, batches, running, proposals, queue, limits }`) ·
`POST …/batches/:batchId/start|pause|resume|retry|cancel|deliverable` (start/resume/retry con `authorized: true`;
retry admite `includeRejected` e `items`) · `GET …/batches/:batchId/file?path=` · `GET|PUT …/agents/:id/attachments`
(`PUT` octet-stream, `?name=`) · `DELETE …/attachments/:attId` · `GET …/attachments/:attId/file` ·
`POST …/agents/:id/chat` (`text`, `attachmentIds`) · `POST …/actions/:actionId/confirm` (`authorized: true`) |
`…/reroute` | `…/dismiss`.

Esquema de datos **0.19** (copia automática antes de migrar; todo aditivo): `document_batches`, `document_batch_items`,
`document_model_calls`, `document_jobs.batch_id`, `chat_attachments`, `agent_message_attachments`,
`agent_messages.meta_json`, `agent_actions`.

## Revisión Gauntlet

Cinco revisiones independientes (seguridad y sistema de archivos; orquestación, persistencia y recuperación de lotes;
arneses y encaminamiento de mejoras; experiencia y accesibilidad; compatibilidad y activación). Cada hallazgo material
se reprodujo, se corrigió y tiene su prueba en `apps/server/test/lotes-adjuntos-acciones.test.ts` o
`agentes-externos.test.ts`:

| Hallazgo | Corrección |
|---|---|
| `origen::$INDEX_ALLOCATION/…` descargaba el ZIP original | `safePath` rechaza «:», NUL y segmentos con punto/espacio final; `origen/` se compara por ruta real |
| Un ZIP de 124 bytes hacía reservar 4 GB | Tamaño comprimido declarado acotado al archivo y coherente con el método |
| Huella de 1 GB en memoria e importación síncrona | Huella en flujo, copia asíncrona, extracción que cede el turno, `writeZip` asíncrono |
| Un fallo de disco al cerrar un lote tumbaba el Portal | Cierre por pasos con errores anotados; ninguna promesa sin capturar |
| Cola parada si el agente estaba con un documento suelto | Reintento cada 2 s mientras haya cola |
| Lote «en marcha» para siempre si su PDF lo convertía otro lote; conversión doble | Fin según el trabajo propio; un documento ya convertido tras encolarse no se repite |
| Cancelar durante el plan acababa «terminado» con resumen del agente; doble inicio | Preparación exclusiva y cambios de estado condicionales; la cancelación gana |
| «Mejorar el agente» gastaba una consulta sin confirmar; «mejorar el Portal» sin confirmar; ruta solo del modelo; paráfrasis guardada como palabras del propietario | Confirmación, reasignación por el propietario, palabras del propietario con la interpretación del agente aparte |
| El costo por la API ignoraba los adjuntos; «no la verá» con imágenes que sí se enviaban; «recibió» aunque la llamada fallara | Estimación con adjuntos, capacidad real del arnés desde el servidor, entrega confirmada |
| Inyección por adjuntos de texto o nombres de ZIP; bloques de acción múltiples o `constructor` | Valla más larga y datos marcados, nombres limpios; exactamente un bloque de un tipo conocido |
| ZIP «stored» tomado por PDF | Se reconoce el ZIP antes que el PDF |
| CSP del adjunto reemplazada por la global | La global se añade a la de la ruta |
| Enlace «Word» roto en documentos de un ZIP | La ruta del Word relativa al documento viene del servidor (`docxRel`) |
| Foco perdido, reintento fuera de la vista, pegar desde Word adjuntaba una imagen, aviso de arrastre atascado, Enviar fuera de la pantalla con muchos adjuntos, nombres largos desbordados | Foco gestionado, confirmación en la fila, el texto se pega, contador de arrastre, lista desplazable, ajuste de línea |
| `GET documents` caro con lotes grandes | Una lectura de documentos por petición (no una por entrada) y refresco cada 1,5 s |

Segunda ronda (revisión independiente del ciclo de vida ya corregido):

| Hallazgo | Corrección |
|---|---|
| Pausar o reintentar mientras el lote se cerraba dejaba entradas «en cola» para siempre | Un lote que se cierra no admite pausar, reanudar, reintentar ni empezar; el estado final solo se escribe desde «en marcha» o «cancelado» |
| Una extracción detenida dejaba procesar lo registrado y los PDF sin registrar quedaban inalcanzables | «Procesar» y «Reintentar» se niegan (409) con el motivo hasta que todo esté registrado; el resumen cuenta lo no procesado |
| Cancelar mientras se preparaba y que luego fallara el plan dejaba el lote cancelado sin cerrar | El cierre se intenta también cuando la preparación falla |
| El cierre (resumen del agente) retenía el puesto del agente y de la cola | El puesto se libera antes de cerrar el lote |
| Reanudar sin nada pendiente consultaba al modelo sin comprobaciones previas; un ZIP adjunto con nombre «.pdf» no se trataba como lote; índice del ZIP sin tope | Cierre sin consultas; el lote se decide por el contenido; índice ≤ 64 MB |

Tercera ronda (solo los cambios de la segunda): sin hallazgos materiales; un caso menor — «Reintentar» no volvía a comprobar el lote tras esperar sus comprobaciones — se corrigió (vuelve a mirar y cambia el estado antes de tocar las entradas, sin esperas entre medias).

## Limitaciones conocidas

- Una conversión a la vez por defecto: un lote de 500 PDF tarda lo que tarden 500 conversiones seguidas.
- La cola vive en el proceso del servidor: un reinicio deja el lote en pausa (no se reanuda solo, por diseño).
- Codex y la consola de Claude Code no reciben imágenes del chat (se dice al adjuntar).
- ZIP64 (ZIP de más de 4 GB o más de 65 535 entradas) no se admite.
- `mejorar_portal` solo crea la historia si en la misma empresa hay un proyecto conectado al repositorio del Portal (los
  datos de una empresa no se copian a otra); si no, la tarjeta lo dice.
- El refresco de Documentos devuelve todas las entradas de los 50 lotes más recientes; con muchos lotes enormes la
  pantalla tarda más en actualizarse.
