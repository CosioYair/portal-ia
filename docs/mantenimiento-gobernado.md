# Mantenimiento gobernado del proyecto: el Asistente revisa, el propietario autoriza, el Portal ejecuta

## 1. Por qué el Asistente no podía

El propietario pidió al Asistente de Empresa: «veo muchas ramas en la nube e historias pendientes; main es la fuente de
verdad; quiero borrar las ramas obsoletas y reconciliar y cerrar el backlog». El Asistente entendió la petición y
detectó bien el riesgo (ramas con commits que no están en main), pero respondió que no podía.

Causa raíz (comprobada en el código de 83b6c40):
- El Portal ya tenía el mecanismo correcto: un **catálogo cerrado de operaciones** (`apps/server/src/services/capabilities.ts`):
  el modelo propone (`request_operation`), el servidor calcula una vista previa de solo lectura con su huella, el
  propietario autoriza en la tarjeta y la ejecución pasa por la política de ejecución (auditoría).
- Ese catálogo tenía **una sola operación**: `publish_main`. No había inspección de ramas del remoto, ni borrado de ramas,
  ni retirada de worktrees, ni reconciliación del backlog. Lo que no está en el catálogo no existe para el Asistente
  (a propósito: no hay shell libre), así que «no se puede» era literalmente cierto.
- Las operaciones del catálogo eran «todo o nada» (aprobar o rechazar la tarjeta entera): no servían para una limpieza
  con decenas de objetivos en la que cada uno merece su propia decisión.
- Las reglas de cierre y cancelación de historias existían, pero dentro de rutas HTTP (no reutilizables), y el saneamiento
  anterior del backlog (`backlogMaintenance.ts`) era una lista fija de una sola vez.

## 2. Qué se añadió (reutilizando lo que ya había)

| Pieza | Qué hace |
|---|---|
| `services/projectMaintenance.ts` | Revisión de solo lectura del proyecto (ramas del remoto en vivo con `ls-remote`, ramas locales, worktrees, historias abiertas, procesos, lotes), clasificación determinista sin IA, plan persistido por empresa (`maintenance_plans`) y ejecución de SOLO lo seleccionado. |
| Capacidad `reconcile_project` | Nueva operación del catálogo: su vista previa ES la revisión (sin autorización ni IA). La tarjeta enlaza a la pantalla de revisión; no se puede «aprobar» desde la tarjeta. |
| `/mantenimiento/:planId` | Pantalla de revisión (sistema 2.0): grupos, opciones por objetivo, motivo cuando cierra trabajo, estado final esperado, autorización explícita, progreso, resultado y verificación. |
| `discardStory` (services/backlog.ts) | La regla de «Cancelar historia» como servicio (la usan el botón y la revisión). |
| Política de ejecución | Nuevas operaciones auditadas: `git_branch_delete`, `git_remote_branch_delete` (externa), `backlog_maintenance`; se reutilizan `delete_worktree`, `acceptItems`, `cancelItem`, `closeBatch` y la regla de cierre `closingBlocker`. |
| Capacidad que falta | Si el modelo pide una operación inexistente, en vez de «no puedo» la tarjeta propone crear la historia de desarrollo (enlazada a la conversación para retomarla). Nunca para shell, operaciones forzadas o saltos de permisos. |

Entradas: el Asistente («revisa el proyecto y prepara una limpieza segura»), el botón «Revisar ramas y backlog» del
Repositorio (Resumen) y la búsqueda (Ctrl+K). Las tres crean la misma revisión.

## 3. Reglas de clasificación

Todo se compara con **main** (la rama registrada del proyecto; si no hay, `main` y luego `master`; si no existe ninguna, no
se propone limpiar ramas). Revisar no pide autorización ni llama a la IA; lo único que escribe es el plan y, para poder
contar commits de ramas del remoto que no están en este equipo, un `git fetch` acotado de esos objetos (sin etiquetas,
sin `--prune`, sin `FETCH_HEAD`, sin submódulos ni `gc`).

**Ramas** (en el remoto y en este equipo):
- *Protegidas*: main, la rama por defecto del remoto, la rama activa, ramas de un proceso en curso, pendiente de integrar
  o de un lote abierto, y ramas abiertas en una carpeta de trabajo de otra herramienta. Si el remoto tiene una URL de
  envío distinta de la de lectura (`pushurl`), sus ramas no se tocan.
- *Ya integradas*: `git rev-list --count main..rama` = 0. Una rama del remoto solo cuenta como integrada si está en el
  main del remoto **y** en el main local; si solo está en un main local sin publicar, solo se ofrece conservarla.
  Se marcan solas (seguras) solo las ramas de historias que su proceso integró, o ramas de historia que no coinciden con
  la punta de main; cualquier otra rama integrada (posible rama de larga vida o recién creada) es una decisión en
  «Conservar».
