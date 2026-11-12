# Sandbox de verificación (Hito 1)

El código que proponen los agentes **nunca se ejecuta en tu equipo**. Las verificaciones (`typecheck`, `test`, `build`, `install`) corren sobre el *worktree* del proceso dentro de un entorno aislado. Si no hay ninguno disponible, el Portal queda **fail-closed**: `install`, `test` y `build` no se ejecutan, solo se permite la verificación mínima `tsc --noEmit` (el compilador ya instalado, sin scripts del repositorio), y el proyecto interno **no se integra** sin `test` y `build` en sandbox real.

Estado actual: `GET /api/system/sandbox` o la tarjeta «Repositorio» del panel.

## Opción A · Docker Desktop (recomendada en Windows)

1. Instala [Docker Desktop](https://www.docker.com/products/docker-desktop/) con el motor WSL2 (opción por defecto).
2. Arráncalo y comprueba en una terminal: `docker version --format "{{.Server.Os}}"` → debe imprimir `linux`.
3. Construye la imagen del sandbox una vez, desde la carpeta del Portal (necesita red; después todo funciona sin red):
   ```
   docker build -t portal-ia-sandbox:1 -f docker/sandbox.Dockerfile docker
   ```
   Es `node:22-bookworm-slim` con `git` (las pruebas del Portal crean repositorios) y `procps` (`ps`, que usa el apagado limpio). Repite el comando si cambia `docker/sandbox.Dockerfile`. Sin la imagen, el sandbox aparece como no disponible (fail-closed; el Portal nunca la descarga por su cuenta: `--pull never`).
4. Reinicia el Portal (o pulsa «Actualizar estado» en la tarjeta Repositorio). El sandbox aparecerá como `docker`.
5. En el primer proceso (y cada vez que cambie `package-lock.json`): «npm ci (install)» con «Permitir red solo para install». Instala las dependencias **Linux** en un volumen de Docker; typecheck, test y build lo reutilizan sin red.

Cada verificación lanza un contenedor efímero (simplificado):

```
docker run --rm --init --pull never --read-only --network none --memory 2g --cpus 2 --pids-limit 512 \
  --security-opt no-new-privileges --cap-drop ALL --user 1000:1000 \
  --mount type=tmpfs,target=/tmp -e CI=1 -e HOME=/tmp … \
  --mount "type=bind,source=C:\…\Portal IA-worktrees\<proceso>,target=/work" \
  --mount type=volume,source=portal-ia-nm-<hash>,target=/work/node_modules,readonly \
  --mount type=tmpfs,target=/work/node_modules/.vite-temp … \
  -w /work portal-ia-sandbox:1 sh -c "npm test"
```

- Sin red (`--network none`), salvo `install`, que exige la confirmación «Permitir red solo para install» y muestra antes el diff de `package.json`. `install` es `npm ci --ignore-scripts`: no ejecuta scripts del repositorio.
- **Dependencias Linux en un volumen** `portal-ia-nm-<hash>` (hash de la imagen y del `package-lock.json`, sin distinguir CRLF/LF). Los `node_modules` de tu equipo no sirven dentro (binarios de Windows como `@esbuild/win32-x64` y enlaces a rutas `C:\…`), así que nunca se montan. `install` llena el volumen; el resto de comandos lo montan **en solo lectura** (con tmpfs privados para las cachés `.vite-temp`, `.vite` y `.cache`) y, si aún no se instaló, terminan con código 86 y el aviso de ejecutar `install`.
- El worktree es lo único escribible del equipo; la carpeta del Portal y `data/` no se montan. Raíz del contenedor de solo lectura y `/tmp` privado.
- Al contenedor solo entran variables explícitas (`-e CLAVE=valor`): ninguna clave, ruta de datos ni variable del Portal. El proceso `docker` (el CLI, no el contenedor) recibe solo las variables que Docker Desktop necesita para encontrar su configuración (`PATH`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`, `SYSTEMROOT`, `DOCKER_*`…).
- Límites de memoria, CPU, procesos y tiempo (10 min; al agotarse se elimina el contenedor).
- Cada comando imprime al final su código de salida (`__PORTAL_IA_EXIT__=N`). Con mucha actividad, Docker Desktop a veces no registra el final de un contenedor (queda «Up» sin procesos y `docker run` no vuelve): si la marca llegó y el CLI no responde en 15 s, el Portal retira el contenedor y usa ese código, en lugar de esperar los 10 minutos. Queda anotado en la salida de la verificación.
- Dentro del contenedor el worktree no ve su `.git` (apunta a una ruta de Windows): el código del repositorio no puede leer ni tocar la historia git del Portal.

Volúmenes antiguos (de `package-lock.json` anteriores): `docker volume ls --filter name=portal-ia-nm-` y `docker volume rm <nombre>`.

Variables opcionales: `PORTAL_SANDBOX_IMAGE` (imagen alternativa; necesita `git`, `ps` y un usuario 1000 con `/work/node_modules` suyo), `DOCKER_HOST`, `DOCKER_CONTEXT`.

Comprobación automática: `apps/server/test/sandbox-docker.test.ts` (construcción de la orden, sin Docker; y, si Docker está disponible, un script que intenta encontrar la carpeta del Portal y los datos, escribir fuera del worktree y en las dependencias, leer variables del equipo y salir a Internet: todo debe fallar y solo el worktree debe aceptar escrituras).

### Imagen por rama (EN-024)

Cada proceso se verifica con la imagen que corresponde al `docker/sandbox.Dockerfile` de **su** worktree, no con la que haya en el equipo.

- **Etiqueta por hash.** Se calcula el sha256 del Dockerfile de la rama, sin distinguir CRLF de LF. La imagen de rama se llama `portal-ia-sandbox:df-<hash12>` y lleva la etiqueta `portal-ia.dockerfile-sha=<hash>`.
- **Qué imagen se usa.** Si existe `df-<hash12>`, se usa esa. Si no existe, se usa la imagen por defecto (`portal-ia-sandbox:1` o `PORTAL_SANDBOX_IMAGE`) en dos casos: si su etiqueta `portal-ia.dockerfile-sha` coincide con el hash, o si el Dockerfile de la rama es igual al de main. En cualquier otro caso la imagen está **desactualizada**: el estado del sandbox lo dice así («imagen desactualizada») y nunca como «Docker disponible». Un worktree sin Dockerfile usa la imagen por defecto.
- **La imagen queda guardada en el proceso.** Las verificaciones de ese proceso la usan y aparece en la cabecera de la salida. El volumen de dependencias `portal-ia-nm-<hash>` depende de la imagen, así que con una imagen nueva hay que volver a ejecutar `install`.
- **Pausa por la imagen.** La verificación o QA puede pausarse por el entorno porque a la imagen le falta algo (por ejemplo, Chromium o Playwright) o porque está desactualizada. Esa pausa queda marcada como relacionada con la imagen. La tarjeta de la historia ofrece, por este orden:
  1. «Reconstruir la imagen del sandbox desde la rama» (acción principal);
  2. «Comprobar el sandbox de nuevo»;
  3. «Continuar»;
  4. «Pedir corrección», solo si QA dejó hallazgos de código.
- **Reconstrucción autorizada** (`POST /api/workspaces/:slug/processes/:id/sandbox/rebuild-image` con `{ "authorized": true, "allowNetwork": true }`):
  - Sin autorización no se lanza Docker y la ruta responde con un error (fail-closed).
  - Ejecuta `docker build --pull --network default --label portal-ia.dockerfile-sha=<hash> -t portal-ia-sandbox:df-<hash12> -f <worktree>/docker/sandbox.Dockerfile <worktree>/docker`. La red solo se usa durante la construcción; las verificaciones siguen con `--network none`.
  - La operación queda auditada en el historial de ejecución y tiene un límite de 20 minutos.
  - **Nunca** reetiqueta ni sobrescribe `portal-ia-sandbox:1` ni `PORTAL_SANDBOX_IMAGE`, que son las imágenes de main y de los demás procesos. `buildImageArgs` rechaza cualquier etiqueta que no sea `df-<hash>`.
  - Si la construcción falla, la tarjeta muestra la salida recortada, la pausa se mantiene y sus acciones siguen disponibles.
- **Reanudación sin IA.** Después de reconstruir, «Continuar» no gasta presupuesto de IA:
  - repite con la imagen nueva la verificación determinista (typecheck, test, build y los scripts de verificación ya definidos);
  - recalcula el veredicto de QA con `replayQaVerdict` a partir del veredicto guardado en la pausa. Quita los bloqueos de entorno si la verificación pasa y conserva los hallazgos de código. No se llama a `complete()`.
  - Si la verificación vuelve a fallar por el entorno, la historia se pausa otra vez por la imagen.
- **«Comprobar el sandbox de nuevo»** (`GET /api/workspaces/:slug/processes/:id/sandbox-check?since=<fingerprint>`) es de solo lectura: no modifica el proceso.
  - Muestra **en la tarjeta** el motor, la imagen, si está desactualizada y si la pausa sigue.
  - Compara con la lectura anterior del cliente (`since`). Si no la hay, compara con la instantánea del entorno guardada al pausar.
  - Si nada cambió, lo dice («Nada cambió desde la última comprobación») y señala la acción que lo resuelve.

Para borrar imágenes de rama antiguas, lístalas con `docker image ls portal-ia-sandbox` y elimínalas con `docker image rm portal-ia-sandbox:df-<hash12>`. Esto no afecta a `:1`.

## Opción B · Distribución WSL2 dedicada (sin Docker)

1. `wsl --install -d Ubuntu` (si aún no tienes WSL2).
2. Crea una distribución aparte solo para el sandbox, con el nombre exacto `PortalIA-sandbox`:
   ```
   wsl --export Ubuntu C:\temp\ubuntu.tar
   wsl --import PortalIA-sandbox C:\PortalIA-sandbox C:\temp\ubuntu.tar
   ```
3. Dentro (`wsl -d PortalIA-sandbox`): instala Node 22 (`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs`) y crea un usuario sin privilegios como predeterminado (`/etc/wsl.conf` → `[user] default=sandbox`).
4. Comprueba: `wsl -l -q` lista `PortalIA-sandbox`. El Portal la detecta al arrancar.

En WSL las verificaciones corren con `unshare -rn` (sin red) y `env -i` (sin variables del Portal). El aislamiento es menor que en Docker (comparte kernel y puede ver el sistema de archivos de Windows): úsalo solo si Docker no es posible. Nombre alternativo: `PORTAL_WSL_DISTRO`.

## Opción C · Linux sin Docker: espacios de nombres (`linux-ns`)

Si el Portal corre en Linux y Docker no está disponible, se usa `unshare -rn -m` (espacios de nombres de usuario, red y montaje) automáticamente:

- sin red (salvo `install` con red confirmada);
- tu HOME, la carpeta del Portal, su carpeta padre y la carpeta de datos se montan **en solo lectura**; `/tmp` es un tmpfs privado; solo el worktree del proceso es escribible (`node_modules` del Portal se enlaza en solo lectura);
- entorno vacío (`env -i`), sin variables ni claves del Portal.

Comprobación automática: `apps/server/test/sandbox-linux.test.ts` ejecuta un script que intenta escribir en el Portal, en HOME y en los datos y salir a Internet; todo debe fallar y solo el worktree debe aceptar escrituras. Aislamiento menor que Docker (mismo kernel; el resto del sistema de archivos del usuario sigue visible), pero suficiente para que un `npm test` generado no toque tu instalación.

## Sin sandbox

- `typecheck` → verificación mínima en el equipo (`tsc --noEmit`, entorno vacío). Se marca como `host-min`, no como sandbox.
- `test`, `build`, `install` → no se ejecutan; el resultado queda registrado como «no disponible» (fail-closed).
- Proyectos de empresas: pueden integrarse con `typecheck` en verde. Proyecto interno (el propio Portal): **no se integra** sin `test` y `build` en sandbox.

Esta restricción no se puede desactivar desde la interfaz. `PORTAL_SANDBOX=none` existe solo para las pruebas automáticas (fuerza «no disponible»).

## Qué sí corre en tu equipo

- `git` (worktrees, merge, push) con las credenciales de tu equipo, siempre tras tu autorización por uso.
- «Reconstruir y reiniciar» (`npm install` si cambió `package.json`, `npm run build`, reinicio por supervisor): es la activación del Portal, solo sobre código ya integrado y verificado en sandbox, y solo cuando lo pulsas.
- Las comprobaciones en ejecución (`http` con `fetch` al propio Portal; `ui` con Playwright si está instalado: `npm i -D playwright && npx playwright install chromium`).
