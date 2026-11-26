'use strict';
/**
 * Pruebas NEGATIVAS (ataques) contra el sistema. Cada una debe aparecer como
 * rechazo en la tabla de Auditoría del dashboard y en la colección "auditoria".
 *
 *   npm run ataques                 -> ejecuta todas
 *   npm run ataques -- firma replay -> solo las indicadas
 *
 * Ataques: firma, replay, viejo, rango, desconocido, esquema, mismatch, grande,
 *          cmd-falso, cmd-replay, flood
 */
const mqtt = require('mqtt');
const P = require('../src/protocol');
const { load } = require('../src/config');

const cfg = load();
const [deviceId, key] = [...cfg.devices.entries()][0];
const base = `${cfg.topicBase}/${deviceId}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const boot = 'deadbeef';
let seq = 1_000_000;
const tel = (over = {}) => ({ deviceId, boot, seq: seq++, ts: P.nowS(), temp: 25.0, hum: 50.0, led: false, ...over });

const ataques = {
  async firma(c) {
    // Atacante sin la clave: inventa una firma
    c.publish(`${base}/telemetry`, JSON.stringify({ ...tel({ temp: 99.0 }), sig: 'a'.repeat(64) }));
    return 'Telemetría con firma falsa -> esperado HMAC_INVALIDO';
  },
  async replay(c) {
    // Captura un mensaje legítimo del broker y lo reenvía tal cual
    return new Promise((resolve) => {
      const t = setTimeout(() => { c.unsubscribe(`${base}/telemetry`); resolve('No llegó telemetría legítima en 15 s (¿está el ESP32/simulador encendido?)'); }, 15000);
      c.subscribe(`${base}/telemetry`, () => {
        c.once('message', (topic, payload) => {
          clearTimeout(t); c.unsubscribe(`${base}/telemetry`);
          setTimeout(() => c.publish(topic, payload), 500);
          resolve('Mensaje legítimo capturado y re-publicado -> esperado REPLAY_DUPLICADO');
        });
      });
    });
  },
  async viejo(c) {
    // Mensaje correctamente firmado pero de hace 5 minutos (grabado y reenviado tarde)
    c.publish(`${base}/telemetry`, JSON.stringify(P.signTelemetry(key, tel({ ts: P.nowS() - 300 }))));
    return 'Mensaje firmado con ts de hace 300 s -> esperado REPLAY_TS';
  },
  async rango(c) {
    // Simula sensor manipulado / clave robada enviando valores físicamente imposibles
    c.publish(`${base}/telemetry`, JSON.stringify(P.signTelemetry(key, tel({ temp: 500.0 }))));
    return 'temp=500 °C firmada -> esperado FUERA_DE_RANGO';
  },
  async desconocido(c) {
    c.publish(`${cfg.topicBase}/intruso-99/telemetry`, JSON.stringify(P.signTelemetry('x'.repeat(64), { ...tel(), deviceId: 'intruso-99' })));
    return 'Dispositivo no registrado -> esperado DISPOSITIVO_DESCONOCIDO';
  },
  async esquema(c) {
    c.publish(`${base}/telemetry`, JSON.stringify({ ...tel(), temp: '25; DROP TABLE', sig: '0'.repeat(64) }));
    return 'temp como texto -> esperado ESQUEMA';
  },
  async mismatch(c) {
    c.publish(`${base}/telemetry`, JSON.stringify(P.signTelemetry(key, { ...tel(), deviceId: 'otro' })));
    return 'deviceId del mensaje distinto al del tópico -> esperado DEVICE_MISMATCH';
  },
  async grande(c) {
    c.publish(`${base}/telemetry`, 'X'.repeat(5000));
    return 'Payload de 5000 bytes -> esperado PAYLOAD_GRANDE';
  },
  async 'cmd-falso'(c) {
    c.publish(`${base}/cmd`, JSON.stringify({ deviceId, cmdId: 'falso0001', ts: P.nowS(), action: 'led', value: 'on', sig: 'b'.repeat(64) }));
    return 'Comando LED con firma falsa al ESP32 -> esperado CMD_RECHAZADO hmac_invalido (auditoría del dispositivo)';
  },
  async 'cmd-replay'(c) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { c.unsubscribe(`${base}/cmd`); resolve('No se observó ningún comando en 30 s: presione un botón del dashboard durante la prueba'); }, 30000);
      c.subscribe(`${base}/cmd`, () => {
        console.log('   ...esperando un comando legítimo: pulse Encender/Apagar en el dashboard');
        c.once('message', (topic, payload) => {
          clearTimeout(t); c.unsubscribe(`${base}/cmd`);
          setTimeout(() => c.publish(topic, payload), 1500);
          resolve('Comando legítimo capturado y re-enviado -> esperado CMD_RECHAZADO replay');
        });
      });
    });
  },
  async flood(c) {
    // Ráfaga de mensajes auténticos (firmware defectuoso / clave robada)
    for (let i = 0; i < cfg.rateMax + 8; i++) c.publish(`${base}/telemetry`, JSON.stringify(P.signTelemetry(key, tel({ temp: 25 + i / 10 }))));
    return `Ráfaga de ${cfg.rateMax + 8} mensajes -> esperado ABUSO_RATE y bloqueo de ${cfg.blockS}s`;
  },
};

(async () => {
  const pick = process.argv.slice(2).filter((a) => ataques[a]);
  const list = pick.length ? pick : Object.keys(ataques).filter((k) => k !== 'cmd-replay');
  const c = mqtt.connect(cfg.mqttUrl, { clientId: 'atacante-' + P.randomId(3), username: cfg.mqttUser, password: cfg.mqttPass });
  await new Promise((r) => c.on('connect', r));
  console.log(`Conectado a ${cfg.mqttUrl}. Objetivo: ${base}\n`);
  for (const name of list) {
    const r = await ataques[name](c);
    console.log(`• ${name.padEnd(12)} ${r}`);
    await sleep(800);
  }
  console.log('\nRevise la tabla de Auditoría del dashboard.');
  c.end();
})();
