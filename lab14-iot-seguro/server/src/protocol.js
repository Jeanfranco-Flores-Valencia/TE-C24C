'use strict';
/**
 * Protocolo de mensajes firmados ESP32 <-> servidor.
 *
 * Todos los mensajes viajan como JSON por MQTT y llevan un campo "sig" con
 * HMAC-SHA256 (hex) calculado sobre una CADENA CANÓNICA, no sobre el JSON
 * (así el orden de claves o espacios no rompe la firma). El prefijo de la
 * cadena (T / A / C) indica el tipo y sentido del mensaje, de modo que una
 * firma de telemetría nunca sirve como firma de comando (anti‑reflexión).
 *
 *  Telemetría  (ESP32 -> srv) T|deviceId|boot|seq|ts|temp(1 dec)|hum(1 dec)|led(0/1)
 *  Auditoría   (ESP32 -> srv) A|deviceId|boot|seq|ts|event|ref|detail
 *  Comando     (srv -> ESP32) C|deviceId|cmdId|ts|action|value
 *
 * Este mismo formato está implementado en firmware/src/main.cpp y en el flujo
 * de Node-RED. Si cambia aquí, debe cambiar en los tres sitios.
 */
const crypto = require('crypto');

const fix1 = (n) => Number(n).toFixed(1);

function canonTelemetry(m) {
  return ['T', m.deviceId, m.boot, m.seq, m.ts, fix1(m.temp), fix1(m.hum), m.led ? 1 : 0].join('|');
}

function canonAudit(m) {
  return ['A', m.deviceId, m.boot, m.seq, m.ts, m.event, m.ref || '', m.detail || ''].join('|');
}

function canonCommand(m) {
  return ['C', m.deviceId, m.cmdId, m.ts, m.action, m.value].join('|');
}

function hmacHex(key, text) {
  return crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(text, 'utf8').digest('hex');
}

/** Comparación en tiempo constante (evita ataques de temporización). */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a.toLowerCase(), 'hex'), Buffer.from(b.toLowerCase(), 'hex'));
}

function signTelemetry(key, m) { return { ...m, sig: hmacHex(key, canonTelemetry(m)) }; }
function signAudit(key, m) { return { ...m, sig: hmacHex(key, canonAudit(m)) }; }
function signCommand(key, m) { return { ...m, sig: hmacHex(key, canonCommand(m)) }; }

function verify(key, kind, m) {
  const canon = kind === 'telemetry' ? canonTelemetry(m) : kind === 'audit' ? canonAudit(m) : canonCommand(m);
  return safeEqualHex(hmacHex(key, canon), m.sig);
}

const nowS = () => Math.floor(Date.now() / 1000);
const randomId = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');

module.exports = {
  canonTelemetry, canonAudit, canonCommand, hmacHex, safeEqualHex,
  signTelemetry, signAudit, signCommand, verify, nowS, randomId,
};
