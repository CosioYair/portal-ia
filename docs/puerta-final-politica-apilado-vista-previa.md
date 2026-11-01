# Puerta final antes de activar: política de un lote ya autorizado, preparación apilada y vista previa aislada

Encargo «Puerta final del Gauntlet antes de activar» (1 de noviembre de 2026), sobre la rama `mejora/empresa-autonoma`.
Cierra tres huecos del flujo del propietario: autorizar un lote, dejar que el equipo termine todo lo técnico, **probar**
cada historia antes de aceptarla, pedir cambios y que entren en main en orden, sin perder trabajo.

## 1. Causas raíz

| Hueco | Causa |
|---|---|
| Un lote ya autorizado (568c60cb) integraría, publicaría y reiniciaría al reanudar | Se autorizó sin el campo `integration` (= automática). No había forma explícita y auditable de cambiarlo; «Reanudar» no decía qué haría. Además, `tick()` leía la política una vez por pasada, `integrate()` no estaba marcada «en curso» y publicar se leía de una copia vieja del lote: un cambio de política a mitad no era seguro. |
| Las dependientes esperaban a que aceptaras su dependencia | El plan y el Desarrollador leen main; una dependiente no tenía de dónde leer el código de su dependencia sin integrar. |
| No se podía probar una historia antes de aceptarla | No existía un entorno aislado del candidato. El Portal aceptaba peticiones que cambian cosas desde cualquier página de `127.0.0.1:*` y se dejaba incrustar: servir código sin aceptar en el navegador del propietario habría podido manejar el Portal en marcha. |

## 2. Cambios

### 2.1 Cambio explícito de la política de un lote ya autorizado

- `GET /batches/:id/policy`: vista previa sin efectos. Lista:
  - qué ya está en main (no se des-integra; aceptarlo es **reconocerlo**);
  - qué pasaría a esperar tu revisión;
  - qué hará «Reanudar» **ahora** y **después** del cambio (`resumeNow`, `resumeAfter`).
- `POST /batches/:id/policy` exige `authorized: true`.
  - **Solo restringe:** «publicar» y «activar» se mantienen o se quitan, nunca se añaden. Volver a la integración automática no está permitido.
  - **Es una sola escritura atómica:**
    - la autorización original y su evento no se tocan;
    - se añade `policyHistory` (antes/después, lo ya integrado, lo convertido) y un evento `policy`;
    - un merge hecho pero sin registrar (reinicio entre merge y registro) se registra antes como integrado.
  - **Se rechaza en estos casos:**
    - con una integración en curso (marca en memoria `integratingNow`, también en la integración automática);
    - con una puesta al día o su cierre en curso;
    - mientras se reconstruye el Portal o con una activación pedida sin comprobar.
- **Defensa en profundidad:**
  - `tick()` lee la política en cada historia;
  - `mergeStory` acepta un `guard` que se evalúa **dentro del carril del repositorio**, justo antes del merge: una pausa, un cambio de política o una aceptación anulada mientras esperaba vetan el merge;
  - publicar se lee al momento de publicar;
  - con integración al aceptar solo se activa lo aceptado.
- **«Reanudar» con la política que tienes delante:** `expectPolicy`; si no coincide, 409. La interfaz muestra qué hará con cada historia antes de pulsarlo.
- **Reconocer ≠ aceptar para integrar:** `acceptance.kind` vale `acknowledged` (ya estaba en main; no autoriza nada nuevo) o `integrate` (aceptas un candidato sin integrar).

### 2.2 Preparación apilada de las dependientes (`git.prepareDependents`, por defecto al aceptar)

- **Estado nuevo `prepared`.** La historia está terminada técnicamente (verificada, QA y Gauntlet) **sobre la versión provisional** de su dependencia, que es el commit verificado y revisado por QA de su rama, sin integrar.
  - No está «lista»: no se puede aceptar ni integrar.
  - El resumen la cuenta aparte («preparada sobre su dependencia»).