- *Con trabajo que no está en main*: se muestran sus commits; por defecto se conservan. «Guardar copia y borrar» crea antes
  una referencia única `refs/portal-ia/archivo/<plan>/<local|remote>/<rama>` (nunca sobrescribe otra) y la verificación
  comprueba que existe.
- Una rama abierta en una carpeta de trabajo del Portal exige retirar antes esa carpeta: si la carpeta es segura, la pantalla
  la elige con la rama; si tiene cambios sin guardar, la rama nunca viene marcada (elegirla no elige perder esos cambios);
  si la carpeta está protegida, la rama también.
- Ramas y carpetas de otra empresa del Portal que registró el mismo repositorio: protegidas (sin nombrar a esa empresa).

**Carpetas de trabajo** (worktrees): las del Portal se pueden retirar si su proceso no está activo, ni pendiente de integrar,
ni en un lote abierto, ni bloqueadas (`git worktree lock`). Con archivos sin guardar (incluidos los no rastreados) son una
decisión; con commits que no están en ninguna rama (HEAD separado) solo se pueden conservar. Las de otras herramientas no
se gestionan.

**Historias** (nunca se marca como hecho algo cuyo commit integrado no está en main, comprobado con
`git merge-base --is-ancestor`):
- En curso → protegida. Reabierta por el propietario → nunca se ofrece como hecha.
- En un lote, esperando solo tu aceptación (integrada en main, activa y probada) → *seguro: aceptar* (el mismo `acceptItems`).
- Integrada, activa y probada (regla de cierre `closingBlocker`) → *seguro: cerrar como hecha*.
- Integrada pero le falta un paso de la regla de cierre → decisión: cerrar como hecha con motivo o cancelar.
- Solo en su rama o nunca implementada → decisión: conservar o cancelar con motivo («Descartadas»; nunca «hecha»).
  Cancelar una historia con trabajo sin integrar marca esa iteración como descartada: Decisiones deja de proponer
  integrarla y la integración la rechaza; su rama se conserva y queda para una revisión posterior.

- En un lote: reabierta, o con una iteración más reciente lanzada fuera del lote → solo «Conservar» (se decide allí). En un
  lote **en pausa**, aceptar o cancelar nunca viene marcado: elegirlo es incluir ese lote en tu decisión, y cancelar una
  historia no mueve las demás del lote.

**Lotes**: en marcha → protegidos; en pausa → por defecto se conservan; solo se cierran eligiéndolo con motivo. Mientras un
lote siga abierto, sus ramas y carpetas de trabajo no se pueden borrar.

## 4. Ejecución segura

1. Autorización explícita (`authorized: true`) y selección objetivo a objetivo; lo protegido o fuera del alcance no se
   puede elegir; cerrar o cancelar trabajo exige motivo. Desde la tarjeta del Asistente no se puede aprobar (409
   `review_required`): se autoriza en la pantalla de revisión.
2. Una ejecución a la vez por plan y por proyecto (cambio atómico de estado; doble clic, dos pestañas o una repetición no
   ejecutan dos veces). Un plan más reciente deja caducado al anterior.
3. Antes de cada tipo de objetivo se revisa todo otra vez: si main o la carpeta del repositorio cambiaron, el plan caduca
   entero; si un objetivo cambió (otro commit, otro estado, un proceso nuevo), ese objetivo no se toca.
4. Orden: historias → lotes → carpetas de trabajo → ramas locales → ramas del remoto.
5. Remoto: `git push --force-with-lease=refs/heads/<rama>:<sha revisado> <remoto> --delete refs/heads/<rama>`: borra solo si
   la rama sigue en el commit revisado (si alguien la movió, se rechaza y se informa). Nunca un `--force` sin condición,
   nunca main.
6. Local: bajo el bloqueo del repositorio se vuelve a leer el commit y las carpetas de trabajo, se comprueba que todo su
   contenido está en main o en su copia guardada, y solo entonces `git branch -D -- <rama>`.
7. Carpetas de trabajo: `git worktree remove -- <ruta exacta>` (con `--force` solo si elegiste retirar una con cambios sin
   guardar); nunca se borran carpetas a mano.
8. Cada objetivo anota «empezado» antes de actuar y su resultado al terminar: tras un reinicio el plan queda «a medias»
   (`interrupted`) y reanudar no repite lo hecho (lo que ya estaba así queda como «Ya estaba así»). Un reinicio o una
   actualización del Portal ve la limpieza en curso (`runningEverywhere`).
