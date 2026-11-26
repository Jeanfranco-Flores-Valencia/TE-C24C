'use strict';
// Equivalente en consola de MQTTX: se suscribe a tecsup/ii3010/lab13/<id>/# y muestra todo.
const mqtt = require('mqtt');
const P = require('./protocolo');
const url = process.env.MQTT_URL || 'mqtt://test.mosquitto.org:1883';
const c = mqtt.connect(url);
c.on('connect', () => { console.log(`Conectado a ${url}\nSuscrito a ${P.BASE}/#\n`); c.subscribe(`${P.BASE}/#`); });
c.on('message', (t, p) => console.log(`${new Date().toLocaleTimeString('es-PE', { hour12: false })}  ${t.split('/').pop().padEnd(10)}  ${p.toString()}`));
