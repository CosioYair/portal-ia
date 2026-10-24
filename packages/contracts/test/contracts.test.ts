import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentCreateInputSchema,
  AgentOutputSchema,
  ApiErrorSchema,
  AuthorizationCreateInputSchema,
  AuthorizationDecisionInputSchema,
  AuthorizationOutputSchema,
  CompanyCreateInputSchema,
  CompanyOutputSchema,
  ProcessCreateInputSchema,
  ProcessOutputSchema,
  RequestCreateInputSchema,
  RequestOutputSchema,
  UsageOutputSchema,
  UsageRecordInputSchema,
  isApiError,
  validate
} from '../src/index.ts';

type Esquema = Parameters<typeof validate>[0];

interface Caso {
  readonly nombre: string;
  readonly schema: Esquema;
  readonly valido: Record<string, unknown>;
}

const FECHA = '2025-01-01T10:00:00.000Z';
const HASH = 'a'.repeat(64);
const COMPANY = 'acme-sa';

const agentBase = {
  companyId: COMPANY,
  name: 'Analista',
  role: 'Analiza datos',
  allowedTools: ['buscar'],
  budgetLimitMicros: 5_000_000
};
const processBase = {
  companyId: COMPANY,
  projectId: 'proj_01',
  name: 'Informe mensual',
  agentIds: ['agt_01']
};
const requestBase = {
  companyId: COMPANY,
  projectId: 'proj_01',
  title: 'Preparar informe',
  description: 'Resumen de ventas del mes'
};
const authorizationBase = {
  companyId: COMPANY,
  requestId: 'req_01',
  action: 'Llamar al modelo',
  actionHash: HASH,
  expiresAt: FECHA
};
const usageBase = {
  companyId: COMPANY,
  projectId: 'proj_01',
  processId: 'proc_01',
  provider: 'anthropic',
  model: 'modelo-x',
  inputTokens: 1200,
  outputTokens: 300,
  costMicros: 4500,
  currency: 'USD'
};

const CASOS: readonly Caso[] = [
  {
    nombre: 'Empresa (entrada)',
    schema: CompanyCreateInputSchema,
    valido: { companyId: COMPANY, name: 'Acme' }
  },
  {
    nombre: 'Empresa (salida)',
    schema: CompanyOutputSchema,
    valido: { companyId: COMPANY, name: 'Acme', createdAt: FECHA }
  },
  { nombre: 'Agente (entrada)', schema: AgentCreateInputSchema, valido: agentBase },
  {
    nombre: 'Agente (salida)',
    schema: AgentOutputSchema,
    valido: { ...agentBase, id: 'agt_01', createdAt: FECHA, updatedAt: FECHA }
  },
  { nombre: 'Proceso (entrada)', schema: ProcessCreateInputSchema, valido: processBase },
  {
    nombre: 'Proceso (salida)',
    schema: ProcessOutputSchema,
    valido: { ...processBase, id: 'proc_01', status: 'planificando', createdAt: FECHA, updatedAt: FECHA }
  },
  { nombre: 'Solicitud (entrada)', schema: RequestCreateInputSchema, valido: requestBase },
  {
    nombre: 'Solicitud (salida)',
    schema: RequestOutputSchema,
    valido: { ...requestBase, id: 'req_01', status: 'abierta', createdAt: FECHA }
  },
  {
    nombre: 'Autorización (entrada)',
    schema: AuthorizationCreateInputSchema,
    valido: authorizationBase
  },
  {
    nombre: 'Autorización (salida)',
    schema: AuthorizationOutputSchema,
    valido: {
      ...authorizationBase,
      id: 'aut_01',
      status: 'pendiente',
      singleUse: true,
      createdAt: FECHA
    }
  },
  {
    nombre: 'Autorización (decisión)',
    schema: AuthorizationDecisionInputSchema,
    valido: { companyId: COMPANY, authorizationId: 'aut_01', decision: 'aprobar', actionHash: HASH }
  },
  { nombre: 'Consumo (entrada)', schema: UsageRecordInputSchema, valido: usageBase },
  {
    nombre: 'Consumo (salida)',
    schema: UsageOutputSchema,
    valido: { ...usageBase, id: 'use_01', createdAt: FECHA }
  }
];

const COMPANY_IDS_INVALIDOS: readonly unknown[] = [
  '',
  'a',
  'Mayusculas',
  '-empieza-con-guion',
  'con espacio',
  'con_guion_bajo',
  'x'.repeat(64),
  123,
  null
];

function copia(objeto: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(objeto);
}

function sinCampo(objeto: Record<string, unknown>, campo: string): Record<string, unknown> {
  const resultado = copia(objeto);
  delete resultado[campo];
  return resultado;
}

for (const caso of CASOS) {
  test(`${caso.nombre}: un objeto válido pasa`, () => {
    const resultado = validate(caso.schema, caso.valido);
    assert.equal(resultado.ok, true);
  });

  test(`${caso.nombre}: sin companyId falla`, () => {
    const resultado = validate(caso.schema, sinCampo(caso.valido, 'companyId'));
    assert.equal(resultado.ok, false);
    if (!resultado.ok) {
      assert.ok(resultado.issues.some((i) => i.path === 'companyId'));
    }
  });

  test(`${caso.nombre}: companyId vacío o con formato inválido falla`, () => {
    for (const companyId of COMPANY_IDS_INVALIDOS) {
      const resultado = validate(caso.schema, { ...caso.valido, companyId });
      assert.equal(resultado.ok, false, `companyId ${JSON.stringify(companyId)} debía fallar`);
    }
  });

  test(`${caso.nombre}: un campo desconocido falla (estricto)`, () => {
    const resultado = validate(caso.schema, { ...caso.valido, campoExtra: 'x' });
    assert.equal(resultado.ok, false);
  });

  test(`${caso.nombre}: una entrada que no es objeto no lanza excepciones`, () => {
    for (const basura of [null, undefined, 'texto', 42, []]) {
      assert.doesNotThrow(() => validate(caso.schema, basura));
      assert.equal(validate(caso.schema, basura).ok, false);
    }
  });
}