9. Verificación independiente: se vuelve a leer el remoto (`ls-remote`), las ramas, las copias guardadas, las carpetas de
   trabajo y el backlog.
10. Errores del remoto en lenguaje claro: rama protegida en GitHub, falta de permiso de escritura (se indica el permiso
    exacto: *Contents: write* o acceso de escritura al repositorio), clave SSH no aceptada, remoto no disponible, rama
    movida por otro. Nada se fuerza; se reanuda solo lo que falló.
11. Historial: motivo en el hilo de cada historia y en los eventos del lote; selección completa (también lo que se dejó en
    «Conservar»), resultados y verificación en el plan y su historial de ejecuciones; cada operación pasa por la política
    de ejecución (auditoría `policy:*`).

## 5. El Asistente

- El catálogo que ve el modelo se genera desde `CAPABILITIES` (cada capacidad aporta su `promptHint`): añadir una
  capacidad no exige reescribir el prompt.
- Peticiones con otro nombre que el catálogo ya cubre (p. ej. «borrar ramas del remoto») se resuelven a `reconcile_project`.
- Alcance: la empresa y el proyecto de la conversación; una petición de otra empresa u otro proyecto se rechaza antes de
  revisar nada. Si la empresa tiene varios proyectos y no queda claro cuál, pregunta.
- El modelo escribe antes de que el Portal calcule la revisión: por eso, debajo de su respuesta, el Portal añade los datos
  reales de la revisión (una foto al prepararla, con la hora): las cifras, lo que requiere decisión agrupado por las opciones
  que de verdad ofrece cada objetivo, lo protegido agrupado por su motivo, y cómo seguir exactamente; esa foto no vuelve al historial del
  modelo (allí cuenta la tarjeta con su estado real). En la primera prueba real, el modelo inventó un botón «Autorizar» y una
  carpeta a retirar que estaba protegida: de ahí esta corrección.
- Si dice que algo «ya está hecho» mientras la revisión sigue pendiente, la respuesta se corrige. La tarjeta muestra en
  todo momento el estado real (pendiente, en curso con progreso, hecha, a medias, rechazada, caducada).
- Si falta una capacidad de verdad, propone crear la historia de desarrollo en Portal IA › Desarrollo del Portal, enlazada a
  la conversación; nunca para shell, operaciones forzadas, lectura de secretos ni saltos de autorización.

## 6. Límites conocidos

- Las API del Portal escuchan solo en `127.0.0.1` y no tienen sesión de usuario: cualquier programa local (o una página
  abierta en el navegador del mismo equipo que llame a `localhost`) podría invocarlas. Es anterior a esta función y afecta
  a todo el Portal; la ejecución sigue exigiendo `authorized: true` y una selección concreta.
- El Portal usa las credenciales de git del equipo: si no tienen permiso para borrar ramas en GitHub, la operación se
  detiene con el permiso exacto que falta; el Portal no pide ni guarda credenciales nuevas.
- Las reglas de protección de GitHub mandan: una rama protegida allí no se borra desde aquí.
- La tarjeta «crear la historia de una capacidad que falta» también se ofrece en conversaciones sin empresa ni proyecto: solo propone una historia (el propietario la confirma) y nunca para borrados
  genéricos, ejecución de código, credenciales, permisos ni operaciones sin revisión.
- Cerrar como hecha una historia cuyo lote ya terminó (con su elemento aún «pendiente de aceptación») la cierra en el
  backlog, pero ese lote cerrado sigue mostrando el elemento como pendiente.
- «Revisar de nuevo» tras una ejecución parcial crea una revisión nueva no enlazada a la conversación (la tarjeta conserva
  el resultado verdadero de la anterior).
- Revisar trae, bajo el cerrojo del repositorio, solo los objetos que faltan (máx. 45 s): con muchas ramas nuevas en el
  remoto, integrar en ese repositorio espera a que termine.

## 7. GAUNTLET

Seis revisiones independientes (operaciones git, seguridad y autorización, coherencia de backlog y lotes, orquestación del
Asistente, UX y accesibilidad, regresión y recuperación) en tres rondas, cada una reproduciendo los fallos en repositorios
y datos temporales. Lo encontrado y corregido, con su prueba de regresión en `test/mantenimiento-proyecto.test.ts`:

- **git**: borrado en el remoto condicionado al commit revisado (lease); integrada solo si está en el main del remoto y en
  el local; copias con nombre único sin sobrescribir; `branch -D` solo tras comprobar main o copia bajo el cerrojo; sin
  `worktree prune` general (podía desregistrar una carpeta ajena); revisar sin escribir referencias (`--refmap=`); rama
  activa por su nombre completo; carpetas comprobadas otra vez dentro del cerrojo; git asíncrono (sin congelar el servidor).
