'use strict';
/**
 * Servidor IoT: MQTT (ESP32) <-> validación <-> MongoDB Atlas <-> WebSockets (dashboard).
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const mqtt = require('mqtt');
const P = require('./protocol');
const { Guard } = require('./guard');
const { createStore } = require('./store');

function tokenOk(cfg, t) {
  if (typeof t !== 'string') return false;
  const a = crypto.createHash('sha256').update(t).digest();
  const b = crypto.createHash('sha256').update(cfg.dashboardToken).digest();
  return crypto.timingSafeEqual(a, b);
}

function createApp(cfg, opts = {}) {
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), ...a));
  const store = opts.store || createStore(cfg);
  const guard = new Guard(cfg);
  const devices = new Map(); // deviceId -> {lastSeen, last, boot}
  const pendingCmds = new Map(); // cmdId -> {deviceId, value, fecha}
  const cmdTimes = [];
  const auditThrottle = new Map(); // codigo:device -> {count, since, suppressed}
  let mqttClient;

  // ---------------- Auditoría ----------------
  async function audit(entry) {
    const key = `${entry.codigo}:${entry.deviceId || '-'}`;
    const now = Date.now();
    const th = auditThrottle.get(key) || { count: 0, since: now, suppressed: 0 };
    if (now - th.since > 10_000) {
      if (th.suppressed) {
        const sum = { fecha: new Date(), origen: 'servidor', nivel: 'alerta', codigo: 'AUDITORIA_AGREGADA',
          deviceId: entry.deviceId, detalle: `${th.suppressed} eventos ${entry.codigo} omitidos en 10s` };
        await store.addAudit(sum); broadcast({ type: 'audit', data: sum });
      }
      th.count = 0; th.since = now; th.suppressed = 0;
    }
    th.count++;
    auditThrottle.set(key, th);
    if (th.count > 5) { th.suppressed++; return; } // evita que un flood llene la BD
    const doc = { fecha: new Date(), ...entry };
    try { await store.addAudit(doc); } catch (e) { log('Error guardando auditoría:', e.message); }
    broadcast({ type: 'audit', data: doc });
    log(`[AUDIT][${doc.nivel}] ${doc.codigo} ${doc.deviceId || ''} ${doc.detalle || ''}`);
  }

  // ---------------- MQTT ----------------
  const tTel = `${cfg.topicBase}/+/telemetry`;
  const tAud = `${cfg.topicBase}/+/audit`;

  async function onMqtt(topic, payload) {
    const rest = topic.slice(cfg.topicBase.length + 1).split('/');
    if (rest.length !== 2) return;
    const [deviceId, kindRaw] = rest;
    const kind = kindRaw === 'telemetry' ? 'telemetry' : kindRaw === 'audit' ? 'audit' : null;
    if (!kind) return;

    const r = guard.check(kind, deviceId, payload);
    if (!r.ok) {
      await audit({ origen: 'servidor', nivel: r.alert ? 'alerta' : 'warn', codigo: r.code, deviceId, detalle: r.detail });
      broadcast({ type: 'rejected', data: { deviceId, codigo: r.code, detalle: r.detail, fecha: new Date() } });
      return;
    }
    const m = r.msg;
    const dev = devices.get(deviceId) || {};
    if (dev.boot && dev.boot !== m.boot) {
      await audit({ origen: 'servidor', nivel: 'info', codigo: 'REINICIO_DISPOSITIVO', deviceId, detalle: `boot ${dev.boot} -> ${m.boot}` });
    }
    dev.boot = m.boot;
    dev.lastSeen = Date.now();
    devices.set(deviceId, dev);

    if (kind === 'telemetry') {
      const doc = { deviceId, temp: m.temp, hum: m.hum, led: m.led, boot: m.boot, seq: m.seq, ts: m.ts,
        fecha: new Date(m.ts * 1000), recibido: new Date(), firmaVerificada: true };
      dev.last = doc;
      try { await store.addTelemetry(doc); } catch (e) { log('Error guardando telemetría:', e.message); }
      broadcast({ type: 'telemetry', data: doc });
      for (const w of r.warnings) await audit({ origen: 'servidor', nivel: 'alerta', codigo: 'ANOMALIA', deviceId, detalle: w });
    } else {
      // Auditoría firmada enviada por el ESP32 (ACK de comandos, rechazos locales, arranque)
      const nivel = m.event === 'CMD_OK' || m.event === 'ARRANQUE' ? 'info' : 'alerta';
      await audit({ origen: 'dispositivo', nivel, codigo: m.event, deviceId, detalle: `${m.ref ? 'ref=' + m.ref + ' ' : ''}${m.detail}` });
      if (m.ref && pendingCmds.has(m.ref)) {
        const estado = m.event === 'CMD_OK' ? 'ejecutado' : 'rechazado_por_dispositivo';
        pendingCmds.delete(m.ref);
        await store.updateCommand(m.ref, { estado, respuesta: m.detail, confirmado: new Date() }).catch(() => {});
        broadcast({ type: 'cmd', data: { cmdId: m.ref, estado, detalle: m.detail } });
      }
    }
  }

  function connectMqtt() {
    return new Promise((resolve) => {
      mqttClient = mqtt.connect(cfg.mqttUrl, {
        clientId: 'lab14-srv-' + P.randomId(4), username: cfg.mqttUser, password: cfg.mqttPass,
        reconnectPeriod: 3000, connectTimeout: 10000, clean: true,
      });
      mqttClient.on('connect', () => {
        log(`MQTT conectado a ${cfg.mqttUrl}`);
        mqttClient.subscribe([tTel, tAud], { qos: 1 }, (err) => {
          if (err) log('Error de suscripción MQTT:', err.message);
          broadcastStatus();
          resolve();
        });
      });
      mqttClient.on('reconnect', () => log('MQTT reconectando...'));
      mqttClient.on('error', (e) => log('MQTT error:', e.message));
      mqttClient.on('close', () => broadcastStatus());
      mqttClient.on('message', (t, p) => { onMqtt(t, p).catch((e) => log('Error procesando mensaje:', e)); });
    });
  }

  // ---------------- Comandos (servidor -> ESP32) ----------------
  async function sendCommand(deviceId, value, origen) {
    const key = cfg.devices.get(deviceId);
    if (!key) return { ok: false, error: 'dispositivo desconocido' };
    if (!['on', 'off'].includes(value)) return { ok: false, error: 'valor inválido (on|off)' };
    const now = Date.now();
    while (cmdTimes.length && now - cmdTimes[0] > 60_000) cmdTimes.shift();
    if (cmdTimes.length >= cfg.cmdMaxPerMin) {
      await audit({ origen: 'servidor', nivel: 'alerta', codigo: 'ABUSO_COMANDOS', deviceId, detalle: `más de ${cfg.cmdMaxPerMin} comandos/min (${origen})` });
      return { ok: false, error: 'demasiados comandos, espere un momento' };
    }
    cmdTimes.push(now);
    const cmd = P.signCommand(key, { deviceId, cmdId: P.randomId(8), ts: P.nowS(), action: 'led', value });
    if (!mqttClient?.connected) return { ok: false, error: 'broker MQTT desconectado' };
    mqttClient.publish(`${cfg.topicBase}/${deviceId}/cmd`, JSON.stringify(cmd), { qos: 1 });
    pendingCmds.set(cmd.cmdId, { deviceId, value, fecha: new Date() });
    setTimeout(async () => {
      if (pendingCmds.delete(cmd.cmdId)) {
        await store.updateCommand(cmd.cmdId, { estado: 'sin_respuesta' }).catch(() => {});
        broadcast({ type: 'cmd', data: { cmdId: cmd.cmdId, estado: 'sin_respuesta' } });
        await audit({ origen: 'servidor', nivel: 'warn', codigo: 'CMD_SIN_ACK', deviceId, detalle: `cmd ${cmd.cmdId}` });
      }
    }, 10_000).unref();
    await store.addCommand({ cmdId: cmd.cmdId, deviceId, accion: 'led', valor: value, origen, estado: 'enviado', fecha: new Date() });
    await audit({ origen: 'dashboard', nivel: 'info', codigo: 'CMD_ENVIADO', deviceId, detalle: `led=${value} cmd=${cmd.cmdId} (${origen})` });
    return { ok: true, cmdId: cmd.cmdId };
  }

  // ---------------- HTTP + WebSocket ----------------
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:",
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    });
    next();
  });
  app.use(express.json({ limit: '2kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  // Chart.js servido localmente (sin depender de un CDN externo)
  app.get('/vendor/chart.umd.js', (req, res) => res.sendFile(path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js')));

  const auth = (req, res, next) => {
    const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!tokenOk(cfg, t)) return res.status(401).json({ error: 'no autorizado' });
    next();
  };
  app.get('/api/salud', (req, res) => res.json({ ok: true, mqtt: !!mqttClient?.connected, bd: store.kind }));
  app.get('/api/telemetria', auth, async (req, res) => res.json(await store.recentTelemetry(Math.min(+req.query.limit || 100, 1000))));
  app.get('/api/auditoria', auth, async (req, res) => res.json(await store.recentAudit(Math.min(+req.query.limit || 100, 1000))));
  app.post('/api/comando', auth, async (req, res) => {
    const r = await sendCommand(String(req.body?.deviceId || ''), String(req.body?.value || ''), 'api');
    res.status(r.ok ? 200 : 400).json(r);
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

  function broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const c of wss.clients) if (c.authed && c.readyState === 1) c.send(s);
  }
  function statusPayload() {
    const list = [...cfg.devices.keys()].map((id) => {
      const d = devices.get(id) || {};
      return { deviceId: id, online: !!d.lastSeen && Date.now() - d.lastSeen < cfg.offlineS * 1000,
        lastSeen: d.lastSeen || null, led: d.last?.led ?? null, bloqueado: guard.isBlocked(id) };
    });
    return { type: 'status', data: { mqtt: !!mqttClient?.connected, bd: store.kind, dispositivos: list } };
  }
  function broadcastStatus() { broadcast(statusPayload()); }
  const statusTimer = setInterval(broadcastStatus, 3000);
  statusTimer.unref();

  wss.on('connection', (ws) => {
    ws.authed = false;
    const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
    let msgs = [];
    ws.on('message', async (raw) => {
      const now = Date.now();
      msgs = msgs.filter((t) => now - t < 10_000); msgs.push(now);
      if (msgs.length > 30) return ws.close(4008, 'flood');
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!ws.authed) {
        if (m.type === 'auth' && tokenOk(cfg, m.token)) {
          ws.authed = true; clearTimeout(authTimer);
          ws.send(JSON.stringify({ type: 'auth', ok: true, devices: [...cfg.devices.keys()] }));
          ws.send(JSON.stringify({ type: 'snapshot', data: {
            telemetria: await store.recentTelemetry(60), auditoria: await store.recentAudit(50) } }));
          ws.send(JSON.stringify(statusPayload()));
        } else {
          await audit({ origen: 'servidor', nivel: 'alerta', codigo: 'DASHBOARD_TOKEN_INVALIDO', detalle: 'intento de acceso al dashboard con token incorrecto' });
          ws.send(JSON.stringify({ type: 'auth', ok: false }));
          ws.close(4003, 'token inválido');
        }
        return;
      }
      if (m.type === 'cmd') {
        const r = await sendCommand(String(m.deviceId), String(m.value), 'dashboard');
        ws.send(JSON.stringify({ type: 'cmd', data: r.ok ? { cmdId: r.cmdId, estado: 'enviado' } : { estado: 'error', detalle: r.error } }));
      }
    });
    ws.on('close', () => clearTimeout(authTimer));
  });

  async function start() {
    await store.init();
    log(`Almacenamiento: ${store.kind}`);
    await new Promise((r) => server.listen(cfg.port, r));
    log(`Dashboard en http://localhost:${server.address().port}`);
    await Promise.race([connectMqtt(), new Promise((r) => setTimeout(r, 15000))]);
    await audit({ origen: 'servidor', nivel: 'info', codigo: 'SERVIDOR_INICIADO', detalle: `bd=${store.kind} topic=${cfg.topicBase}` });
    return server.address().port;
  }
  async function stop() {
    clearInterval(statusTimer);
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
    await new Promise((r) => (mqttClient ? mqttClient.end(true, r) : r()));
    await store.close();
  }

  return { start, stop, sendCommand, store, guard, devices };
}

module.exports = { createApp };
