'use strict';
const path = require('path');
require('dotenv').config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env'), quiet: true });

function int(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}
function num(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

/** DEVICE_KEYS="esp32-01:clave1,esp32-02:clave2" -> Map(deviceId -> clave) */
function parseDevices(raw) {
  const map = new Map();
  for (const part of (raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return map;
}

function load() {
  const cfg = {
    port: int('PORT', 3000),
    mqttUrl: process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883',
    mqttUser: process.env.MQTT_USER || undefined,
    mqttPass: process.env.MQTT_PASS || undefined,
    topicBase: (process.env.TOPIC_BASE || 'tecsup/lab14/CAMBIAME').replace(/\/+$/, ''),
    devices: parseDevices(process.env.DEVICE_KEYS),
    mongoUri: process.env.MONGODB_URI || '',
    mongoDb: process.env.MONGODB_DB || 'esp32_iot',
    dashboardToken: process.env.DASHBOARD_TOKEN || '',
    replayWindowS: int('REPLAY_WINDOW_S', 30),
    rateMax: int('RATE_MAX', 12),
    rateWindowS: int('RATE_WINDOW_S', 10),
    blockS: int('BLOCK_S', 60),
    badSigMax: int('BAD_SIG_MAX', 5),
    cmdMaxPerMin: int('CMD_MAX_PER_MIN', 20),
    offlineS: int('OFFLINE_S', 20),
    tempMin: num('TEMP_MIN', -40), tempMax: num('TEMP_MAX', 80),
    humMin: num('HUM_MIN', 0), humMax: num('HUM_MAX', 100),
    maxJump: num('MAX_TEMP_JUMP', 10),
    maxPayload: int('MAX_PAYLOAD', 512),
  };

  const problems = [];
  if (cfg.devices.size === 0) problems.push('DEVICE_KEYS vacío (formato id:clave)');
  for (const [id, k] of cfg.devices) if (k.length < 32) problems.push(`la clave de ${id} debe tener >= 32 caracteres`);
  if (cfg.dashboardToken.length < 16) problems.push('DASHBOARD_TOKEN debe tener >= 16 caracteres');
  if (cfg.topicBase.includes('CAMBIAME')) problems.push('TOPIC_BASE aún tiene el valor de ejemplo');
  if (problems.length) {
    const msg = 'Configuración inválida:\n - ' + problems.join('\n - ') + '\nCopie .env.example a .env y ejecute: npm run gen-secrets';
    if (process.env.NODE_ENV === 'test') throw new Error(msg);
    console.error(msg);
    process.exit(1);
  }
  return cfg;
}

module.exports = { load, parseDevices };
