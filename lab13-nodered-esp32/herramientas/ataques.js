'use strict';
/**
 * Pruebas NEGATIVAS contra la Parte B. Cada una debe aparecer en la tabla de
 * auditoría del dashboard (http://localhost:1880/dashboard/lab13-seguro).
 *   node ataques.js                     todas menos 'repetir-comando' y 'flood'
 *   node ataques.js repetir-comando     espera un comando del dashboard y lo reenvía
 *   node ataques.js flood               ráfaga de telemetría (abuso de frecuencia)
 */
const mqtt = require('mqtt');
const P = require('./protocolo');
const url = process.env.MQTT_URL || 'mqtt://test.mosquitto.org:1883';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tele = (o = {}) => JSON.stringify({ dispositivo: P.ID, temperatura: 25, humedad: 50, led: 'OFF', secuencia: 1, arranque: 'deadbeef', uptime: 1, ...o });

const ataques = {
  'telemetria-anomala': (c) => { c.publish(P.TOPICS.telemetria, tele({ temperatura: 500, secuencia: 100 })); return 'temperatura = 500 °C -> TELEMETRIA_ANOMALA'; },
  'telemetria-invalida': (c) => { c.publish(P.TOPICS.telemetria, tele({ humedad: 'mucha', secuencia: 101 })); return 'humedad como texto -> TELEMETRIA_INVALIDA'; },
  'dispositivo-falso': (c) => { c.publish(P.TOPICS.telemetria, tele({ dispositivo: 'intruso', secuencia: 102 })); return 'otro dispositivo -> TELEMETRIA_INVALIDA'; },
  'telemetria-repetida': (c) => new Promise((res) => {
    const to = setTimeout(() => res('no llegó telemetría en 15 s (¿ESP32 encendido?)'), 15000);
    c.subscribe(P.TOPICS.telemetria, () => c.once('message', (t, p) => {
      clearTimeout(to); c.unsubscribe(P.TOPICS.telemetria);
      setTimeout(() => c.publish(t, p), 300);
      res('telemetría real capturada y reenviada -> TELEMETRIA_REPETIDA');
    }));
  }),
  'comando-sin-firma': (c) => { c.publish(P.TOPICS.comando, 'ON'); return '"ON" en texto plano -> ESP32: COMANDO_RECHAZADO:SIN_FIRMA'; },
  'firma-falsa': (c) => { c.publish(P.TOPICS.comando, JSON.stringify({ accion: 'ON', secuencia: Date.now(), firma: 'a'.repeat(64) })); return 'firma inventada -> ESP32: COMANDO_RECHAZADO:FIRMA_INVALIDA'; },
  'repetir-comando': (c) => new Promise((res) => {
    console.log('   ...pulse ENCENDER o APAGAR en el dashboard');
    const to = setTimeout(() => res('no se vio ningún comando en 30 s'), 30000);
    c.subscribe(P.TOPICS.comando, () => c.once('message', (t, p) => {
      clearTimeout(to); c.unsubscribe(P.TOPICS.comando);
      setTimeout(() => c.publish(t, p), 1500);
      res('comando firmado capturado y reenviado -> ESP32: COMANDO_RECHAZADO:REPETIDO');
    }));
  }),
  flood: async (c) => {
    for (let i = 0; i < 15; i++) c.publish(P.TOPICS.telemetria, tele({ secuencia: 1000 + i, arranque: 'feedf00d' }));
    return '15 mensajes seguidos -> ABUSO_FRECUENCIA';
  },
};

(async () => {
  const pedidos = process.argv.slice(2).filter((a) => ataques[a]);
  const lista = pedidos.length ? pedidos : Object.keys(ataques).filter((k) => !['repetir-comando', 'flood'].includes(k));
  const c = mqtt.connect(url, { clientId: 'lab13-atacante-' + Date.now() });
  await new Promise((r) => c.on('connect', r));
  console.log(`Conectado a ${url}\n`);
  for (const n of lista) { console.log(`• ${n.padEnd(20)} ${await ataques[n](c)}`); await sleep(3000); }
  c.end();
})();
