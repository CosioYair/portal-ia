# Imagen de análisis de artefactos de Portal IA: REA («Reverse Engineer Anything») AISLADO.
# Ver docs/portal-ia-4/especialista-rea.md. Construir una vez (necesita red; después cada análisis corre SIN red):
#   docker build -t portal-ia-rea:6.9.0 -f docker/rea.Dockerfile docker
#
# Decisiones de seguridad:
#  - Versión FIJADA y comprobada: si el paquete que sirve npm no tiene esta huella, la imagen no se construye.
#  - `--ignore-scripts --omit=optional`: no se ejecuta ningún script de instalación ni se instala Frida
#    (instrumentación en vivo). Solo análisis estático.
#  - Nunca se ejecuta `rea setup`: no toca la configuración de Claude Code ni instala nada en la máquina del propietario.
#  - Node propio (24): REA exige una versión distinta de la del Portal; no se cambia la del Portal.
# REA es software de terceros (MIT, github.com/morluto/rea). Quitarlo = borrar esta imagen.
FROM node:24-bookworm-slim

ARG REA_VERSION=6.9.0
ARG REA_INTEGRITY=sha512-KqDn1UR5BMqHoQ3MGAnPuWiSKwgdFaz1L/uUNgrKt+1W8kPtgYP8AWEOXIF1lDIOBVyPuYIIst2iamo1Wf3r8g==

RUN apt-get update \
 && apt-get install -y --no-install-recommends procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    got="$(npm view "rea-agents@${REA_VERSION}" dist.integrity)"; \
    if [ "$got" != "$REA_INTEGRITY" ]; then echo "La huella de rea-agents@${REA_VERSION} no coincide con la fijada: $got" >&2; exit 1; fi; \
    npm install --global "rea-agents@${REA_VERSION}" --omit=optional --ignore-scripts --no-audit --no-fund; \
    npm cache clean --force; \
    mkdir -p /target /evidence && chown node:node /evidence

ENV REA_VERSION=${REA_VERSION} NODE_ENV=production NO_UPDATE_NOTIFIER=1 REA_LOG_LEVEL=error
USER node
WORKDIR /evidence
ENTRYPOINT []
