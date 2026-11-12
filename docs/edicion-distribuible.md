# Edición distribuible de Portal IA (HU-211)

La **Edición** es la copia de Portal IA que se entrega a otras empresas. La genera solo el **Estudio** (la instalación del núcleo, con `PORTAL_EDITION=studio`) a partir de un árbol de trabajo limpio. No lleva datos, credenciales ni historial del Estudio.

## Cómo se genera (en el Estudio)

1. Confirma o descarta todos los cambios: `git status --porcelain` debe salir vacío.
2. Compila la interfaz con `npm run build`. El build (`apps/web/dist/build-info.json`) tiene que ser del commit actual (HEAD).
3. Ejecuta `npm run edition:build` (o `npm run edition:build -- --out <carpeta>`).

El ZIP se escribe en la carpeta hermana `<repo>-ediciones`, o en la que indique `--out`, y se llama `portal-ia-edicion-<versión>-<sha7>.zip`. Nunca se escribe dentro del repositorio ni de la carpeta de datos, y nunca sobrescribe un ZIP que ya exista. Al terminar se muestran el archivo, el commit, el número de entradas, el tamaño y el sha256. Guarda el sha256 y el commit para saber qué versión entregaste a cada empresa.

La generación se detiene sin dejar ningún ZIP en estos casos:

- Hay cambios sin confirmar. El mensaje lista hasta 10 rutas y pide confirmar o descartar los cambios.
- Falta el build compilado, o es de otro commit.
- Algún archivo parece contener un secreto. Se informa de la ruta y del tipo de secreto, nunca de su valor.
- `validatePortableBundle` (perfil `edition`) encuentra un problema, por ejemplo una ruta local del equipo o de la carpeta de datos.
- Se intenta generar desde una Edición. Solo el Estudio puede generar la Edición.

## Qué contiene

- El código necesario para ejecutar: `apps/server/src`, `apps/web/src`, `apps/web/index.html`, `packages/*/src`, los `package.json`, `package-lock.json` y los `tsconfig*.json`.
- Las herramientas de documentos de `apps/server/tools` (scripts de Python y `kits/`), que el servidor usa al ejecutar las habilidades de PDF. Para usarlas hace falta Python 3 en el equipo de la empresa.
- El build compilado de la interfaz, en `apps/web/dist/`.
- El lanzador `scripts/portal-edition-start.mjs`.
- `README.md`, `.env.example` y este documento.

## Qué excluye

- La carpeta de datos `data/`, que guarda empresas, proyectos, agentes, conocimiento, historial y bases de datos.
- Los archivos `.env` (solo se incluye `.env.example`), la clave maestra y cualquier archivo `*.sqlite`.
- `.git` y `node_modules` (las dependencias se instalan con `npm ci`).
- Las pruebas (`apps/server/test`) y la vista previa de automejora (`scripts/preview-runner.mjs`).

## Cómo se lanza (en el equipo de la empresa)

1. Descomprime el ZIP en una carpeta nueva.
2. Ejecuta `npm ci` para instalar las dependencias. Necesitas Node 22.13 o superior.
3. Ejecuta `npm run start:edition`. Es la **única** forma de arrancar la Edición.

> **`npm start` no está disponible en la Edición.** El `package.json` es el mismo que el del Estudio y su script `start` apunta a `scripts/portal-start.mjs`. Ese archivo es el supervisor de automejora del Estudio y no se incluye en el ZIP. Si ejecutas `npm start`, Node termina con un error de módulo no encontrado (`Cannot find module …scripts/portal-start.mjs`). No es una instalación dañada: usa `npm run start:edition`. Tampoco funcionan `npm run dev` ni `npm run edition:build`, que son solo del Estudio.

El lanzador fija siempre `PORTAL_EDITION=distributable`, aunque el entorno traiga otro valor, y usa `./data` como carpeta de datos salvo que se indique `PORTAL_DATA_DIR`. No instala nada: si faltan el build o las dependencias, se detiene y pide `npm ci`. Tampoco tiene supervisor de reinicio.

## Arranca vacía y con presupuesto 0

Con una carpeta de datos nueva, la Edición arranca sin espacios ni empresas. Tampoco hay ningún presupuesto mensual definido: el saldo de la empresa aparece como «sin configurar», con límite 0, y toda reserva de gasto se deniega (`no_limit`).

En la práctica, **la Edición no gasta nada hasta que fijes un presupuesto mensual de empresa y de proyecto; mientras tanto, se deniega cualquier acción con costo**. No es un fallo: es la protección por defecto.

## Limitaciones

- No tiene automejora. Reconstruir, reiniciar y activar cambios responden 403 (HU-205). Las actualizaciones llegan como una Edición nueva generada en el Estudio.
- No se actualiza sola ni migra datos de otra instalación. Las credenciales de los proveedores de IA se configuran en cada instalación.
- Hace falta conexión para ejecutar `npm ci` la primera vez.
- El ZIP no está firmado. Su integridad se comprueba comparando el sha256 que mostró el Estudio.
