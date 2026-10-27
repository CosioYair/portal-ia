# Imagen del sandbox de verificación de Portal IA (ver docs/sandbox.md).
# Construir una vez (necesita red; después las verificaciones corren sin red):
#   docker build -t portal-ia-sandbox:1 -f docker/sandbox.Dockerfile docker
FROM node:22-bookworm-slim

# git: las pruebas del Portal crean repositorios y worktrees temporales.
# procps (ps): el apagado limpio del servidor localiza a sus descendientes con `ps -A` (lifecycle.ts).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

# /work es el punto de montaje del worktree. /work/node_modules es el punto de montaje del volumen
# de dependencias Linux (portal-ia-nm-<hash>): al crearse vacío, Docker copia este directorio con su
# propietario, así el usuario sin privilegios (node, 1000:1000) puede instalar en él. Las cachés son los puntos de
# montaje de los tmpfs que se ponen encima del volumen de solo lectura (deben existir ya en un volumen recién creado).
RUN mkdir -p /work/node_modules/.vite-temp /work/node_modules/.vite /work/node_modules/.cache && chown -R node:node /work

USER node
WORKDIR /work
