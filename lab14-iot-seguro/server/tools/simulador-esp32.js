'use strict';
/**
 * Simulador del ESP32 (mismo protocolo que firmware/src/main.cpp).
 * Útil para probar el servidor sin Wokwi.  Uso: npm run simulador [-- --id esp32-01 --intervalo 5]
 */
const mqtt = require('mqtt');
const P = require('../src/protocol');
const { load } = require('../src/config');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }

function createDevice(cfg, deviceId, { intervalS = 5, log = console.log } = {}) {
  const key = cfg.devices.get(deviceId);
  if (!key) throw new Error(`No hay clave para ${deviceId} en DEVICE_KEYS`);
  const boot = P.randomId(4);
  let seq = 0, led = false, temp = 24 + Math.random() * 2, hum = 55 + Math.random() * 5;
  const seenCmd = [];
  const cmdTimes = [];
  const base = `${cfg.topicBase}/${deviceId}`;
  const client = mqtt.connect(cfg.mqttUrl, { clientId: `sim-${deviceId}-${boot}`, username: cfg.mqttUser, password: cfg.mqttPass });

  const pubAudit = (event, ref, detail) => {
    const m = P.signAudit(key, { deviceId, boot, seq: seq++, ts: P.nowS(), event, ref, detail });
    client.publish(`${base}/audit`, JSON.stringify(m), { qos: 1 });
    log(`[audit] ${event} ${ref} ${detail}`);
  };
  const pubTelemetry = () => {
    temp += (Math.random() - 0.5) * 0.6; hum += (Math.random() - 0.5) * 1.2;
    hum = Math.max(0, Math.min(100, hum));
    const m = P.signTelemetry(key, { deviceId, boot, seq: seq++, ts: P.nowS(), temp: +temp.toFixed(1), hum: +hum.toFixed(1), led });
    client.publish(`${base}/telemetry`, JSON.stringify(m), { qos: 0 });
    log(`[tel] T=${m.temp} H=${m.hum} LED=${led} seq=${m.seq}`);
  };

  client.on('connect', () => {
    log(`Simulador ${deviceId} conectado (boot=${boot})`);
    client.subscribe(`${base}/cmd`, { qos: 1 });
    pubAudit('ARRANQUE', '', 'simulador');
    pubTelemetry();
  });
  client.on('message', (topic, payload) => {
    let c;
    try { c = JSON.parse(payload); } catch { return pubAudit('CMD_RECHAZADO', '', 'json_invalido'); }
    const ref = typeof c.cmdId === 'string' ? c.cmdId.slice(0, 32).replace(/\|/g, '') : '';
    const now = Date.now();
    while (cmdTimes.length && now - cmdTimes[0] > 10_000) cmdTimes.shift();
    cmdTimes.push(now);
    if (cmdTimes.length > 5) return pubAudit('ABUSO_CMD', ref, 'mas_de_5_cmd_en_10s');
    if (c.deviceId !== deviceId || c.action !== 'led' || !['on', 'off'].includes(c.value) || !Number.isInteger(c.ts)) return pubAudit('CMD_RECHAZADO', ref, 'esquema');
    if (!P.verify(key, 'command', c)) return pubAudit('CMD_RECHAZADO', ref, 'hmac_invalido');
    if (Math.abs(P.nowS() - c.ts) > cfg.replayWindowS) return pubAudit('CMD_RECHAZADO', ref, 'ts_fuera_de_ventana');
    if (seenCmd.includes(c.cmdId)) return pubAudit('CMD_RECHAZADO', ref, 'replay');
    seenCmd.push(c.cmdId); if (seenCmd.length > 32) seenCmd.shift();
    led = c.value === 'on';
    pubAudit('CMD_OK', ref, `led_${c.value}`);
    pubTelemetry();
  });
  const timer = setInterval(() => client.connected && pubTelemetry(), intervalS * 1000);
  return { client, stop: () => { clearInterval(timer); client.end(true); }, get led() { return led; } };
}

if (require.main === module) {
  const cfg = load();
  createDevice(cfg, arg('id', [...cfg.devices.keys()][0]), { intervalS: +arg('intervalo', 5) });
}

module.exports = { createDevice };
