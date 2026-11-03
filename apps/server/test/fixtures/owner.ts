/**
 * Sesión de propietario para las pruebas que deciden revisiones u operaciones del Asistente (ver
 * src/services/ownerSession.ts): vincula en el propio proceso, igual que haría el navegador con el código, y apunta a la
 * dirección del propio Portal (su puerto). Importar después de fijar PORTAL_DATA_DIR (abre la base de la plataforma).
 */
export async function ownerHeaders(): Promise<Record<string, string>> {
  const m = await import('../../src/services/ownerSession.ts');
  const { config } = await import('../../src/config.ts');
  m.resetPairingForTests();
  const { code } = m.issuePairingCode(() => undefined);
  const { token } = m.pairOwner(code, 'pruebas');
  return { 'x-portal-owner': token, host: `127.0.0.1:${config.port}` }; // el cuerpo (objeto) ya va como JSON
}
