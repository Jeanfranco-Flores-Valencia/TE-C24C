/*
 * Laboratorio 14 - Comunicación integral con IoT (ESP32 + DHT22 + LED)
 * Wokwi + PlatformIO + MQTT + servidor Node.js + MongoDB Atlas
 *
 * El ESP32 NO conoce las credenciales de MongoDB: solo publica por MQTT
 * mensajes firmados con HMAC-SHA256 (clave propia del dispositivo). El
 * servidor verifica la firma, la frescura y la unicidad antes de guardar.
 *
 * Tópicos (TOPIC_BASE/DEVICE_ID/...):
 *   telemetry  ESP32 -> servidor   lecturas firmadas
 *   audit      ESP32 -> servidor   ACK de comandos y eventos de seguridad firmados
 *   cmd        servidor -> ESP32   comandos firmados (LED on/off)
 */
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <time.h>
#include "mbedtls/md.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#warning "No existe include/secrets.h: se usan valores de ejemplo. Ejecute 'npm run gen-secrets' en /server"
#include "secrets.example.h"
#endif

// ---------------- Hardware ----------------
#define PIN_DHT 15
#define PIN_LED 2
#define DHTTYPE DHT22

// ---------------- Parámetros ----------------
static const uint32_t TELEMETRY_MS = 5000;
static const long REPLAY_WINDOW_S = 30;
static const int CMD_RING = 32;
static const int CMD_MAX_10S = 5;

DHT dht(PIN_DHT, DHTTYPE);
WiFiClient net;
PubSubClient mqtt(net);

char bootId[9];
uint32_t seqNo = 0;
bool ledOn = false;
bool announced = false;
uint32_t lastTel = 0;
char topicTel[96], topicAud[96], topicCmd[96];

char seenCmd[CMD_RING][33];
int seenIdx = 0;
uint32_t cmdTimes[CMD_MAX_10S + 1];
int cmdCount = 0;

// ---------------- Criptografía ----------------
void hmacHex(const char *msg, char out[65]) {
  uint8_t mac[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, (const uint8_t *)DEVICE_HMAC_KEY, strlen(DEVICE_HMAC_KEY),
                  (const uint8_t *)msg, strlen(msg), mac);
  for (int i = 0; i < 32; i++) sprintf(out + i * 2, "%02x", mac[i]);
  out[64] = '\0';
}

// Comparación en tiempo constante (no se corta en el primer byte distinto)
bool safeEqual(const char *a, const char *b) {
  if (strlen(a) != 64 || strlen(b) != 64) return false;
  uint8_t diff = 0;
  for (int i = 0; i < 64; i++) diff |= (uint8_t)(tolower(a[i]) ^ tolower(b[i]));
  return diff == 0;
}

long long nowS() { return (long long)time(nullptr); }

// Texto seguro para la cadena canónica (sin '|' ni comillas, máx 32)
void sanitize(const char *in, char *out, size_t n) {
  size_t j = 0;
  for (size_t i = 0; in && in[i] && j < n - 1; i++) {
    char c = in[i];
    if (isalnum((unsigned char)c) || c == '_' || c == '-') out[j++] = c;
  }
  out[j] = '\0';
}

// ---------------- Publicaciones firmadas ----------------
void publishAudit(const char *event, const char *ref, const char *detail) {
  if (!mqtt.connected()) return;
  char r[33], d[65];
  sanitize(ref, r, sizeof r);
  sanitize(detail, d, sizeof d);
  uint32_t s = seqNo++;
  long long ts = nowS();
  char canon[200], sig[65], json[400];
  snprintf(canon, sizeof canon, "A|%s|%s|%lu|%lld|%s|%s|%s", DEVICE_ID, bootId, (unsigned long)s, ts, event, r, d);
  hmacHex(canon, sig);
  snprintf(json, sizeof json,
           "{\"deviceId\":\"%s\",\"boot\":\"%s\",\"seq\":%lu,\"ts\":%lld,\"event\":\"%s\",\"ref\":\"%s\",\"detail\":\"%s\",\"sig\":\"%s\"}",
           DEVICE_ID, bootId, (unsigned long)s, ts, event, r, d, sig);
  mqtt.publish(topicAud, json);
  Serial.printf("[AUDIT] %s ref=%s %s\n", event, r, d);
}

