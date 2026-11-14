# Videos de descubrimiento (Facebook) — inspección real

Inspección hecha el 2026-11-14 con Claude-in-Chrome, en una pestaña nueva de la sesión de Chrome del usuario (ya autenticada en Facebook; no se inició sesión, no se introdujeron credenciales, no se pulsó Like/Follow/Share/comentar). Pestaña cerrada al terminar.

Método común a los cuatro:
- Sin audio: no puedo oír el vídeo. Todo lo que sigue sale de fotogramas (búsqueda en la línea de tiempo con el vídeo en pausa), del texto incrustado en la imagen (subtítulos quemados) y de la descripción del reel.
- Ninguno de los cuatro vídeos tiene pista de subtítulos en el DOM (`video.textTracks.length === 0`) ni transcripción de Facebook visible. Los "subtítulos" son texto quemado palabra a palabra, así que solo se recuperan fragmentos, no una transcripción completa.
- Fecha de publicación: la vista de reel no la muestra; se tomó del campo `creation_time` de los datos de la página asociado al id del reel (UTC). Fiabilidad media.
- No se leyeron comentarios (no hacían falta para identificar herramienta o técnica).
- Las cifras de reacciones son las visibles en pantalla al momento de la inspección.

---

## Vídeo 1 — EDteam: "La fórmula de Elon Musk para construir tantas empresas"

**Acceso:** inspeccionado por completo en cuanto a fotogramas (13 fotogramas, cada ~12 s) + descripción íntegra. Sin audio, sin transcripción.

**Metadatos**
- URL original: https://www.facebook.com/share/v/1EPF46WTBD/?mibextid=wwXIfr
- URL resuelta: https://www.facebook.com/reel/1853474122688612
- Creador/página: EDteam (verificada)
- Publicado: 2026-08-18 18:23 UTC (datos de página)
- Duración: 145,6 s (2:25), vertical 720x1280
- Reacciones visibles: 5,7 mil me gusta, 98 comentarios, 682 compartidos
- Descripción (íntegra): "¿Cómo hace Elon Musk para meterse en autos, cohetes, redes sociales e IA y lograr que sus empresas funcionen? No improvisa. Cuando algo se atasca, aplica una fórmula de cinco pasos que llama el algoritmo. Primero cuestiona el proceso completo y luego comienza a recortarlo. Pero la parte más interesante está al final, porque Musk deja para el último paso lo que casi todos hacen primero." #ElonMusk #Emprendimiento #Procesos #Productividad #Automatización #loAprendisteEnEDteam #nadieExplicaMejor

**Qué se ve (línea de tiempo)**
- 0:03 — Presentador a cámara con micrófono; rótulo "LA FÓRMULA DE ELON MUSK PARA CONSTRUIR TANTAS EMPRESAS" y foto de Musk.
- 0:12–0:24 — Presentador hablando; subtítulos sueltos: "respuesta,", "proyecto.".
- 0:36 — Imagen de apoyo (aspecto generado por IA) de un directivo firmando papeles rodeado de empleados; subtítulo "se le ocurrió un".
- 0:48 — Numeral "2" en pantalla; subtítulo "del proceso que" (paso 2).
- 1:00–1:12 — Subtítulos "Es más, él dice", "innecesarias del".
- 1:24 — Tarjeta promocional: directo de YouTube de EDteam "En vivo: Grokbot, el Openclaw de Elon Muks" (sic), "ELON MUSK PRESENTA GROKBOT", youtube.com/edteam.
- 1:36 — Numeral "3"; subtítulo "más posible." (paso 3).
- 1:48 — Imagen de apoyo de una línea de montaje robotizada con un coche; subtítulo "producir un auto?".
- 2:00 — Subtítulo "automatizo tu" (parte sobre automatizar).
- 2:23 — Cierre: "COMIENZA A ESTUDIAR GRATIS EN ed.team".

**Herramientas/técnicas nombradas**
- "El algoritmo" de Musk (fórmula de cinco pasos). Por la descripción: cuestionar el proceso completo, recortarlo, y dejar para el final "lo que casi todos hacen primero" (los fotogramas finales hablan de automatizar).
- Mención promocional: "Grokbot", "Openclaw" (solo en la tarjeta del directo, no explicados en este vídeo).

**Afirmado vs. demostrado**
- Demostrado en pantalla: nada técnico; es un busto parlante con imágenes de apoyo. No hay UI, herramienta ni demo.
- Afirmado: que Musk aplica una fórmula de cinco pasos y que automatizar va al final. Solo vi explícitamente los numerales 2 y 3; el texto exacto de cada paso no es recuperable sin audio.

