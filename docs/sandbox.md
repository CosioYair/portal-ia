# Sandbox de verificación (Hito 1)

El código que proponen los agentes **nunca se ejecuta en tu equipo**. Las verificaciones (`typecheck`, `test`, `build`, `install`) corren sobre el *worktree* del proceso dentro de un entorno aislado. Si no hay ninguno disponible, el Portal queda **fail-closed**: `install`, `test` y `build` no se ejecutan, solo se permite la verificación mínima `tsc --noEmit` (el compilador ya instalado, sin scripts del repositorio), y el proyecto interno **no se integra** sin `test` y `build` en sandbox real.

Estado actual: `GET /api/system/sandbox` o la tarjeta «Repositorio» del panel.

## Opción A · Docker Desktop (recomendada en Windows)

1. Instala [Docker Desktop](https://www.docker.com/products/docker-desktop/) con el motor WSL2 (opción por defecto).
2. Arráncalo y comprueba en una terminal: `docker version --format "{{.Server.Os}}"` → debe imprimir `linux`.
3. Descarga la imagen una vez (después funciona sin red): `docker pull node:22-alpine`.
4. Reinicia el Portal (o pulsa «Actualizar estado» en la tarjeta Repositorio). El sandbox aparecerá como `docker`.

Cada verificación lanza un contenedor efímero:

```
docker run --rm --network none --memory 2g --cpus 2 --pids-limit 512 \
  --security-opt no-new-privileges --cap-drop ALL --user 1000:1000 \
  -e CI=1 -e HOME=/tmp -v <worktree>:/work -v <repo>/node_modules:/work/node_modules:ro \
  -w /work node:22-alpine sh -c "npm run test"
```

- Sin red (`--network none`), salvo `install`, que exige la confirmación «Permitir red solo para install» y muestra antes el diff de `package.json`.
- Sin variables de entorno del Portal (ni claves, ni rutas de datos).
- `node_modules` del Portal montado en solo lectura; el worktree es lo único escribible.
- Límites de memoria, CPU, procesos y tiempo (10 min).

Variables opcionales: `PORTAL_SANDBOX_IMAGE` (imagen alternativa, p. ej. `node:22`), `DOCKER_HOST`.

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