void publishTelemetry() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) {
    publishAudit("SENSOR_ERROR", "", "lectura_dht22_invalida");
    return;
  }
  // Redondeo a 1 decimal; el JSON lleva exactamente el mismo texto que se firma
  char ts1[16], hs1[16];
  snprintf(ts1, sizeof ts1, "%.1f", t);
  snprintf(hs1, sizeof hs1, "%.1f", h);
  if (strcmp(ts1, "-0.0") == 0) strcpy(ts1, "0.0");

  uint32_t s = seqNo++;
  long long ts = nowS();
  char canon[160], sig[65], json[320];
  snprintf(canon, sizeof canon, "T|%s|%s|%lu|%lld|%s|%s|%d", DEVICE_ID, bootId, (unsigned long)s, ts, ts1, hs1, ledOn ? 1 : 0);
  hmacHex(canon, sig);
  snprintf(json, sizeof json,
           "{\"deviceId\":\"%s\",\"boot\":\"%s\",\"seq\":%lu,\"ts\":%lld,\"temp\":%s,\"hum\":%s,\"led\":%s,\"sig\":\"%s\"}",
           DEVICE_ID, bootId, (unsigned long)s, ts, ts1, hs1, ledOn ? "true" : "false", sig);
  bool ok = mqtt.publish(topicTel, json);
  Serial.printf("[TEL] T=%s C  H=%s %%  LED=%d  seq=%lu  %s\n", ts1, hs1, ledOn, (unsigned long)s, ok ? "enviado" : "ERROR");
}

// ---------------- Comandos recibidos ----------------
bool cmdSeen(const char *id) {
  for (int i = 0; i < CMD_RING; i++) if (strcmp(seenCmd[i], id) == 0) return true;
  return false;
}

bool cmdFlood() {
  uint32_t now = millis();
  int j = 0;
  for (int i = 0; i < cmdCount; i++) if (now - cmdTimes[i] < 10000) cmdTimes[j++] = cmdTimes[i];
  cmdCount = j;
  if (cmdCount < CMD_MAX_10S + 1) cmdTimes[cmdCount++] = now;
  return cmdCount > CMD_MAX_10S;
}

void onMessage(char *topic, byte *payload, unsigned int len) {
  if (strcmp(topic, topicCmd) != 0) return;
  if (len > 400) { publishAudit("CMD_RECHAZADO", "", "payload_grande"); return; }

  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) { publishAudit("CMD_RECHAZADO", "", "json_invalido"); return; }

  const char *dev = doc["deviceId"] | "";
  const char *cmdId = doc["cmdId"] | "";
  const char *action = doc["action"] | "";
  const char *value = doc["value"] | "";
  const char *sig = doc["sig"] | "";
  long long ts = doc["ts"] | 0LL;
  char ref[33];
  sanitize(cmdId, ref, sizeof ref);

  if (cmdFlood()) { publishAudit("ABUSO_CMD", ref, "mas_de_5_cmd_en_10s"); return; }
  if (strcmp(dev, DEVICE_ID) != 0 || strcmp(action, "led") != 0 ||
      (strcmp(value, "on") != 0 && strcmp(value, "off") != 0) || strlen(cmdId) == 0 ||
      strlen(cmdId) > 32 || strcmp(ref, cmdId) != 0 || ts == 0) {
    publishAudit("CMD_RECHAZADO", ref, "esquema");
    return;
  }
  // 1) Autenticidad e integridad
  char canon[160], expected[65];
  snprintf(canon, sizeof canon, "C|%s|%s|%lld|%s|%s", dev, cmdId, ts, action, value);
  hmacHex(canon, expected);
  if (!safeEqual(expected, sig)) { publishAudit("CMD_RECHAZADO", ref, "hmac_invalido"); return; }
  // 2) Frescura
  long long skew = llabs(nowS() - ts);
  if (skew > REPLAY_WINDOW_S) { publishAudit("CMD_RECHAZADO", ref, "ts_fuera_de_ventana"); return; }
  // 3) Unicidad (anti-repetición)
  if (cmdSeen(cmdId)) { publishAudit("CMD_RECHAZADO", ref, "replay"); return; }
  strncpy(seenCmd[seenIdx], cmdId, 32);
  seenCmd[seenIdx][32] = '\0';
  seenIdx = (seenIdx + 1) % CMD_RING;

  ledOn = strcmp(value, "on") == 0;
  digitalWrite(PIN_LED, ledOn ? HIGH : LOW);
  char det[16];
  snprintf(det, sizeof det, "led_%s", value);
  publishAudit("CMD_OK", ref, det);
  publishTelemetry();  // estado actualizado inmediatamente
}