**Completitud:** fotogramas + descripción, sin audio. Entiendo el tema y la estructura; no tengo el contenido literal de los cinco pasos.

---

## Vídeo 2 — Champ McCorkle: "Claude Just Changed Paid Ads Forever"

**Acceso:** inspeccionado por completo en fotogramas (11 fotogramas, cada ~4 s) + descripción íntegra. Sin audio.

**Metadatos**
- URL original: https://www.facebook.com/share/r/19aSRy8ddF/?mibextid=wwXIfr
- URL resuelta: https://www.facebook.com/reel/29481615088194167
- Creador: Champ McCorkle (verificado), audio original
- Publicado: 2026-11-07 16:56 UTC (datos de página)
- Duración: 40,7 s
- Reacciones visibles: 1,7 mil me gusta, 2,6 mil comentarios, 196 compartidos
- Descripción (resumen fiel): convierte a Claude en una "paid ads machine". Pasos: (1) escribir `/ads` en Claude y pegar tu web; (2) ver lo que publican tus competidores: cientos de formatos, creatividades, textos y CTA sacados de la Meta Ad Library; (3) conectar tu cuenta publicitaria para que reescriba tus anuncios (texto, imágenes y a dónde mover presupuesto). Se instala ejecutando una skill dentro de Claude que da tres herramientas: el scraper de la ad library, un creador de anuncios y una herramienta creativa para imágenes. Afirma que empresas le pagaban 15.000 USD al mes por este sistema y que ahora es gratis; pide comentar "ADS" para recibir la skill.

**Qué se ve (línea de tiempo)**
- 0:01–0:04 — Título "Claude Just Changed Paid Ads Forever" con el logo de Claude; presentador en recuadro inferior; mosaico de anuncios difuminados.
- 0:08 — Animación: logo de Claude + campo "yourwebsite.com" conectado a miniaturas de webs; subtítulo "entire industry".
- 0:12–0:16 — Nube de anuncios; luego rótulo "Meta Ad Library" con una rejilla de anuncios de ejemplo (marcas difuminadas: "FREE QUOTE", "Free Moving Estimate", "Open At 6am"…); subtítulos "Hundreds of their", "ad library.".
- 0:20–0:24 — Logo de Claude unido al de Meta; un anuncio de ejemplo con etiquetas "Copy", "Images", "Budget"; subtítulos "rewrite your ads", "move the budget.".
- 0:28 — Campo de entrada con logo de Claude y el texto "/ads"; tres casillas numeradas 1, 2, 3.
- 0:32 — Tres tarjetas: "Ad Library Scraper", "Ad Creator", "Creative Tool"; subtítulo "Businesses paid me".
- 0:36 — Presentador a cámara; subtítulo "It's not a".
- 0:40 — Rótulo "Comment Ads"; subtítulo "send you the".

**Herramientas/técnicas nombradas (tal cual)**
- Claude; comando/skill `/ads`; Meta Ad Library; "Ad Library Scraper", "Ad Creator", "Creative Tool"; conexión a la cuenta publicitaria de Meta.

**Afirmado vs. demostrado**
- Demostrado en pantalla: nada real. Todo son animaciones (motion graphics) con marcas difuminadas; no aparece ninguna sesión real de Claude, ni salida, ni repositorio, ni el contenido de la skill.
- Afirmado: que la skill existe y hace scraping de la Ad Library, reescribe anuncios y recomienda presupuesto; los 15.000 USD/mes. La skill solo se entrega por DM tras comentar (embudo de captación); no hay enlace ni nombre de repositorio.

**Completitud:** fotogramas + descripción, sin audio. Cobertura alta del mensaje (la descripción reproduce prácticamente el guion).

---

## Vídeo 3 — bybrayan.ai: 31 mejoras de rendimiento para una app

**Acceso:** inspeccionado por completo en fotogramas (dos pasadas, ~38 fotogramas) + descripción íntegra. Sin audio. Recuperados 25 de los 31 títulos; faltan 6 (ver abajo).

