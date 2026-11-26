'use strict';
/**
 * Controles de ciberseguridad aplicados a TODO mensaje que llega del broker:
 *  1. Tamaño máximo y JSON válido.
 *  2. Dispositivo en lista blanca (deviceId del tópico == deviceId del mensaje).
 *  3. Bloqueo temporal si el dispositivo fue bloqueado por abuso.
 *  4. Esquema (tipos) del mensaje.
 *  5. HMAC-SHA256 en tiempo constante (+ alerta si hay ráfagas de firmas falsas).
 *  6. Limitación de tasa (rate limit) de mensajes auténticos -> bloqueo temporal.
 *  7. Anti‑repetición: ventana de tiempo + id único (boot-seq) + ventana deslizante de seq.
 *  8. Rangos físicos y detección de anomalías (saltos bruscos de temperatura).
 * Cada rechazo devuelve un código para la auditoría.
 */
const P = require('./protocol');

const SEQ_WINDOW = 32;

class Guard {
  constructor(cfg, clock = () => Date.now()) {
    this.cfg = cfg;
    this.clock = clock;
    this.seen = new Map();      // msgId -> expiración (ms)
    this.lastSeq = new Map();   // deviceId -> {boot, seq}
    this.rate = new Map();      // deviceId -> [timestamps ms]
    this.badSig = new Map();    // deviceId -> [timestamps ms]
    this.blocked = new Map();   // deviceId -> hasta (ms)
    this.lastTemp = new Map();  // deviceId -> temp
  }

  nowS() { return Math.floor(this.clock() / 1000); }

  _window(map, key, windowMs) {
    const now = this.clock();
    const arr = (map.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    map.set(key, arr);
    return arr.length;
  }

  _purgeSeen() {
    const now = this.clock();
    if (this.seen.size < 5000 && Math.random() > 0.05) return;
    for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k);
  }

  isBlocked(deviceId) {
    const until = this.blocked.get(deviceId);
    if (!until) return false;
    if (until < this.clock()) { this.blocked.delete(deviceId); return false; }
    return true;
  }

  block(deviceId) { this.blocked.set(deviceId, this.clock() + this.cfg.blockS * 1000); }

