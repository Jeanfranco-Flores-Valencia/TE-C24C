'use strict';
/**
 * Persistencia en MongoDB Atlas. Las credenciales de la BD viven SOLO en el
 * servidor (.env -> MONGODB_URI); el ESP32 nunca las conoce.
 * Si MONGODB_URI está vacío se usa un almacén en memoria (útil para pruebas).
 */
const { MongoClient } = require('mongodb');

class MemoryStore {
  constructor() { this.t = []; this.a = []; this.c = []; this.kind = 'memoria'; }
  async init() {}
  async addTelemetry(d) { this.t.push(d); if (this.t.length > 5000) this.t.shift(); }
  async addAudit(d) { this.a.push(d); if (this.a.length > 5000) this.a.shift(); }
  async addCommand(d) { this.c.push(d); }
  async updateCommand(cmdId, patch) { const x = this.c.find((c) => c.cmdId === cmdId); if (x) Object.assign(x, patch); }
  async recentTelemetry(n) { return this.t.slice(-n); }
  async recentAudit(n) { return this.a.slice(-n).reverse(); }
  async close() {}
}

class MongoStore {
  constructor(uri, dbName) { this.uri = uri; this.dbName = dbName; this.kind = 'MongoDB Atlas'; }
  async init() {
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 10000, appName: 'lab14-iot-seguro' });
    await this.client.connect();
    const db = this.client.db(this.dbName);
    this.tel = db.collection('telemetria');
    this.aud = db.collection('auditoria');
    this.cmd = db.collection('comandos');
    await Promise.all([
      this.tel.createIndex({ deviceId: 1, ts: -1 }),
      this.tel.createIndex({ deviceId: 1, boot: 1, seq: 1 }, { unique: true }), // 2ª barrera anti-repetición
      this.aud.createIndex({ fecha: -1 }),
      this.cmd.createIndex({ cmdId: 1 }, { unique: true }),
    ]);
  }
  async addTelemetry(d) {
    try { await this.tel.insertOne({ ...d }); } catch (e) { if (e.code !== 11000) throw e; }
  }
  async addAudit(d) { await this.aud.insertOne({ ...d }); }
  async addCommand(d) { await this.cmd.insertOne({ ...d }); }
  async updateCommand(cmdId, patch) { await this.cmd.updateOne({ cmdId }, { $set: patch }); }
  async recentTelemetry(n) {
    const rows = await this.tel.find({}, { projection: { _id: 0 } }).sort({ fecha: -1 }).limit(n).toArray();
    return rows.reverse();
  }
  async recentAudit(n) {
    return this.aud.find({}, { projection: { _id: 0 } }).sort({ fecha: -1 }).limit(n).toArray();
  }
  async close() { await this.client?.close(); }
}

function createStore(cfg) {
  return cfg.mongoUri ? new MongoStore(cfg.mongoUri, cfg.mongoDb) : new MemoryStore();
}

module.exports = { createStore, MemoryStore };