- **Solo se apila sobre** una dependencia:
  - `ready`;
  - con su commit verificado en el sandbox;
  - cubierta por QA;
  - que no esté a su vez apilada (un nivel).
  - Si no se puede, la dependiente espera con el motivo exacto y las demás siguen.
- **Antes de cualquier llamada** se crea, en el carril del repositorio, un worktree **desacoplado** en ese commit.
  - Si la dependencia ya cambió o la rama propia existe, no se gasta nada y vuelve a esperar. El fallo no se repite sobre esa misma versión.
  - El plan, las consultas, el Desarrollador y el puente MCP leen ese worktree.
  - La rama propia nace de ese commit en el primer commit (`applyChanges` con `base`).
  - Si un fallo retira el worktree, se restaura. Retomar sin él se detiene sin llamar a la IA (`ensureStackWorktree`).
- **Lo «suyo» se cuenta desde la versión provisional** (`ownBase`) mientras la dependencia no está en main. Esto cubre:
  - el diff que revisa QA;
  - la huella;
  - los archivos del plan de integración.
- **main nunca entra antes** en la rama apilada (`assertStackIntegrated` al preparar o resolver un candidato).
- `mergeStory` rechaza integrar una rama cuya versión provisional no está en main (`stack_base_not_integrated`), también desde la pantalla del proceso.
- **Al integrarse la dependencia,** la preparada pasa a `ready`:
  - se pone al día con main (git y sandbox);
  - si el código **propio** de la dependencia cambió desde la versión provisional (huella distinta), QA revisa otra vez aunque git no vea conflictos;
  - no se reimplementa nada.
- **Si la dependencia se rehace desde cero** (iteración nueva, no una ronda sobre su rama):
  - lo apilado sobre ella se detiene (sin seguir gastando) o vuelve a esperar;
  - lo terminado espera tu decisión con la versión provisional anulada;
  - nunca se integra;
  - «Iterar» lo rehace.
  - Si la dependencia ya estaba integrada, no se anula nada.

### 2.3 Vista previa aislada del candidato (`services/preview.ts`)

- **Qué se ve:**
  - el árbol que dejaría integrarla (`git merge-tree` de main + rama, en memoria; si choca, la rama sola y se dice);
  - si es apilada, «incluye la versión provisional de …».
- **Exportación** con índice temporal (`GIT_INDEX_FILE`) y `checkout-index`:
  - sin tocar HEAD, el índice, referencias ni el worktree;
  - sin atributos del candidato (`--attr-source` vacío: sin filtros, LFS, conversiones ni drivers);
  - las rutas protegidas se quitan del índice antes de escribir.
- **Perfiles:**
  - el Portal (compila la web y arranca el servidor con datos temporales, IA simulada y espacio interno sembrado);
  - o `npm run preview` del proyecto;
  - sin perfil, 409 con lo que hay que añadir.
- **Aislamiento:**
  - contenedor del candidato `--network none`, sin privilegios, raíz y copia de solo lectura;
  - tmpfs acotados para `/tmp` y la compilación, y dependencias del volumen de la verificación en solo lectura;
  - sin variables del servidor, credenciales ni datos;
  - límites de CPU, memoria, procesos y registros.
- **El navegador llega por un proxy HTTP de confianza:**
  - va en otro contenedor, en una red propia sin ICC, publicada en `127.0.0.2:<puerto>`: otro origen y otras cookies que el Portal;
  - el proxy habla con el candidato por un socket en un tmpfs de 1 MB.
- **Qué hace el proxy:**
  - exige su Host;
  - quita cookies, credenciales y diálogos de autenticación;
  - impone CSP (`connect-src 'self'`, `worker-src 'none'`, `form-action 'self'`, `frame-ancestors 'none'`, `sandbox`);
  - impone `Permissions-Policy` sin cámara, micrófono ni portapapeles;
  - añade una franja fija «Vista previa aislada · candidato X + main Y · NO es el Portal en marcha: no escribas claves ni datos reales».
