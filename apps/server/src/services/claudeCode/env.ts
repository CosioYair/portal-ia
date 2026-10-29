/**
 * Entorno del subproceso de Claude Code: una LISTA BLANCA mínima. Nada del entorno del Portal pasa salvo lo necesario
 * para que la CLI encuentre su configuración, su sesión y la red. Claude Code prioriza ANTHROPIC_API_KEY sobre la sesión
 * de la suscripción y en modo `-p` la usa siempre que exista (documentación oficial, «Authentication precedence»): si se
 * reenviara, la ejecución se facturaría por API sin avisar. Por eso las credenciales nunca se reenvían, ni las de Anthropic
 * ni las de proveedores en la nube, y el Portal solo informa de su presencia (nombres, nunca valores).
 */
export const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'AWS_BEARER_TOKEN_BEDROCK'
] as const;

/** Variables del sistema que la CLI necesita (rutas de usuario, temporales, red y certificados). Comparación sin mayúsculas. */
const ALLOWED = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USER', 'LOGNAME', 'USERDOMAIN', 'COMPUTERNAME',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Carpeta de configuración de Claude Code, si el propietario usa una distinta de la predeterminada.
  'CLAUDE_CONFIG_DIR'
]);

/** Entorno mínimo para la CLI. `extra` solo lo fija el Portal (nunca contiene credenciales: se comprueba). */
export function minimalEnv(source: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && ALLOWED.has(k.toUpperCase())) out[k] = v;
  for (const k of Object.keys(extra)) if ((CREDENTIAL_VARS as readonly string[]).includes(k.toUpperCase())) throw new Error(`No se reenvían credenciales a Claude Code (${k}).`);
  // Sin actualizaciones automáticas a mitad de una ejecución autorizada.
  return { ...out, DISABLE_AUTOUPDATER: '1', ...extra };
}

/**
 * Entorno de una ejecución gestionada (y de su detección): el mínimo de arriba más los controles documentados que dejan
 * fuera la configuración personal del propietario. Modo restringido (igual que `--restricted`: solo ajustes gestionados
 * y `--settings`, sin herramientas que ejecutan código), sin CLAUDE.md (de usuario, de proyecto ni de memoria
 * automática), sin memoria automática y sin los conectores MCP de claude.ai.
 */
export const MANAGED_ENV: Record<string, string> = {
  CLAUDE_CODE_RESTRICTED: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false'
};
export const managedEnv = (source: NodeJS.ProcessEnv = process.env) => minimalEnv(source, MANAGED_ENV);

/** Nombres de variables de credenciales presentes (no vacías) en un entorno. Nunca devuelve valores. */
export function credentialVarsIn(source: NodeJS.ProcessEnv = process.env): string[] {
  const upper = new Map(Object.entries(source).map(([k, v]) => [k.toUpperCase(), v]));
  return CREDENTIAL_VARS.filter(k => { const v = upper.get(k); return typeof v === 'string' && v.trim() !== ''; });
}
