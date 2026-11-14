/**
 * Portal IA 4 · Estudio: adaptadores de IA generativa (texto→vídeo, imagen→vídeo, transformación, voz, subtítulos…).
 *
 * El editor funciona entero SIN ninguno. Cada capacidad dice con honestidad en qué estado está; ninguna se anuncia
 * como disponible sin haberla probado, y ninguna llamada de pago sale sin una conexión que el propietario haya hecho y
 * una autorización de gasto explícita. Hoy no hay ningún proveedor conectado: el registro describe el contrato y lo
 * que haría falta, no finge resultados.
 *
 * Fuentes revisadas el 2026-11-14 (ver docs/portal-ia-4/descubrimiento/higgsfield.md): precios orientativos por
 * segundo de vídeo generado; se deben volver a comprobar antes de conectar nada.
 */
export type StudioAiCapability = 'text_to_video' | 'image_to_video' | 'video_to_video' | 'prompt_edit' | 'captions' | 'voiceover' | 'enhance';
export type StudioAiState =
  | 'verified'             // conectado y probado de punta a punta en este Portal
  | 'configured_untested'  // hay conexión, falta la prueba
  | 'requires_connection'  // hay adaptador posible; el propietario debe conectar su cuenta
  | 'requires_paid_auth'   // conectado, pero cada uso gasta: pide autorización de gasto
  | 'unsupported';         // no se puede ofrecer (técnica o legalmente)

export interface StudioAiRequest { capability: StudioAiCapability; prompt?: string; inputAssetId?: string; durationSec?: number; aspect?: 'landscape' | 'portrait' | 'square' }
export interface StudioAiEstimate { usd: number; basis: string }
export interface StudioAiJob { id: string; status: 'queued' | 'running' | 'done' | 'failed'; outputFile?: string; error?: string }
/** Contrato que cumple cada proveedor. La salida siempre entra a la biblioteca como un medio más (se analiza igual que una subida). */
export interface StudioAiAdapter {
  id: string; name: string; capabilities: StudioAiCapability[];
  estimate(req: StudioAiRequest): StudioAiEstimate;
  submit(req: StudioAiRequest, authorization: { maxUsd: number; authorizedBy: 'owner' }): Promise<StudioAiJob>;
  poll(jobId: string): Promise<StudioAiJob>;
  cancel(jobId: string): Promise<void>;
}

export interface StudioProviderInfo { id: string; name: string; capabilities: StudioAiCapability[]; state: StudioAiState; note: string; priceHint: string | null }

const CATALOG: StudioProviderInfo[] = [
  { id: 'local-ffmpeg', name: 'Edición local (FFmpeg)', capabilities: [], state: 'verified', note: 'Cortar, unir, texto, subtítulos, audio, velocidad, fundidos y exportación a MP4. Sin coste ni conexión.', priceHint: 'Gratis' },
  { id: 'fal', name: 'fal.ai (varios modelos)', capabilities: ['text_to_video', 'image_to_video', 'video_to_video'], state: 'requires_connection', note: 'API oficial de pago por uso. Necesita tu clave y tu autorización de gasto en cada generación.', priceHint: '≈ 0,005–0,14 USD por segundo, según el modelo' },
  { id: 'runway', name: 'Runway', capabilities: ['text_to_video', 'image_to_video', 'video_to_video'], state: 'requires_connection', note: 'API oficial de pago por créditos. Necesita tu clave y tu autorización de gasto.', priceHint: '≈ 0,05–0,40 USD por segundo, según el modelo' },
  { id: 'replicate', name: 'Replicate (modelos abiertos)', capabilities: ['text_to_video', 'image_to_video', 'enhance'], state: 'requires_connection', note: 'API oficial de pago por uso. Necesita tu clave y tu autorización de gasto.', priceHint: '≈ 0,09–0,25 USD por segundo en los modelos revisados' },
  { id: 'higgsfield', name: 'Higgsfield', capabilities: ['text_to_video', 'image_to_video', 'prompt_edit'], state: 'unsupported', note: 'Tiene API oficial, pero sus condiciones (revisadas el 2026-11-14) restringen usar el servicio para construir productos que compitan con él. No se integra hasta que leas tú esas condiciones y lo decidas.', priceHint: null },
  { id: 'captions-local', name: 'Subtítulos automáticos (voz a texto local)', capabilities: ['captions'], state: 'unsupported', note: 'Aún no está construido. Mientras tanto puedes escribir los subtítulos o importar un archivo .srt.', priceHint: null },
  { id: 'voiceover', name: 'Voz en off generada', capabilities: ['voiceover'], state: 'unsupported', note: 'Aún no está construido. Puedes grabar tu voz y añadirla como audio.', priceHint: null }
];

/** Estado real de cada proveedor. Sin conexiones guardadas, ninguno pasa de «requiere conexión». */
export function studioProviders(): StudioProviderInfo[] { return CATALOG.map(p => ({ ...p, capabilities: [...p.capabilities] })); }