- **Ciclo de vida:**
  - una a la vez por instancia (reservada antes del primer `await`);
  - 45 minutos, también con `timeout` dentro de los contenedores;
  - se detiene sola si el candidato se integra o vuelve a trabajar;
  - una revisión periódica retira huérfanos;
  - al arrancar se retiran las de esta instancia (por etiqueta de propietario).
  - Detenerla no toca el worktree ni la rama; el registro (`result.previews`: commit, main, árbol, estado, motivo, últimas líneas) queda como evidencia.
- **Decisiones ligadas al commit:**
  - aceptar y «Pedir cambios» envían el commit que revisaste (el de la vista previa abierta, o el de la evidencia);
  - si el candidato cambió, 409 `revision_changed`;
  - con una vista previa abierta de otro commit, «Aceptar» está deshabilitado.
  - La interfaz recuerda que ni la vista previa ni QA sustituyen tu prueba.

### 2.4 Endurecimiento del Portal en marcha (`app.ts`)

- **Peticiones que cambian algo** (no GET) desde un origen que no sea `localhost`/`127.0.0.1:*` ni el propio: 403.
  - CORS no impedía que una petición «simple» llegara.
- **La API solo atiende un `Host` de bucle local** (contra DNS rebinding). Las excepciones:
  - `PORTAL_ALLOWED_HOSTS`;
  - escuchar en la red (`PORTAL_HOST` no local).
- **Llegar al Portal en marcha navegando desde otro sitio** (p. ej. una vista previa que redirige) muestra antes un aviso «Estás entrando en el Portal IA EN MARCHA».
- **`X-Frame-Options: DENY` y `frame-ancestors 'none'`.**

## 3. Gauntlet

| Ronda | Revisión independiente | Hallazgos |
|---|---|---|
| Diseño · política, git, reinicios | 11 (1 crítico, 4 altos) | <ul><li>**Crítico:** sin marca de integración automática en curso y con la conversión ciega, un `integrate()` esperando el carril integraba, reiniciaba y publicaba tras el cambio.</li><li>Lo integrado pendiente de activar quedaba atascado o se activaba sin aceptación.</li><li>Un merge sin registrar se presentaba «sin integrar».</li><li>main podía entrar en una rama apilada antes que su dependencia.</li><li>«Iterar» no rehacía una apilada anulada.</li><li>El worktree preparado podía desaparecer.</li><li>Ventana de caída al empezar.</li><li>Doble anclaje.</li></ul> |
| Diseño · seguridad, aislamiento y cuentas | 14 (1 crítico) | <ul><li>**Crítico:** el código del candidato, en el navegador del propietario, podía manejar el Portal en marcha (CORS de `127.0.0.1:*`, POST simples, marcos).</li><li>Proxy como puente al host.</li><li>`--internal` no probado.</li><li>Service workers y cookies.</li><li>Fugas por variables y montajes.</li><li>Disco.</li><li>Volumen de dependencias compartido.</li><li>LFS y CRLF al exportar.</li><li>Lectura del puente MCP.</li><li>Gasto que sigue tras anular.</li></ul> |
| Implementación · lotes | 9 (3 altos) | <ul><li>Una apilada anulada volvía sola a «preparada» en la siguiente pasada (reproducido en una prueba antes de corregir).</li><li>Una historia integrada a mano con «activar» se quedaba «integrándose» para siempre.</li><li>Bucle de reintentos con una dependencia con commits sin registrar.</li><li>Anulaciones de lo ya integrado.</li><li>«Reanudar» sobre una anulada.</li><li>QA repetida solo por traer main.</li><li>Escrituras tardías del trabajo en segundo plano.</li><li>Activación pedida.</li><li>Dependiente esperando a una ya integrada.</li></ul> |
| Implementación · seguridad | 14 (sin críticos) | <ul><li>La comprobación de salud seguía redirecciones (salida de red desde el host).</li><li>DNS rebinding con el Host.</li><li>Engaño por navegación o phishing.</li><li>Disco del motor (socket y registros).</li><li>Huérfanos al detener a medias.</li><li>Límite saltable con dos peticiones.</li><li>Vista previa sin forma de detenerla.</li><li>Aceptar otro commit.</li><li>`PORTAL_PREVIEW_HOST` inseguro.</li><li>Cookies.</li><li>Host en el proxy.</li><li>Red por defecto.</li><li>`timeout` anulable.</li><li>Atributos de git.</li></ul> |
| Correcciones (ronda 3) | 7 (1 alto, 1 medio) | **Alto:** con este mismo `app.ts` en main, el proxy reescribía el Host y la API del Portal candidato respondía 403 en la vista previa (reproducido con un candidato del árbol nuevo; ahora reenvía el Host comprobado y quita las Sec-Fetch; «lista» exige que su API responda). **Medio:** una ruta codificada (`/%61pi/…`) saltaba la comprobación del Host (ahora se comprueba en toda petición). Además: una apilada detenida volvía a «en marcha» mientras se cancelaba; reintentar arrastraba una base anulada; QA forzada contra una versión rehecha sin integrar; vista previa de una iteración antigua ocupando el hueco; redes/volúmenes huérfanos. |

