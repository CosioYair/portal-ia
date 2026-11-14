# Imagen de medios del Estudio de Portal IA: FFmpeg aislado (ver docs/portal-ia-4/estudio.md).
# Construir una vez (necesita red; después cada exportación corre SIN red, sin privilegios y con límites):
#   docker build -t portal-ia-media:1 -f docker/media.Dockerfile docker
# FFmpeg se usa como programa aparte (no se enlaza ni se redistribuye con el Portal). El paquete de Alpine incluye
# componentes GPL (x264): es una herramienta local del propietario, no parte del código del Portal.
FROM alpine:3.20
RUN apk add --no-cache ffmpeg ttf-dejavu \
 && adduser -D -u 1000 media \
 && mkdir -p /in /out && chown media:media /out
USER media
WORKDIR /out
ENTRYPOINT []
