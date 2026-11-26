'use strict';
/**
 * Simula el ESP32 del laboratorio (mismo comportamiento que parte_a/ y parte_b/src/main.cpp).
 * Sirve para probar Node-RED sin Wokwi.
 *   node simulador-esp32.js --parte a
 *   node simulador-esp32.js --parte b        (requiere LAB13_HMAC_KEY)
 * MQTT_URL cambia el broker (por defecto mqtt://test.mosquitto.org:1883).
 */
const mqtt = require('mqtt');
const crypto = require('crypto');
const P = require('./protocolo');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const parte = arg('parte', 'b');
const url = process.env.MQTT_URL || 'mqtt://test.mosquitto.org:1883';
const clave = process.env.LAB13_HMAC_KEY;
if (parte === 'b' && !clave) { console.error('Defina LAB13_HMAC_KEY (la misma clave que Node-RED)'); process.exit(1); }

let led = 'OFF', secuencia = 1, temp = 24 + Math.random(), hum = 55 + Math.random() * 3;
let ultimaSecuenciaComando = 0;
const tiempos = [];
const arranque = crypto.randomBytes(4).toString('hex');
const c = mqtt.connect(url, { clientId: `lab13-sim-${P.ID}-${arranque}` });
const auditoria = (e) => { c.publish(P.TOPICS.auditoria, e); console.log('[AUDITORÍA]', e); };

function telemetria() {
  temp += (Math.random() - 0.5) * 0.6; hum = Math.min(100, Math.max(0, hum + (Math.random() - 0.5)));
  const d = { dispositivo: P.ID, temperatura: Math.round(temp * 10) / 10, humedad: Math.round(hum * 10) / 10, led, secuencia: secuencia++ };
  if (parte === 'b') d.arranque = arranque;
  d.uptime = Math.round(process.uptime() * 1000);
  c.publish(P.TOPICS.telemetria, JSON.stringify(d));
  console.log('[TELEMETRÍA]', JSON.stringify(d));
}

function comandoParteA(m) {
  const s = m.trim().toUpperCase();
  if (s === 'ON' || s === 'OFF') { led = s; auditoria('COMANDO_ACEPTADO:' + s); } else auditoria('COMANDO_RECHAZADO:ACCION_INVALIDA');
}

function comandoParteB(m) {
  const ahora = Date.now();
  while (tiempos.length && ahora - tiempos[0] >= 10000) tiempos.shift();
  if (tiempos.length >= 5) return auditoria('COMANDO_RECHAZADO:FRECUENCIA');
  tiempos.push(ahora);
  if (m.length > 300) return auditoria('COMANDO_RECHAZADO:TAMANO');
  let cmd; try { cmd = JSON.parse(m); } catch { return auditoria('COMANDO_RECHAZADO:SIN_FIRMA'); }
  if (!cmd || typeof cmd !== 'object') return auditoria('COMANDO_RECHAZADO:SIN_FIRMA');
  if (!['ON', 'OFF'].includes(cmd.accion) || !(cmd.secuencia > 0) || !cmd.firma) return auditoria('COMANDO_RECHAZADO:FORMATO');
  if (!P.verificar(clave, cmd)) return auditoria('COMANDO_RECHAZADO:FIRMA_INVALIDA');
  if (cmd.secuencia <= ultimaSecuenciaComando) return auditoria('COMANDO_RECHAZADO:REPETIDO:' + cmd.secuencia);
  ultimaSecuenciaComando = cmd.secuencia;
  led = cmd.accion;
  auditoria(`COMANDO_ACEPTADO:${cmd.accion}:${cmd.secuencia}`);
}

c.on('connect', () => {
  console.log(`Simulador ESP32 (Parte ${parte.toUpperCase()}) conectado a ${url}`);
  c.subscribe(P.TOPICS.comando);
  auditoria('DISPOSITIVO_CONECTADO');
  telemetria();
});
c.on('message', (t, p) => {
  const m = p.toString();
  console.log(`[MQTT] Recibido en ${t}: ${m.slice(0, 120)}`);
  (parte === 'a' ? comandoParteA : comandoParteB)(m);
});
setInterval(() => c.connected && telemetria(), 5000);