// ---------------- Conectividad ----------------
void connectWiFi() {
  Serial.printf("Conectando a WiFi %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);  // canal 6 acelera la conexión en Wokwi
  while (WiFi.status() != WL_CONNECTED) { delay(250); Serial.print("."); }
  Serial.printf("\nWiFi OK, IP %s\n", WiFi.localIP().toString().c_str());
}

void syncTime() {
  // La hora es necesaria para el anti-repetición (ventana de 30 s)
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  Serial.print("Sincronizando hora NTP");
  while (nowS() < 1700000000LL) { delay(300); Serial.print("."); }
  Serial.printf("\nHora UTC epoch: %lld\n", nowS());
}

void connectMqtt() {
  char clientId[48];
  snprintf(clientId, sizeof clientId, "%s-%s", DEVICE_ID, bootId);
  while (!mqtt.connected()) {
    Serial.printf("Conectando a MQTT %s:%d ... ", MQTT_HOST, MQTT_PORT);
    bool ok = strlen(MQTT_USER) ? mqtt.connect(clientId, MQTT_USER, MQTT_PASS) : mqtt.connect(clientId);
    if (ok) {
      Serial.println("OK");
      mqtt.subscribe(topicCmd, 1);
      if (!announced) { publishAudit("ARRANQUE", "", "firmware_lab14"); announced = true; }
      else publishAudit("RECONEXION", "", "mqtt");
    } else {
      Serial.printf("fallo rc=%d, reintento en 2 s\n", mqtt.state());
      delay(2000);
    }
  }
}

void selfTest() {
  // Vector de prueba compartido con server/test/seguridad.test.js
  uint8_t mac[32];
  const char *m = "T|esp32-01|0000abcd|7|1700000000|23.4|51.0|1";
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), (const uint8_t *)"clave", 5, (const uint8_t *)m, strlen(m), mac);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", mac[i]);
  Serial.printf("SELFTEST HMAC %s -> %s\n",
                strcmp(hex, "c885b1c4ccb31ff5c0eba91b9c7e1514e316e35e0a12937a2bc3711dca33a008") == 0 ? "OK" : "FALLO", hex);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== Lab 14: ESP32 + DHT22 + MQTT firmado (HMAC) ===");
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);
  dht.begin();
  memset(seenCmd, 0, sizeof seenCmd);
  snprintf(bootId, sizeof bootId, "%08lx", (unsigned long)esp_random());
  snprintf(topicTel, sizeof topicTel, "%s/%s/telemetry", TOPIC_BASE, DEVICE_ID);
  snprintf(topicAud, sizeof topicAud, "%s/%s/audit", TOPIC_BASE, DEVICE_ID);
  snprintf(topicCmd, sizeof topicCmd, "%s/%s/cmd", TOPIC_BASE, DEVICE_ID);
  Serial.printf("Dispositivo %s  boot=%s\nTópico base: %s/%s\n", DEVICE_ID, bootId, TOPIC_BASE, DEVICE_ID);
  selfTest();

  connectWiFi();
  syncTime();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(30);
  mqtt.setCallback(onMessage);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();
  if (millis() - lastTel >= TELEMETRY_MS) {
    lastTel = millis();
    publishTelemetry();
  }
}