  /**
   * @param {'telemetry'|'audit'} kind
   * @param {string} topicDeviceId deviceId extraído del tópico
   * @param {Buffer|string} raw payload MQTT
   * @returns {{ok:true,msg:object,warnings:string[]}|{ok:false,code:string,detail:string,deviceId?:string,alert?:boolean}}
   */
  check(kind, topicDeviceId, raw) {
    const c = this.cfg;
    const fail = (code, detail, extra = {}) => ({ ok: false, code, detail, deviceId: topicDeviceId, ...extra });

    if (raw.length > c.maxPayload) return fail('PAYLOAD_GRANDE', `${raw.length} bytes > ${c.maxPayload}`);
    let m;
    try { m = JSON.parse(raw.toString('utf8')); } catch { return fail('JSON_INVALIDO', 'no se pudo parsear'); }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return fail('JSON_INVALIDO', 'no es un objeto');

    const key = c.devices.get(topicDeviceId);
    if (!key) return fail('DISPOSITIVO_DESCONOCIDO', `deviceId "${topicDeviceId}" no está en la lista blanca`);
    if (m.deviceId !== topicDeviceId) return fail('DEVICE_MISMATCH', `tópico=${topicDeviceId} mensaje=${m.deviceId}`);

    if (this.isBlocked(topicDeviceId)) return fail('BLOQUEADO', 'dispositivo bloqueado temporalmente por abuso');

    // Esquema común
    if (typeof m.boot !== 'string' || !/^[0-9a-f]{8}$/i.test(m.boot)) return fail('ESQUEMA', 'boot inválido');
    if (!Number.isInteger(m.seq) || m.seq < 0) return fail('ESQUEMA', 'seq inválido');
    if (!Number.isInteger(m.ts)) return fail('ESQUEMA', 'ts inválido');
    if (typeof m.sig !== 'string') return fail('ESQUEMA', 'sig ausente');

    if (kind === 'telemetry') {
      if (typeof m.temp !== 'number' || !Number.isFinite(m.temp)) return fail('ESQUEMA', 'temp no numérica');
      if (typeof m.hum !== 'number' || !Number.isFinite(m.hum)) return fail('ESQUEMA', 'hum no numérica');
      if (typeof m.led !== 'boolean') return fail('ESQUEMA', 'led no booleano');
    } else {
      for (const f of ['event', 'ref', 'detail']) {
        if (typeof m[f] !== 'string' || m[f].length > 64 || m[f].includes('|')) return fail('ESQUEMA', `${f} inválido`);
      }
    }

    // Firma: antes de mirar rangos, para no confiar en datos no autenticados
    if (!P.verify(key, kind, m)) {
      // No se bloquea al dispositivo legítimo (eso permitiría a un atacante
      // provocar una denegación de servicio); se descarta y se alerta.
      const bad = this._window(this.badSig, topicDeviceId, 60_000);
      if (bad >= c.badSigMax) {
        return fail('ATAQUE_FIRMAS', `${bad} firmas inválidas en 60s: posible suplantación/fuerza bruta`, { alert: true });
      }
      return fail('HMAC_INVALIDO', 'la firma HMAC no coincide');
    }

    // Abuso de un emisor autenticado (firmware defectuoso o clave robada): bloqueo temporal
    const n = this._window(this.rate, topicDeviceId, c.rateWindowS * 1000);
    if (n > c.rateMax) {
      this.block(topicDeviceId);
      return fail('ABUSO_RATE', `${n} mensajes en ${c.rateWindowS}s (máx ${c.rateMax}); bloqueado ${c.blockS}s`, { alert: true });
    }

    // Anti-repetición
    const skew = Math.abs(this.nowS() - m.ts);
    if (skew > c.replayWindowS) return fail('REPLAY_TS', `ts fuera de ventana (${skew}s > ${c.replayWindowS}s)`);
    const msgId = `${topicDeviceId}:${m.boot}:${m.seq}`;
    if (this.seen.has(msgId)) return fail('REPLAY_DUPLICADO', `mensaje ${m.boot}-${m.seq} ya recibido`, { alert: true });
    const last = this.lastSeq.get(topicDeviceId);
    // Ventana deslizante (como IPsec): MQTT puede entregar desordenados mensajes de
    // distinto QoS, así que se toleran SEQ_WINDOW posiciones de atraso; los duplicados
    // dentro de la ventana ya los detecta la caché de msgId.
    if (last && last.boot === m.boot && m.seq <= last.seq - SEQ_WINDOW) {
      return fail('REPLAY_SEQ', `seq ${m.seq} demasiado antiguo (último ${last.seq})`, { alert: true });
    }

    // Rangos físicos (después de autenticar: datos firmados pero imposibles = sensor dañado o clave robada)
    const warnings = [];
    if (kind === 'telemetry') {
      if (m.temp < c.tempMin || m.temp > c.tempMax) return fail('FUERA_DE_RANGO', `temp=${m.temp} fuera de [${c.tempMin},${c.tempMax}]`);
      if (m.hum < c.humMin || m.hum > c.humMax) return fail('FUERA_DE_RANGO', `hum=${m.hum} fuera de [${c.humMin},${c.humMax}]`);
      const prev = this.lastTemp.get(topicDeviceId);
      if (prev !== undefined && Math.abs(m.temp - prev) > c.maxJump) {
        warnings.push(`ANOMALIA: salto de temperatura ${prev} -> ${m.temp}`);
      }
      this.lastTemp.set(topicDeviceId, m.temp);
    }

    // Aceptado: registrar para anti-repetición
    this.seen.set(msgId, this.clock() + 2 * c.replayWindowS * 1000);
    if (!last || last.boot !== m.boot || m.seq > last.seq) this.lastSeq.set(topicDeviceId, { boot: m.boot, seq: m.seq });
    this._purgeSeen();
    return { ok: true, msg: m, warnings };
  }
}

module.exports = { Guard };