**Metadatos**
- URL original: https://www.facebook.com/share/r/1FNXQLJXpB/?mibextid=wwXIfr
- URL resuelta: https://www.facebook.com/reel/1434015294955386
- Creador: bybrayan.ai (verificado; en pantalla "@bybrayan.ai · IA · Claude · agentes"), audio original
- Publicado: 2026-11-05 19:55 UTC (datos de página)
- Duración: 87,5 s
- Reacciones visibles: 4,1 mil me gusta, 1,4 mil comentarios, 191 compartidos
- Descripción (íntegra en lo esencial): "Una app lenta no siempre necesita más servidores. Necesita mejores decisiones técnicas. Estas son 31 mejoras de rendimiento que pueden marcar la diferencia en tu software. Preparé una guía gratuita con checklist y prompts de IA para aplicarlas. Comenta APP y te la envío gratis por DM." Menciona @vercel @github @cloudflare @googlefordevs @supabasecom @microsoft. #IA #inteligenciaartificial #claude #Programación

**Qué se ve**
Animación tipo motion graphics con una app ficticia "cumbre.app" (rutas de senderismo), una mascota naranja pixelada y un contador "NN / 31" con categoría (FRONTEND, RED, API, BACKEND, BASE DE DATOS, MEDICIÓN). Arranca con la app en "Cargando…" y una etiqueta "vibe coding". Títulos leídos en pantalla:

| # | Categoría | Título en pantalla |
|---|---|---|
| 01 | Frontend | "Agrega…" (skeletons de carga; confirmado en la tarjeta final: "Agrega skeletons de carga") |
| 02 | Red | "Sirve las imágenes en WebP" (foto.png -> foto.webp, menor peso) |
| 03 | — | no capturado |
| 04 | Frontend | "Ponle debounce" (buscador: sin debounce 6 peticiones, con debounce una al final) |
| 05 | API | "Pagina los resultados de la API." (20 por página) |
| 06 | Red | título no legible (fotograma en transición) |
| 07 | Backend | título borroso; visual: "Exportar PDF" -> "Exportación en cola" -> "Cola de trabajos" + "Worker" (trabajos pesados en segundo plano) |
| 08 | — | no capturado |
| 09 | Red | "Activa la compresión" (servidor -> navegador, JSON) |
| 10 | — | no capturado |
| 11 | Frontend | "Quita las dependencias…" (bundle.js, tamaño del bundle; resto del título cortado) |
| 12 | API | "Ponle timeout a las APIs" (API externa, 3 s) |
| 13 | API | "Transmite las respuestas de la…" (chat "Asistente" con "En streaming": "La primera palabra llega al instante") |
| 14 | Frontend | "Actualiza la interfaz…" (botón de me gusta antes de la respuesta del servidor; UI optimista) |
| 15 | Frontend | "Usa…" lazy loading en imágenes fuera de pantalla ("Solo carga lo que vas a ver") |
| 16 | API | "Lanza en paralelo las peticiones independientes." ("Total = la más lenta, no la suma") |
| 17 | Base de datos | "Crea índices para las consultas más comunes." |
| 18 | Medición | "Rastrea las peticiones lentas con OpenTelemetry." (traza GET /checkout, "Tramo más lento") |
| 19 | Backend | "Acerca el servidor a la base" de datos ("Misma región · red privada") |
| 20 | Backend | "Renderiza en el servidor o en el build." |
| 21 | Frontend | "Carga los scripts de terceros después de la página." (Chat, Analítica, Anuncios) |
| 22 | Frontend | "Divide el JavaScript por página." |
| 23 | Frontend | "Virtualiza…" (listas largas: ventana visible frente a "1.000 filas dibujadas") |
| 24 | Base de datos | "Pide solo…" (lo necesario; se muestra `SELECT * FROM usuarios` como antipatrón) |
| 25 | Base de datos | "Usa un pool de…" conexiones ("4 conexiones que se reutilizan") |
| 26 | Frontend | "Evita los re-renders innecesarios." ("Solo cambia el contador") |
| 27 | Red | "Cachea los estáticos en el navegador." (nombres con hash, 2.ª visita "No hace falta" servidor) |
| 28 | Backend | "Reparte el tráfico entre varias instancias." (balanceador, "Solo a las instancias sanas") |
| 29 | Frontend | "Aloja tus fuentes y limita los grosores." |
| 30 | Medición | "Monitorea la velocidad de tus usuarios reales." (p75; LCP, INP, CLS; "datos de ejemplo") |
| 31 | Medición | "Y prueba en celulares y redes lentas." (CPU 4x más lenta, 3G lenta) |

