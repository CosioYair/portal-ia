# Portal IA · Instalación, arranque, parada y reinicio en Windows

Requisitos: Node.js ≥ 22.13 (incluye `node:sqlite`), Git, y para el sandbox de verificación **Docker Desktop** (motor WSL2) o una distribución WSL2 dedicada (ver `docs/sandbox.md`). Sin sandbox, el Portal arranca igual pero no integra historias del propio Portal (fail-closed).

## Instalar / actualizar desde el zip

1. Cierra el Portal si está corriendo (Ctrl+C en su terminal).
2. Ponte en `main` con el árbol limpio (las versiones anteriores dejaban el checkout en la rama de la última historia, p. ej. `portal-ia/hu-147`; la 0.12 ya no lo hace):
   ```
   git status
   git checkout main
   ```
   Si `git status` muestra cambios que quieres conservar, confírmalos antes (`git add -A && git commit -m "…"`).
3. Descomprime `portal-ia-v0.12.0.zip` **sobre** tu carpeta `C:\Mis Proyectos\Portal IA` aceptando sobrescribir (el zip no incluye `data\`, `node_modules\`, `dist\` ni `.git`: tus datos e historial no se tocan). El zip ya contiene el trabajo de HU-147.
4. Retira los tres archivos del panel de feedback anterior (la 0.12 los sustituye por la lista unificada; si se quedan no rompen nada, pero son código muerto):
   ```
   git rm apps/web/src/screens/ManualTestFeedbackPanel.tsx apps/web/src/components/ManualTestStepFeedback.tsx apps/web/src/components/FailedStepsSummary.tsx
   ```
5. Instala, compila y comprueba:
   ```
   npm install
   npm run build
   npm run typecheck
   npm test
   ```
   Esperado: typecheck sin errores; `npm test` con 99 correctas y 1 omitida (la del sandbox de Linux, que en Windows no aplica).
6. Confirma en tu repositorio:
   ```
   git add -A
   git commit -m "Portal IA v0.12.0"
   ```
   La rama `portal-ia/hu-147` puede quedarse o borrarse (`git branch -D portal-ia/hu-147`): su contenido ya está en el zip.

Al primer arranque de la 0.12 el servidor copia `data\` en `data\backups\<fecha>_antes-de-0.12` antes de abrir las bases (migraciones solo aditivas: columnas y tablas nuevas; nada se borra ni se reescribe).

## Arrancar

```
npm start
```

`npm start` lanza el **supervisor** (`scripts/portal-start.mjs`), que arranca el servidor en `http://127.0.0.1:4310` y lo relanza automáticamente cuando el Portal se reconstruye y reinicia desde la interfaz (código de salida 75). Sin supervisor (`npm run start:server`) el Portal funciona igual, pero «Reconstruir y reiniciar» lo apaga y tendrás que arrancarlo a mano (la pantalla te muestra los comandos).

Variables opcionales (archivo `.env` en la raíz o variables del sistema): `PORTAL_PORT` (4310), `PORTAL_DATA_DIR` (`.\data`), `PORTAL_SANDBOX_IMAGE` (`node:22-alpine`), `PORTAL_WSL_DISTRO` (`PortalIA-sandbox`).

## Parar

Ctrl+C en la terminal del supervisor (apagado limpio: libera el puerto, termina procesos hijos). También: botón «Reiniciar» de la barra del sistema con el supervisor parado = apagado.

## Reiniciar

- Desde la interfaz: barra del sistema → «Reconstruir y reiniciar» (con tu autorización: `npm install` si cambió `package.json`, `npm run build` a `dist.next` y reinicio por el supervisor; si el build falla, la interfaz anterior sigue sirviéndose y el servidor no se reinicia).
- Desde la terminal: Ctrl+C y `npm start`.

Si el puerto 4310 queda ocupado por un proceso anterior, el arranque lo indica con el PID; termínalo (`taskkill /PID <pid> /F`) o cambia `PORTAL_PORT`.

## Pruebas automáticas

```
npm run typecheck
npm test
```

`npm test` usa un proveedor **simulado** (`PORTAL_MOCK_PROVIDER=1` lo fijan las propias pruebas que lo necesitan) y no consume créditos. La prueba de extremo a extremo de automejora (`node apps/server/test/e2e/self-improvement.e2e.mjs`) arranca una copia temporal del Portal y requiere sandbox (en Windows: Docker Desktop) y Playwright instalado para la comprobación de interfaz; sin Playwright, las comprobaciones `ui` quedan «pendientes» (nunca se dan por buenas).

## Primera automejora real (con tu proveedor, con tu autorización)

1. Panel → Repositorio: debe decir «carpeta de este Portal» (si no, «Usar la carpeta de esta instalación»). Sandbox: `docker` o `wsl`.
2. Backlog → «Nueva solicitud»: por ejemplo «Mostrar el número de historias abiertas en el título de Backlog», criterio «El título de /backlog termina en (N abiertas)».
3. «Ejecutar»: revisa el equipo propuesto (por capacidades, sin IA), la estimación (es una estimación; el costo real se registra por paso) y autoriza con presupuesto (1 USD basta).
4. Al terminar, abre **Espacio de la historia** (botón en Backlog o en el proceso): Resumen → revisar diff → **Aplicar** (worktree aislado; tu carpeta no cambia) → **Verificar** typecheck, test y build en sandbox → **Integrar** → barra del sistema «Reconstruir y reiniciar» → «**Comprobar en ejecución**» (el Portal se consulta a sí mismo; captura de evidencia en `data\evidence\<proceso>\`) → prueba paso a paso (OK/Falla/Observación por paso) → **Marcar historia como completada**. Publicar en GitHub es opcional.
5. Si algo falla: en el Espacio de la historia, pestaña Chat (pregunta al equipo con autorización), Tareas (crea tareas desde los pasos con falla) e Iteraciones («Crear iteración» con el feedback; se autoriza aparte). Las lecciones detectadas aparecen en Conocimiento → Lecciones.