test('Agente: presupuesto opcional, pero nunca negativo ni decimal', () => {
  assert.equal(validate(AgentCreateInputSchema, sinCampo(agentBase, 'budgetLimitMicros')).ok, true);
  assert.equal(validate(AgentCreateInputSchema, { ...agentBase, budgetLimitMicros: -1 }).ok, false);
  assert.equal(validate(AgentCreateInputSchema, { ...agentBase, budgetLimitMicros: 1.5 }).ok, false);
});

test('Proceso: un estado desconocido falla', () => {
  const salida = { ...processBase, id: 'proc_01', createdAt: FECHA, updatedAt: FECHA };
  assert.equal(validate(ProcessOutputSchema, { ...salida, status: 'ejecutando' }).ok, true);
  assert.equal(validate(ProcessOutputSchema, { ...salida, status: 'volando' }).ok, false);
});

test('Solicitud: un estado desconocido falla', () => {
  const salida = { ...requestBase, id: 'req_01', createdAt: FECHA };
  assert.equal(validate(RequestOutputSchema, { ...salida, status: 'cerrada' }).ok, true);
  assert.equal(validate(RequestOutputSchema, { ...salida, status: 'otro' }).ok, false);
});

test('Autorización: un actionHash mal formado falla', () => {
  const malos = ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)];
  for (const actionHash of malos) {
    assert.equal(
      validate(AuthorizationCreateInputSchema, { ...authorizationBase, actionHash }).ok,
      false,
      `actionHash ${actionHash} debía fallar`
    );
    assert.equal(
      validate(AuthorizationDecisionInputSchema, {
        companyId: COMPANY,
        authorizationId: 'aut_01',
        decision: 'aprobar',
        actionHash
      }).ok,
      false
    );
  }
});

test('Autorización: la decisión solo admite aprobar o denegar y la salida es de un solo uso', () => {
  const decision = { companyId: COMPANY, authorizationId: 'aut_01', actionHash: HASH };
  assert.equal(validate(AuthorizationDecisionInputSchema, { ...decision, decision: 'denegar' }).ok, true);
  assert.equal(validate(AuthorizationDecisionInputSchema, { ...decision, decision: 'quizá' }).ok, false);

  const salida = { ...authorizationBase, id: 'aut_01', status: 'aprobada', createdAt: FECHA };
  assert.equal(validate(AuthorizationOutputSchema, { ...salida, singleUse: true, decidedAt: FECHA }).ok, true);
  assert.equal(validate(AuthorizationOutputSchema, { ...salida, singleUse: false }).ok, false);
});

test('Autorización: una fecha de caducidad inválida falla', () => {
  assert.equal(
    validate(AuthorizationCreateInputSchema, { ...authorizationBase, expiresAt: 'mañana' }).ok,
    false
  );
});

test('Consumo: tokens negativos o decimales y coste decimal fallan', () => {
  for (const cambio of [
    { inputTokens: -1 },
    { outputTokens: -5 },
    { inputTokens: 1.5 },
    { costMicros: 0.5 },
    { costMicros: -10 },
    { inputTokens: '10' }
  ]) {
    assert.equal(
      validate(UsageRecordInputSchema, { ...usageBase, ...cambio }).ok,
      false,
      `${JSON.stringify(cambio)} debía fallar`
    );
  }
});

test('Consumo: moneda no admitida falla y proyecto/proceso son opcionales', () => {
  assert.equal(validate(UsageRecordInputSchema, { ...usageBase, currency: 'JPY' }).ok, false);
  const sinOpcionales = sinCampo(sinCampo(usageBase, 'projectId'), 'processId');
  assert.equal(validate(UsageRecordInputSchema, sinOpcionales).ok, true);
});

test('validate devuelve los datos tipados si son válidos', () => {
  const resultado = validate(CompanyCreateInputSchema, { companyId: COMPANY, name: '  Acme  ' });
  assert.equal(resultado.ok, true);
  if (resultado.ok) {
    assert.deepEqual(resultado.data, { companyId: COMPANY, name: 'Acme' });
  }
});

test('validate devuelve la lista de errores con ruta y mensaje si no son válidos', () => {
  const resultado = validate(CompanyCreateInputSchema, { companyId: 'MAL', name: '' });
  assert.equal(resultado.ok, false);
  if (!resultado.ok) {
    const rutas = resultado.issues.map((i) => i.path);
    assert.ok(rutas.includes('companyId'));
    assert.ok(rutas.includes('name'));
    assert.ok(resultado.issues.every((i) => i.message.length > 0));
  }
});

test('ApiErrorSchema valida el error estructurado y es coherente con isApiError', () => {
  const valido = { code: 'validacion_fallida', message: 'Datos inválidos', step: 'validacion' };
  assert.equal(validate(ApiErrorSchema, valido).ok, true);
  assert.equal(isApiError(valido), true);
  assert.equal(validate(ApiErrorSchema, { ...valido, detail: 'campo x' }).ok, true);
  assert.equal(validate(ApiErrorSchema, { ...valido, step: 'otro' }).ok, false);
  assert.equal(isApiError({ ...valido, step: 'otro' }), false);
  assert.equal(validate(ApiErrorSchema, { ...valido, extra: 1 }).ok, false);
});