- Cierre (1:23–1:26): tarjeta de ejemplo de la guía: "01 FRONTEND — Agrega skeletons de carga — PROMPT PARA CLAUDE: 'Busca las pantallas que cargan datos y hoy muestran un spinner o quedan vacías. Crea un skeleton con la misma forma del contenido final […] No cambies la lógica de datos.' — CÓMO COMPROBARLO: Red lenta en DevTools: el skeleton aparece al instante y el CLS no sube." Botón "Comenta APP"; contador "31 / 31 ✓ APP RÁPIDA".

**Herramientas/técnicas nombradas**
- WebP, debounce, paginación, colas de trabajos/worker, compresión, timeouts, streaming de respuestas, UI optimista, lazy loading, peticiones en paralelo, índices, OpenTelemetry, colocación servidor–BD en la misma región, SSR/pre-render en build, carga diferida de scripts de terceros, code splitting por página, virtualización de listas, pool de conexiones, evitar re-renders, caché de estáticos, balanceo de carga, fuentes autoalojadas, métricas de usuarios reales (LCP/INP/CLS, p75), pruebas en gama baja y 3G, DevTools. "Prompt para Claude" como formato de la guía.
- Marcas etiquetadas solo en la descripción: Vercel, GitHub, Cloudflare, Google for Devs, Supabase, Microsoft (no aparecen en los fotogramas vistos).

**Afirmado vs. demostrado**
- Demostrado: nada medido. Son ilustraciones animadas con datos rotulados "datos de ejemplo"; no hay código real, benchmarks ni una app real.
- Afirmado: que estas 31 mejoras "pueden marcar la diferencia". La guía con checklist y prompts solo se entrega por DM tras comentar "APP"; no la vi.

**Completitud:** fotogramas + descripción, sin audio. Lista casi completa: faltan los títulos 03, 08 y 10, y son parciales 06, 07 y varios cortados a media animación (11, 13, 14, 15, 24, 25).

---

## Vídeo 4 — Klustomer: las 8 capas de una "IA empresarial"

**Acceso:** inspeccionado por completo en fotogramas (21 fotogramas, cada ~7 s) + descripción íntegra. Sin audio.

**Metadatos**
- URL original: https://www.facebook.com/share/v/1MZdJnWs4a/?mibextid=wwXIfr
- URL resuelta: https://www.facebook.com/reel/1122371257262795
- Creador/página: Klustomer (verificada)
- Publicado: 2026-11-13 00:34 UTC (datos de página; había otra fecha candidata, 2026-11-02, asociada a otro reel precargado)
- Duración: 140,3 s (2:20)
- Reacciones visibles: 15,3 mil me gusta, 141 comentarios, 879 compartidos
- Descripción (íntegra en lo esencial): "Ponerle tu logo a ChatGPT NO es tener una IA empresarial. Crear un agente de IA que sea preciso, seguro y rentable para tu negocio exige una arquitectura real: Precisión: Sistemas RAG para consultar tus documentos internos sin inventar respuestas. Capacidad de Acción: Servidores MCP para que pase de responder preguntas a ejecutar tareas. Seguridad: Control de permisos (RBAC) y protecciones contra fugas de información. Eficiencia: Control de costos y evaluación continua para cuidar tu presupuesto." Después vende sus servicios (diagnóstico y estrategia, adopción y alfabetización, desarrollo a medida) y remite a klustomer.com. #IAEmpresarial #Klustomer #EstrategiaDeDatos #AgentesIA #transformaciondigital

