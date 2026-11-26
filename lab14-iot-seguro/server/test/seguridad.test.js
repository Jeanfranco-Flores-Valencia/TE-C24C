'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/protocol');
const { Guard } = require('../src/guard');

const KEY = 'k'.repeat(64);
const cfg = {
  devices: new Map([['esp32-01', KEY]]), replayWindowS: 30, rateMax: 5, rateWindowS: 10, blockS: 60, badSigMax: 3,
  tempMin: -40, tempMax: 80, humMin: 0, humMax: 100, maxJump: 10, maxPayload: 512,
};
let seq = 0;
const tel = (o = {}) => ({ deviceId: 'esp32-01', boot: 'a1b2c3d4', seq: seq++, ts: P.nowS(), temp: 24.5, hum: 60.2, led: false, ...o });
const buf = (m) => Buffer.from(JSON.stringify(m));

test('vector conocido: la cadena canónica y el HMAC coinciden con el firmware', () => {
  const m = { deviceId: 'esp32-01', boot: '0000abcd', seq: 7, ts: 1700000000, temp: 23.4, hum: 51, led: true };
  assert.strictEqual(P.canonTelemetry(m), 'T|esp32-01|0000abcd|7|1700000000|23.4|51.0|1');
  // Mismo vector que imprime el firmware con SELFTEST (y que da: openssl dgst -sha256 -hmac clave)
  assert.strictEqual(P.hmacHex('clave', P.canonTelemetry(m)), 'c885b1c4ccb31ff5c0eba91b9c7e1514e316e35e0a12937a2bc3711dca33a008');
});

test('acepta telemetría auténtica', () => {
  const g = new Guard(cfg);
  const r = g.check('telemetry', 'esp32-01', buf(P.signTelemetry(KEY, tel())));
  assert.ok(r.ok, JSON.stringify(r));
});

test('rechaza firma falsa', () => {
  const g = new Guard(cfg);
  const r = g.check('telemetry', 'esp32-01', buf({ ...tel(), sig: 'a'.repeat(64) }));
  assert.strictEqual(r.code, 'HMAC_INVALIDO');
});

test('rechaza mensaje alterado después de firmar', () => {
  const g = new Guard(cfg);
  const m = P.signTelemetry(KEY, tel());
  m.temp = 30.0;
  assert.strictEqual(g.check('telemetry', 'esp32-01', buf(m)).code, 'HMAC_INVALIDO');
});

test('firma de telemetría no sirve como firma de comando (anti-reflexión)', () => {
  const t = P.signTelemetry(KEY, tel());
  assert.strictEqual(P.verify(KEY, 'command', { deviceId: 'esp32-01', cmdId: 'x', ts: t.ts, action: 'led', value: 'on', sig: t.sig }), false);
});

test('rechaza mensaje repetido (replay)', () => {
  const g = new Guard(cfg);
  const raw = buf(P.signTelemetry(KEY, tel()));
  assert.ok(g.check('telemetry', 'esp32-01', raw).ok);
  assert.strictEqual(g.check('telemetry', 'esp32-01', raw).code, 'REPLAY_DUPLICADO');
});

test('rechaza seq anterior del mismo arranque', () => {
  const g = new Guard(cfg);
  const a = P.signTelemetry(KEY, tel({ seq: 100 }));
  const b = P.signTelemetry(KEY, tel({ seq: 50 }));
  assert.ok(g.check('telemetry', 'esp32-01', buf(a)).ok);
  assert.strictEqual(g.check('telemetry', 'esp32-01', buf(b)).code, 'REPLAY_SEQ');
});

test('rechaza timestamp fuera de ventana', () => {
  const g = new Guard(cfg);
  assert.strictEqual(g.check('telemetry', 'esp32-01', buf(P.signTelemetry(KEY, tel({ ts: P.nowS() - 120 })))).code, 'REPLAY_TS');
});

test('valida rangos y esquema', () => {
  const g = new Guard(cfg);
  assert.strictEqual(g.check('telemetry', 'esp32-01', buf(P.signTelemetry(KEY, tel({ temp: 200 })))).code, 'FUERA_DE_RANGO');
  assert.strictEqual(g.check('telemetry', 'esp32-01', buf(P.signTelemetry(KEY, tel({ hum: -5 })))).code, 'FUERA_DE_RANGO');
  assert.strictEqual(g.check('telemetry', 'esp32-01', buf({ ...tel(), temp: '25', sig: '0'.repeat(64) })).code, 'ESQUEMA');
  assert.strictEqual(g.check('telemetry', 'esp32-01', Buffer.from('{no json')).code, 'JSON_INVALIDO');
  assert.strictEqual(g.check('telemetry', 'esp32-01', Buffer.alloc(600, 'x')).code, 'PAYLOAD_GRANDE');
  assert.strictEqual(g.check('telemetry', 'otro', buf(tel({ deviceId: 'otro' }))).code, 'DISPOSITIVO_DESCONOCIDO');
  assert.strictEqual(g.check('telemetry', 'esp32-01', buf(P.signTelemetry(KEY, tel({ deviceId: 'x' })))).code, 'DEVICE_MISMATCH');
});

test('detecta anomalía (salto brusco) sin rechazar', () => {
  const g = new Guard(cfg);
  assert.ok(g.check('telemetry', 'esp32-01', buf(P.signTelemetry(KEY, tel({ temp: 20 })))).ok);
  const r = g.check('telemetry', 'esp32-01', buf(P.signTelemetry(KEY, tel({ temp: 45 }))));
  assert.ok(r.ok);
  assert.match(r.warnings[0], /ANOMALIA/);
});

test('detecta abuso: flood de mensajes auténticos -> bloqueo', () => {
  const g = new Guard(cfg);
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push(g.check('telemetry', 'esp32-01', buf(P.signTelemetry(KEY, tel()))).code);
  assert.ok(codes.includes('ABUSO_RATE'));
  const r = g.check('telemetry', 'esp32-01', buf(P.signTelemetry(KEY, tel())));
  assert.strictEqual(r.code, 'BLOQUEADO');
});

test('detecta ráfaga de firmas falsas sin bloquear al dispositivo legítimo', () => {
  const g = new Guard(cfg);
  let last;
  for (let i = 0; i < 4; i++) last = g.check('telemetry', 'esp32-01', buf({ ...tel(), sig: 'c'.repeat(64) }));
  assert.strictEqual(last.code, 'ATAQUE_FIRMAS');
  assert.ok(g.check('telemetry', 'esp32-01', buf(P.signTelemetry(KEY, tel()))).ok);
});

test('auditoría del dispositivo: firma y campos validados', () => {
  const g = new Guard(cfg);
  const a = P.signAudit(KEY, { deviceId: 'esp32-01', boot: 'a1b2c3d4', seq: seq++, ts: P.nowS(), event: 'CMD_OK', ref: 'abc', detail: 'led_on' });
  assert.ok(g.check('audit', 'esp32-01', buf(a)).ok);
  const bad = P.signAudit(KEY, { deviceId: 'esp32-01', boot: 'a1b2c3d4', seq: seq++, ts: P.nowS(), event: 'X|Y', ref: '', detail: '' });
  assert.strictEqual(g.check('audit', 'esp32-01', buf(bad)).code, 'ESQUEMA');
});
