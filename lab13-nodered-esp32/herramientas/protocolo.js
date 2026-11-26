'use strict';
// Protocolo de la Parte B: el mismo que implementan el ESP32 (parte_b/src/main.cpp)
// y el flujo de Node-RED (parte_b/node_red/flow_parte_b.json).
const crypto = require('crypto');

const ID = process.env.LAB13_ID || 'floresvalencia';
const BASE = `tecsup/ii3010/lab13/${ID}`;
const TOPICS = { telemetria: `${BASE}/telemetria`, comando: `${BASE}/comando`, auditoria: `${BASE}/auditoria` };

const canon = (accion, secuencia, dispositivo = ID) => `${accion}|${secuencia}|${dispositivo}`;
const firmar = (clave, accion, secuencia, dispositivo = ID) =>
  crypto.createHmac('sha256', Buffer.from(clave, 'utf8')).update(canon(accion, secuencia, dispositivo)).digest('hex');

/** Comando firmado. La secuencia es Date.now(): crece siempre, aunque Node-RED se reinicie. */
function comandoFirmado(clave, accion, secuencia = Date.now()) {
  return { accion, secuencia, firma: firmar(clave, accion, secuencia) };
}

function verificar(clave, cmd) {
  if (!cmd || typeof cmd.firma !== 'string' || !/^[0-9a-f]{64}$/i.test(cmd.firma)) return false;
  const esperado = Buffer.from(firmar(clave, cmd.accion, cmd.secuencia), 'hex');
  return crypto.timingSafeEqual(esperado, Buffer.from(cmd.firma.toLowerCase(), 'hex'));
}

module.exports = { ID, BASE, TOPICS, canon, firmar, comandoFirmado, verificar };