Todos los hallazgos se corrigieron. Los materiales llevan prueba de regresión:

- la anulación persistente;
- la integración manual con «activar»;
- la integración automática en curso;
- el veto dentro del carril;
- el Host y la franja del proxy;
- el Host de la API (también con la ruta codificada) y el aviso de navegación cruzada;
- el Host y las Sec-Fetch que recibe el candidato.

Se aceptan, documentados en §7:

- el aislamiento en macOS;
- comparar commits por 7 caracteres, como en todo el Portal.

## 4. Pruebas y evidencia

- **`apps/server/test/puerta-final.test.ts`** (5 pruebas; git real, proveedor simulado, vistas previas en Docker real):
  - **Lote existente como 568c60cb.** Con integración automática y activación: integradas, un candidato con conflictos resueltos sin QA, una QA inconclusa. Lo que comprueba:
    - vista previa del cambio;
    - 400 sin confirmar y 409 al ampliar;
    - cambio registrado, con autorización y uso de suscripción intactos;
    - 0 llamadas;
    - «Reanudar» con `expectPolicy`;
    - las dos quedan **listas sin integrar, activar ni publicar**;
    - «Reconocer» lo integrado;
    - aceptar ligado al commit (409 con otro).
  - **Cambio de política con una integración automática esperando el carril:** 409; una pausa mientras espera veta el merge; `mergeStory` con `guard` no integra.
  - **Cinco historias, la 2 depende de la 1** (escenario del encargo, pasos 1–15):
    - la 2 preparada sobre la 1 con diff solo suyo;
    - aceptarla o integrarla a mano antes, rechazado;
    - vista previa de la 1 en `127.0.0.2` con CSP, sandbox, franja y sin cookies; Host ajeno rechazado por el proxy y por la API;
    - aviso de navegación cruzada;
    - POST con su origen → 403;
    - pedir cambios sobre el commit probado (409 con otro);
    - la 1 integrada;
    - la 2 al día con la versión final, con QA otra vez y sin reimplementar;
    - vista previa y aceptación de la 2;
    - las demás integradas;
    - 5 merges, ninguno doble;
    - nada publicado ni activado;
    - una implementación por historia.
  - **La dependencia se rehace desde cero:** la apilada queda anulada (también tras más pasadas); merge y candidato rechazados; main intacto.
  - **Integrada a mano con «activar» al aceptar:** queda pendiente de aceptación sin activar y el lote sigue.
- **`lote-integracion-al-aceptar.test.ts`:** la ronda D fija `prepareDependents: false` (el caso sin apilar).
- **Navegador real** (`e2e-puerta-final.mjs`, fuera del repositorio): Portal aislado, Docker real, Chromium, **25/25**.
  - **Parte A (lote existente):** qué haría «Reanudar», diálogo de cambio, confirmación obligatoria, cambio registrado sin llamadas, reanudar sin integrar, reconocimiento.
  - **Parte B (cinco historias):** todo el recorrido del encargo en la interfaz, vistas previas abiertas en pestañas y bloqueo de la página para hablar con el Portal.
