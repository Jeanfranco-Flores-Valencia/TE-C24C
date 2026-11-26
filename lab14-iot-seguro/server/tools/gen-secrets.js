'use strict';
/**
 * Genera secretos aleatorios y crea/actualiza:
 *   server/.env                      (DEVICE_KEYS, DASHBOARD_TOKEN, TOPIC_BASE)
 *   firmware/include/secrets.h       (DEVICE_HMAC_KEY, TOPIC_BASE, DEVICE_ID)
 * Ambos archivos están en .gitignore. Use --force para regenerar.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..', '..');
const envPath = path.join(root, 'server', '.env');
const exPath = path.join(root, 'server', '.env.example');
const hPath = path.join(root, 'firmware', 'include', 'secrets.h');
const force = process.argv.includes('--force');
const deviceId = process.env.DEVICE_ID || 'esp32-01';

let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : fs.readFileSync(exPath, 'utf8');
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '';
const set = (k, v) => { env = new RegExp(`^${k}=`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : env + `\n${k}=${v}\n`; };

const needs = (v) => force || !v || /REEMPLAZAR|CAMBIAME/.test(v);
if (needs(get('DEVICE_KEYS'))) set('DEVICE_KEYS', `${deviceId}:${crypto.randomBytes(32).toString('hex')}`);
if (needs(get('DASHBOARD_TOKEN'))) set('DASHBOARD_TOKEN', crypto.randomBytes(18).toString('base64url'));
if (needs(get('TOPIC_BASE'))) set('TOPIC_BASE', `tecsup/lab14/${crypto.randomBytes(4).toString('hex')}`);
if (/USUARIO:CONTRASENA/.test(get('MONGODB_URI'))) set('MONGODB_URI', '');
fs.writeFileSync(envPath, env, { mode: 0o600 });

const [id, key] = get('DEVICE_KEYS').split(',')[0].split(':');
const h = `// GENERADO por "npm run gen-secrets". NO subir a Git (está en .gitignore).
#pragma once
#define WIFI_SSID        "Wokwi-GUEST"
#define WIFI_PASS        ""
#define MQTT_HOST        "${new URL(get('MQTT_URL').replace(/^mqtts?:/, 'http:')).hostname}"
#define MQTT_PORT        ${new URL(get('MQTT_URL').replace(/^mqtts?:/, 'http:')).port || 1883}
#define MQTT_USER        "${get('MQTT_USER')}"
#define MQTT_PASS        "${get('MQTT_PASS')}"
#define TOPIC_BASE       "${get('TOPIC_BASE')}"
#define DEVICE_ID        "${id}"
#define DEVICE_HMAC_KEY  "${key}"
`;
fs.writeFileSync(hPath, h, { mode: 0o600 });
console.log('OK ->', path.relative(root, envPath), 'y', path.relative(root, hPath));
console.log('TOPIC_BASE =', get('TOPIC_BASE'));
console.log('DASHBOARD_TOKEN está en server/.env (no se imprime por seguridad).');
console.log('Pegue su cadena de MongoDB Atlas en MONGODB_URI de server/.env');
