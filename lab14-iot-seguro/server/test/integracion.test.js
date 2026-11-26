'use strict';
/**
 * Prueba de extremo a extremo con un broker MQTT local (aedes):
 * simulador ESP32 -> broker -> servidor -> almacén -> WebSocket (dashboard) -> comando LED -> ACK.
 */
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const WebSocket = require('ws');
const mqtt = require('mqtt');
const P = require('../src/protocol');
const { createApp } = require('../src/app');
const { MemoryStore } = require('../src/store');
const { createDevice } = require('../tools/simulador-esp32');

const crypto = require('crypto');
const KEY = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error('timeout esperando condición');
}

test('flujo completo con ataques', async () => {
  const aedes = require('aedes')();
  const broker = net.createServer(aedes.handle);
  await new Promise((r) => broker.listen(0, r));
  const mqttUrl = `mqtt://127.0.0.1:${broker.address().port}`;

  const cfg = {
    port: 0, mqttUrl, topicBase: 'test/lab14', devices: new Map([['esp32-01', KEY]]), dashboardToken: 'token-de-prueba-123',
    replayWindowS: 30, rateMax: 50, rateWindowS: 10, blockS: 60, badSigMax: 5, cmdMaxPerMin: 20, offlineS: 20,
    tempMin: -40, tempMax: 80, humMin: 0, humMax: 100, maxJump: 10, maxPayload: 512,
  };
  const store = new MemoryStore();
  const app = createApp(cfg, { store, log: process.env.DEBUG ? console.log : () => {} });
  const port = await app.start();
  const dev = createDevice(cfg, 'esp32-01', { intervalS: 1, log: () => {} });

  try {
    // 1) Telemetría llega y se guarda
    await until(() => store.t.length >= 2);
    assert.ok(store.t.every((t) => t.firmaVerificada));

    // 2) Dashboard: token incorrecto rechazado
    const bad = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => bad.on('open', r));
    bad.send(JSON.stringify({ type: 'auth', token: 'malo' }));
    const code = await new Promise((r) => bad.on('close', (c) => r(c)));
    assert.strictEqual(code, 4003);

    // 3) Dashboard correcto: recibe snapshot y telemetría en vivo, envía comando
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const got = [];
    ws.on('message', (d) => got.push(JSON.parse(d)));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'auth', token: cfg.dashboardToken }));
    await until(() => got.find((m) => m.type === 'snapshot'));
    await until(() => got.find((m) => m.type === 'telemetry'));
    ws.send(JSON.stringify({ type: 'cmd', deviceId: 'esp32-01', value: 'on' }));
    await until(() => got.find((m) => m.type === 'cmd' && m.data.estado === 'ejecutado'));
    assert.strictEqual(dev.led, true);
    await until(() => store.t.at(-1).led === true);

    // 4) Ataques
    const atk = mqtt.connect(mqttUrl);
    await new Promise((r) => atk.on('connect', r));
    const codes = () => store.a.map((a) => a.codigo);
    atk.publish('test/lab14/esp32-01/telemetry', JSON.stringify({ deviceId: 'esp32-01', boot: 'deadbeef', seq: 1, ts: P.nowS(), temp: 99, hum: 1, led: false, sig: 'a'.repeat(64) }));
    await until(() => codes().includes('HMAC_INVALIDO'));

    const legit = P.signTelemetry(KEY, { deviceId: 'esp32-01', boot: 'deadbeef', seq: 5, ts: P.nowS(), temp: 25, hum: 50, led: false });
    atk.publish('test/lab14/esp32-01/telemetry', JSON.stringify(legit));
    await sleep(200);
    atk.publish('test/lab14/esp32-01/telemetry', JSON.stringify(legit));
    await until(() => codes().includes('REPLAY_DUPLICADO'));

    atk.publish('test/lab14/esp32-01/cmd', JSON.stringify({ deviceId: 'esp32-01', cmdId: 'f00', ts: P.nowS(), action: 'led', value: 'off', sig: 'b'.repeat(64) }));
    await until(() => store.a.find((a) => a.origen === 'dispositivo' && a.codigo === 'CMD_RECHAZADO' && /hmac_invalido/.test(a.detalle)));
    assert.strictEqual(dev.led, true, 'el comando falso NO debe cambiar el LED');

    // replay de un comando legítimo capturado
    let captured;
    atk.subscribe('test/lab14/esp32-01/cmd');
    atk.on('message', (t, p) => { captured = captured || p; });
    await sleep(200);
    await app.sendCommand('esp32-01', 'off', 'test');
    await until(() => captured && !dev.led);
    atk.publish('test/lab14/esp32-01/cmd', captured);
    await until(() => store.a.find((a) => a.codigo === 'CMD_RECHAZADO' && /replay/.test(a.detalle)));

    atk.end(true);
    ws.close();
  } finally {
    dev.stop();
    await app.stop();
    await new Promise((r) => aedes.close(r));
    broker.close();
  }
});