- **Perfil «portal»:** un candidato del propio Portal construido con el árbol de esta rama (clon temporal) compila y sirve en unos 9 s. A través del proxy:
  - su API responde 200 (también un POST de su mismo origen);
  - su interfaz completa se ve en Chromium sin errores de consola bajo la CSP, con la franja y sin el aviso del Portal en marcha;
  - al detenerla no queda ningún contenedor.

## 5. Lote real `568c60cb`: opciones

Estado conocido:

- 6 historias integradas y activas, pendientes de tu aceptación;
- HU-167 aceptada;
- HU-169: candidato verificado sin QA;
- HU-173: QA inconclusa;
- HU-175: auditoría sin plan de archivos.

Sin dependencias entre ellas, así que la preparación apilada no aplica.

1. **Cambiar a «integrar al aceptar» antes de reanudar (recomendado).** En su pantalla: «Cambiar a "integrar al aceptar"…».
   - Decides si mantienes publicar en GitHub y reconstruir y reiniciar al integrar lo que aceptes.
   - Las 6 integradas siguen en main; «Reconocer y aceptar» las cierra sin autorizar nada nuevo.
   - «Reanudar»:
     - QA revisa HU-169 y repite HU-173 una vez;
     - las dos quedan **listas sin integrar**;
     - HU-169 se pondrá al día con el main nuevo (activar esta rama cambia archivos compartidos): git, sandbox, y QA si hace falta.
   - Las pruebas con su vista previa y las aceptas una a una.
2. **Reanudar con la política original.** La pantalla dice antes qué hará: lo que apruebe QA entra en main, se publica y se activa sin tu revisión.
3. **Cerrar el lote** sin IA. Lo integrado queda; lo no integrado se conserva en su rama.

En los tres casos, HU-175 se convierte en encargo de análisis desde su proceso.

## 6. Activación

- **Sin migraciones:** todos los campos nuevos son opcionales y los lotes anteriores se leen igual (`integration` ausente = automática; `prepareDependents` ausente = no).
- **Nada se ejecuta solo al arrancar,** salvo la limpieza de vistas previas de esta instancia (ninguna antes de activar).
- **La vista previa necesita** Docker con la imagen `portal-ia-sandbox:1`, que ya tienes, y el volumen de dependencias del package-lock del candidato, que crea la verificación.

## 7. Limitaciones

- **Vista previa:**
  - Una a la vez. Perfil del Portal o `npm run preview`; para otros proyectos hay que añadir ese script (R1 lo generalizará).
  - El Portal de la vista previa empieza vacío (espacio interno, agentes base, IA simulada): no hay datos reales que probar.
  - El navegador ejecuta código sin aceptar en `127.0.0.2`. Los controles (CSP, sandbox, sin cookies, Host, franja, aviso al saltar al Portal) reducen el riesgo, pero no conviertan la vista previa en un lugar para escribir claves reales.
  - En macOS hay que crear el alias de `127.0.0.2` (`sudo ifconfig lo0 alias 127.0.0.2`).
- **Apilado:**
  - Un solo nivel.
  - Si la dependencia se rehace desde cero, la apilada se rehace (con IA). Trasplantar sus commits sin IA queda pendiente.
  - Las preparadas sobre una dependencia que acabas rechazando han gastado llamadas; la vista previa del lote lo avisa con su estimación.
- **Política:**
  - Solo se pasa de automática a «al aceptar» (restringir).
  - Volver a la automática exige otro lote.
- **Reconocer** una historia integrada que no está activa sigue exigiendo activarla antes (regla del proyecto interno).
- **Los commits se comparan por sus 7 primeros caracteres,** como en el resto del Portal.
- **Con un Host distinto de `localhost`/`127.x`** (proxy inverso), la API exige declararlo en `PORTAL_ALLOWED_HOSTS`.