**Qué se ve (línea de tiempo)**
Animación con un robot "TU LOGO" llamado "Nova" (empresa ficticia "Envíos Nova"), que va subiendo sobre una pila de bloques con contador "N/8 capas". Cada capa se introduce con un fallo concreto y luego su solución.
- 0:02–0:08 — "¡Hagamos nuestra propia IA!"; subtítulos "quieren su propia IA.", "y la bautizas Nova.".
- 0:22 — **Capa 1/8 PROMPT**: tarjeta "SYSTEM PROMPT — Trabajas para Envíos Nova. Habla con nuestro estilo. Nunca recomiendes a la competencia." Rótulo "instrucciones ocultas en cada mensaje".
- 0:29 — Fallo: un cliente pregunta "¿Cuánto se reembolsa por un paquete dañado?" (el bot no conoce la política).
- 0:43 — **Capa 2/8 RAG**: diagrama "Política de reembolsos -> fragmentos -> embeddings (el significado en números) -> base de datos vectorial".
- 0:50–0:57 — "solo quiere respuestas."; aparecen sistemas "Pagos", "Tickets", "Chat"; subtítulo "sistemas con servidores" (por la descripción: servidores MCP) -> **Capa 3 HERRAMIENTAS**.
- 1:04 — Fallo: empleado nuevo ("DÍA 1") pregunta "¿Cuánto gana mi jefe?".
- 1:11 — **Capa 4/8 ACCESOS**: "OAuth = permisos de: empleado nuevo"; subtítulo "y con OAuth Nova".
- 1:18–1:25 — Fallo: llega un correo de "Juan Pérez, para: Soporte, Asunto: Mi paquete llegó tarde" que lleva oculto en el cuerpo un texto que ordena al bot saltarse sus instrucciones y reembolsar todos los pedidos (ejemplo de inyección de prompt); contador "REEMBOLSOS $28,640"; subtítulo "y empieza a reembolsar.".
- 1:32 — **Capa 5/8 GUARDRAILS**: filtro de "lo que entra" que bloquea ese texto oculto, y de lo que sale (respuesta con un número de tarjeta "8812 4321" como ejemplo de fuga); subtítulo "esa y tapas".
- 1:39 — Fallo de coste: "LUN 9:00", la misma pregunta "¿Dónde está mi paquete?" x 2.000, "tokens"; subtítulo "y tu factura".
- 1:46 — **Capa 6 CACHÉ** ("prompt", "políticas" — "ya no se paga dos veces") y **Capa 7/8 ROUTER** ("router (no, el del wifi no)", "fácil -> modelo pequeño y barato"; subtítulo "y barato resuelve lo fácil").
- 1:53 — Fallo: respuesta errónea "Tu paquete ya llegó." y la duda "¿PROMPT? ¿DOCUMENTO?" (no se sabe qué falló).
- 2:00 — **Capa 8/8 OBSERVABILIDAD**: trazas con check en "PROMPT", "DOCUMENTO", "HERRAMIENTA"; contador "0/128" (evals); subtítulo "y ningún cambio sale".
- 2:07 — Pila completa: 1 PROMPT, 2 RAG, 3 HERRAMIENTAS, 4 ACCESOS, 5 GUARDRAILS, 6 CACHÉ, 7 ROUTER, 8 OBSERVABILIDAD; sellos "PRECISA ✓ SEGURA ✓ BARATA ✓ BAJO CONTROL ✓".
- 2:13–2:18 — Remate: el bot contesta "¡Paquetería La Competencia!" a "¿Cuál es la mejor empresa de envíos?"; "VIE 5:58 p. m.", interruptor "Correr evals — APAGADO", la pila se tambalea; subtítulo "las evals." (mensaje: sin evals antes de desplegar, se rompe).

**Herramientas/técnicas nombradas (tal cual)**
- System prompt, RAG (fragmentos, embeddings, base de datos vectorial), herramientas / servidores MCP, OAuth y RBAC (accesos), guardrails de entrada y salida (inyección de prompt, fuga de datos), caché de prompt, router de modelos (modelo pequeño y barato para lo fácil), observabilidad (trazas por prompt/documento/herramienta) y evals antes de publicar cambios. Mención de "ChatGPT" solo en la descripción. No se nombra ningún producto, repositorio ni framework concreto.

**Afirmado vs. demostrado**
- Demostrado: nada operativo; es una explicación conceptual animada con una empresa ficticia. No hay UI de producto, código ni demo.
- Afirmado: que un agente empresarial "preciso, seguro y rentable" necesita estas 8 capas, y que Klustomer acompaña la implantación (contenido comercial de una consultora).

**Completitud:** fotogramas + descripción, sin audio. Las 8 capas quedan identificadas con su fallo motivador; la capa 3 y la 6 se vieron de refilón (rótulo y pila final), no su explicación detallada.

---

## Resumen de profundidad

| # | Creador | Tema | Acceso | Profundidad |
|---|---|---|---|---|
| 1 | EDteam | "El algoritmo" de 5 pasos de Musk | Sí | 13 fotogramas + descripción; pasos literales no recuperados |
| 2 | Champ McCorkle | Skill `/ads` de Claude para anuncios de pago | Sí | 11 fotogramas + descripción; guion casi completo |
| 3 | bybrayan.ai | 31 mejoras de rendimiento | Sí | ~38 fotogramas + descripción; 25/31 títulos |
| 4 | Klustomer | 8 capas de un agente de IA empresarial | Sí | 21 fotogramas + descripción; 8/8 capas |

Limitación general: sin audio y sin transcripción en ninguno. Ningún muro de inicio de sesión ni error bloqueó el acceso.