- **Seguridad**: alcance comprobado antes de revisar o listar proyectos; la tarjeta no autoriza (`review_required`);
  nombres de capacidades con `Object.hasOwn`; lista de verbos permitidos para proponer desarrollo; datos del repositorio
  marcados como datos (sin caracteres invisibles) ante el modelo; sin salida de git en bruto en los resultados.
- **Backlog y lotes**: nunca «hecha» sin el commit en main; reabiertas y con iteración más reciente fuera del lote, solo
  conservar; aceptar vuelve a comprobar la regla de cierre al ejecutar; cancelar descarta esa iteración (no se integra);
  lotes en pausa intactos salvo elección expresa; huella del lote fiable.
- **Asistente**: catálogo generado desde las capacidades; sinónimos solo de limpieza; una revisión pendiente no se duplica
  en la misma conversación ni anula la de otra hasta que se ejecuta alguna; «Revisar de nuevo» conserva la tarjeta; tarjeta
  verdadera en todo momento (también tras un reinicio); «ya borré» corregido mientras nada se ha ejecutado.
- **UX y accesibilidad**: selección verdadera tras ejecutar o reanudar; panel de autorización sin tapar el foco; progreso
  anunciado y foco al resultado; opciones con radios nativos visibles; motivo con error en línea; acciones en bloque con
  nombre accesible; grupos largos plegados; estado final esperado; enlaces a lo que necesita atención.
- **Regresión y recuperación**: marcas «empezado» y reanudación sin repetir; interrupción detectada al arrancar; reinicios y
  actualizaciones ven la limpieza en curso; una ejecución por plan y proyecto.


## 8. Cierre de etapa (una sola autorización)

Cuando el propietario decide cerrar una etapa (adoptar main como línea base y descartar todo el trabajo antiguo), la
revisión puede llegar ya preparada: `closeStage: { reason }` en la capacidad `reconcile_project` del Asistente o en
`POST …/maintenance/plans`. El plan guarda la intención y una **selección preparada** con el motivo; no autoriza nada:
ejecutar sigue exigiendo que el propietario marque «Autorizo exactamente estas N acciones» y pulse «Ejecutar lo elegido».

Para que una sola autorización baste, la revisión resuelve dependencias en la misma ejecución:
- Lo que solo protegía un **lote en pausa** (sus ramas y carpetas) o una **iteración pendiente** es elegible «si en esta
  misma revisión también eliges» cerrar el lote, cancelar la historia o descartar la iteración (`requires`). Se ejecuta en
  orden (historias y encargos → iteraciones → lote → carpetas → ramas locales → ramas del remoto) y, si lo que libera no se
  hizo, se omite. Lo demás sigue protegido sin excepción: main, lo que está en marcha, carpetas bloqueadas, de otra
  empresa o de otra herramienta.
- **Iteraciones sueltas**: aplicadas sin integrar ni descartar, con su historia ya cerrada (o sin historia ni encargo
  abiertos): se pueden descartar (`result.rejected`), lo que libera su carpeta y su rama.
- **Encargos** abiertos del proyecto: aceptar si su trabajo ya está en main (con motivo si falta un paso de la regla de
  cierre) o cancelar con motivo; en marcha, protegidos.
- **Elementos de lote** de historias ya hechas que seguían «pendientes de aceptación»: aceptarlos solo lo anota en el lote.
- Cancelar una historia **deniega** también sus iteraciones que esperaban autorización (como «Denegar» en Decisiones).

La selección preparada elige, para cada objetivo, su cierre verdadero: borrar lo integrado; guardar copia
(`refs/portal-ia/archivo/<plan>/…`) y borrar lo no integrado; aceptar o cerrar como hecho lo que está en main (con
constancia de lo que faltaba); cancelar lo no implementado o no integrado; cerrar el lote. **Nunca** elige carpetas con
cambios sin guardar ni lo que dependa de ellas.

**Publicar main y «multiple upstream branches».** `pushBranches` publicaba con `git push -u`; con dos upstreams ya
registrados en `branch.main.merge`, cada `push -u` AÑADÍA otro (comprobado con git 2.47) y `git push` sin argumentos
fallaba. Ahora publica con refspec explícito y fija el seguimiento con `git config --replace-all` (sana los duplicados).

## 9. Cómo terminar la limpieza real

La revisión real de «Desarrollo del Portal» queda preparada en el Portal en marcha, sin ejecutar nada. El propietario la
abre desde la conversación del Asistente (tarjeta «Revisión del proyecto» › «Abrir la revisión para elegir y autorizar»),
desde Resumen › Repositorio › «Revisar ramas y backlog» o desde la búsqueda (Ctrl+K), elige objetivo a objetivo y autoriza.
