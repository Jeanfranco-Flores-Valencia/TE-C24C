'use strict';
/**
 * Pruebas automáticas de la Parte B. Ejecutan el código REAL de los nodos
 * function del flow (leído de parte_b/node_red/flow_parte_b.json) con un
 * entorno mínimo de Node-RED (node, context, flow, env).
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const P = require('./protocolo');

const flow = require(path.join(__dirname, '..', 'parte_b', 'node_red', 'flow_parte_b.json'));
const KEY = 'clave-de-pruebas-automaticas-0123456789';

function nodo(id, envVars = { LAB13_HMAC_KEY: KEY }) {
  const def = flow.find((n) => n.id === id);
  const ctx = new Map(), fctx = new Map(), enviados = [];
  const store = (m) => ({ get: (k) => m.get(k), set: (k, v) => m.set(k, v) });
  const node = { send: (m) => enviados.push(m), status: () => {}, warn: () => {}, error: () => {} };
  const fn = new Function('msg', 'node', 'context', 'flow', 'env', 'crypto', def.func);
  const run = (msg) => { enviados.length = 0; const r = fn(msg, node, store(ctx), store(fctx), { get: (k) => envVars[k] }, crypto); return { r, enviados: [...enviados] }; };
  return { run, flowCtx: fctx };
}
const tele = (o = {}) => JSON.stringify({ dispositivo: P.ID, temperatura: 24.5, humedad: 55, led: 'OFF', secuencia: 1, arranque: 'a1b2c3d4', uptime: 10, ...o });
const evento = (res) => (res.enviados[0] && res.enviados[0][1] ? res.enviados[0][1].payload.evento : null);

test('el flow de la Parte A usa los topics de lab13 (la guía traía lab09)', () => {
  const a = require(path.join(__dirname, '..', 'parte_a', 'node_red', 'flow_parte_a.json'));
  const topics = a.filter((n) => n.type && n.type.startsWith('mqtt ')).map((n) => n.topic);
  assert.deepStrictEqual(topics.sort(), [P.TOPICS.auditoria, P.TOPICS.comando, P.TOPICS.telemetria].sort());
  assert.ok(a.find((n) => n.type === 'ui-page').path === '/lab13');
});

test('acepta telemetría válida', () => {
  const v = nodo('b_validar');
  const { r } = v.run({ payload: tele() });
  assert.strictEqual(r[0].payload.temperatura, 24.5);
});

test('rechaza telemetría anómala, inválida o de otro dispositivo', () => {
  const v = nodo('b_validar');
  assert.strictEqual(evento(v.run({ payload: tele({ temperatura: 500 }) })), 'TELEMETRIA_ANOMALA');
  assert.strictEqual(evento(v.run({ payload: tele({ humedad: 'mucha' }) })), 'TELEMETRIA_INVALIDA');
  assert.strictEqual(evento(v.run({ payload: tele({ dispositivo: 'intruso' }) })), 'TELEMETRIA_INVALIDA');
  assert.strictEqual(evento(v.run({ payload: '{no es json' })), 'TELEMETRIA_INVALIDA');
});

test('detecta telemetría repetida y distingue un reinicio legítimo', () => {
  const v = nodo('b_validar');
  assert.ok(v.run({ payload: tele({ secuencia: 7 }) }).r);
  assert.strictEqual(evento(v.run({ payload: tele({ secuencia: 7 }) })), 'TELEMETRIA_REPETIDA');
  assert.strictEqual(evento(v.run({ payload: tele({ secuencia: 3 }) })), 'TELEMETRIA_REPETIDA');
  const reinicio = v.run({ payload: tele({ secuencia: 1, arranque: '99999999' }) });
  assert.strictEqual(evento(reinicio), 'REINICIO_ESP32');
});

test('limita la frecuencia de mensajes (abuso)', () => {
  const v = nodo('b_validar');
  const eventos = [];
  for (let i = 1; i <= 10; i++) eventos.push(evento(v.run({ payload: tele({ secuencia: i }) })));
  assert.ok(eventos.includes('ABUSO_FRECUENCIA'));
});

test('firma comandos que el ESP32 acepta y con secuencia creciente', () => {
  const f = nodo('b_firmar');
  const a = JSON.parse(f.run({ payload: 'ON' }).r[0].payload);
  const b = JSON.parse(f.run({ payload: 'OFF' }).r[0].payload);
  assert.ok(P.verificar(KEY, a) && P.verificar(KEY, b));
  assert.ok(b.secuencia > a.secuencia);
  assert.strictEqual(a.firma, P.firmar(KEY, 'ON', a.secuencia));
});

test('sin clave no firma nada', () => {
  const f = nodo('b_firmar', {});
  const { r } = f.run({ payload: 'ON' });
  assert.strictEqual(r[0], null);
  assert.strictEqual(r[1].payload.evento, 'SIN_CLAVE');
});

test('una firma no sirve para otra acción ni para otra clave', () => {
  const c = P.comandoFirmado(KEY, 'ON', 123);
  assert.strictEqual(P.verificar(KEY, { ...c, accion: 'OFF' }), false);
  assert.strictEqual(P.verificar('otra-clave-distinta-0123456789', c), false);
});

test('vector compartido con la autoprueba del firmware', () => {
  assert.strictEqual(P.firmar('clave-de-prueba', 'ON', 1, 'floresvalencia').slice(0, 8), '9311997b');
});

test('la tabla de auditoría guarda los últimos 30 eventos y cuenta rechazos', () => {
  const acc = nodo('b_acumular');
  let r;
  for (let i = 0; i < 35; i++) r = acc.run({ payload: { nivel: 'alerta', origen: 'esp32', evento: 'COMANDO_RECHAZADO', detalle: 'x' + i } }).r;
  assert.strictEqual(r[0].payload.length, 30);
  assert.match(r[1].payload, /rechazados 35/);
});
