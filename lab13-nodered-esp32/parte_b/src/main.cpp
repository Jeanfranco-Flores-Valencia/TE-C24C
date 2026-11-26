// Laboratorio 13 - Parte B (reto): comandos firmados con HMAC-SHA256 y antirrepetición
//
// Diferencias con la Parte A:
//  - Los comandos ya no son "ON"/"OFF" en texto plano. Node-RED publica
//      {"accion":"ON","secuencia":1764100000000,"firma":"<hex>"}
//    y la firma es HMAC-SHA256(clave, "accion|secuencia|dispositivo").
//  - El ESP32 solo ejecuta el comando si la firma es correcta Y la secuencia es
//    mayor que la última aceptada (se guarda en NVS para que sobreviva a reinicios).
//  - Limita la frecuencia de comandos (máx. 5 cada 10 s).
//  - La telemetría incluye "arranque" (id aleatorio de cada encendido) para que
//    Node-RED distinga un reinicio legítimo de una repetición.
//  - La clave está en include/secrets.h (no se sube al repositorio).
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHTesp.h>
#include <Preferences.h>
#include "mbedtls/md.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#warning "Falta include/secrets.h: copie secrets.example.h a secrets.h y ponga su clave"
#include "secrets.example.h"
#endif

const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";
const char* MQTT_HOST = "test.mosquitto.org";
const int MQTT_PORT = 1883;
const char* ID = "floresvalencia";
const int PIN_DHT = 15;
const int PIN_LED = 2;
const unsigned long INTERVALO = 5000;
const int MAX_COMANDOS = 5;            // por ventana
const unsigned long VENTANA_MS = 10000;

WiFiClient red;
PubSubClient mqtt(red);
DHTesp dht;
Preferences nvs;

String base, topicTelemetria, topicComando, topicAuditoria;
unsigned long ultimaPublicacion = 0;
uint32_t secuencia = 1;
char arranque[9];
uint64_t ultimaSecuenciaComando = 0;
unsigned long tiemposComando[MAX_COMANDOS];
int nComandos = 0;

// ---------- HMAC-SHA256 ----------
String hmacHex(const String& mensaje) {
  uint8_t mac[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
                  (const uint8_t*)HMAC_KEY, strlen(HMAC_KEY),
                  (const uint8_t*)mensaje.c_str(), mensaje.length(), mac);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", mac[i]);
  hex[64] = '\0';
  return String(hex);
}

// Comparación en tiempo constante: no se detiene en el primer carácter distinto
bool igualesSeguro(const String& a, const String& b) {
  if (a.length() != 64 || b.length() != 64) return false;
  uint8_t diff = 0;
  for (int i = 0; i < 64; i++) diff |= (uint8_t)(tolower(a[i]) ^ tolower(b[i]));
  return diff == 0;
}

void publicarAuditoria(const String& evento) {
  mqtt.publish(topicAuditoria.c_str(), evento.c_str());
  Serial.println("[AUDITORÍA] " + evento);
}

bool excedeFrecuencia() {
  unsigned long ahora = millis();
  int j = 0;
  for (int i = 0; i < nComandos; i++)
    if (ahora - tiemposComando[i] < VENTANA_MS) tiemposComando[j++] = tiemposComando[i];
  nComandos = j;
  if (nComandos >= MAX_COMANDOS) return true;
  tiemposComando[nComandos++] = ahora;
  return false;
}

void recibir(char* topic, byte* payload, unsigned int length) {
  Serial.printf("[MQTT] Recibido en %s (%u bytes)\n", topic, length);
  if (excedeFrecuencia()) { publicarAuditoria("COMANDO_RECHAZADO:FRECUENCIA"); return; }
  if (length > 300) { publicarAuditoria("COMANDO_RECHAZADO:TAMANO"); return; }

  JsonDocument doc;
  if (deserializeJson(doc, payload, length) || !doc.is<JsonObject>()) {
    publicarAuditoria("COMANDO_RECHAZADO:SIN_FIRMA");   // p. ej. "ON" en texto plano
    return;
  }
  String accion = doc["accion"] | "";
  uint64_t sec = doc["secuencia"] | (uint64_t)0;
  String firma = doc["firma"] | "";
  if ((accion != "ON" && accion != "OFF") || sec == 0 || firma.length() == 0) {
    publicarAuditoria("COMANDO_RECHAZADO:FORMATO");
    return;
  }
  // 1) Autenticidad: solo quien conoce la clave puede generar la firma
  String canon = accion + "|" + String(sec) + "|" + ID;
  if (!igualesSeguro(hmacHex(canon), firma)) {
    publicarAuditoria("COMANDO_RECHAZADO:FIRMA_INVALIDA");
    return;
  }
  // 2) Antirrepetición: una firma válida ya usada no se vuelve a aceptar
  if (sec <= ultimaSecuenciaComando) {
    publicarAuditoria("COMANDO_RECHAZADO:REPETIDO:" + String(sec));
    return;
  }
  ultimaSecuenciaComando = sec;
  nvs.putULong64("ultSec", sec);

  digitalWrite(PIN_LED, accion == "ON" ? HIGH : LOW);
  publicarAuditoria("COMANDO_ACEPTADO:" + accion + ":" + String(sec));
}

void conectarWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD, 6);
  Serial.print("Conectando a Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\n[OK] Wi-Fi conectado");
}

void conectarMQTT() {
  while (!mqtt.connected()) {
    String cliente = String("lab13-") + ID + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    Serial.print("Conectando a MQTT...");
    if (mqtt.connect(cliente.c_str())) {
      Serial.println("OK");
      mqtt.subscribe(topicComando.c_str());
      publicarAuditoria("DISPOSITIVO_CONECTADO");
    } else {
      Serial.printf("falló, estado=%d\n", mqtt.state());
      delay(2000);
    }
  }
}

void publicarTelemetria() {
  TempAndHumidity lectura = dht.getTempAndHumidity();
  if (isnan(lectura.temperature) || isnan(lectura.humidity)) {
    publicarAuditoria("SENSOR_ERROR");
    return;
  }
  JsonDocument json;
  json["dispositivo"] = ID;
  json["temperatura"] = round(lectura.temperature * 10) / 10.0;
  json["humedad"] = round(lectura.humidity * 10) / 10.0;
  json["led"] = digitalRead(PIN_LED) ? "ON" : "OFF";
  json["secuencia"] = secuencia++;
  json["arranque"] = arranque;
  json["uptime"] = millis();
  String mensaje;
  serializeJson(json, mensaje);
  mqtt.publish(topicTelemetria.c_str(), mensaje.c_str());
  Serial.println("[TELEMETRÍA] " + mensaje);
}

void autoPrueba() {
  // Vector compartido con herramientas/pruebas.test.js
  const char* esperado = "9311997b";  // primeros 8 hex de HMAC("clave-de-prueba", "ON|1|floresvalencia")
  uint8_t mac[32];
  const char* m = "ON|1|floresvalencia";
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
                  (const uint8_t*)"clave-de-prueba", 15, (const uint8_t*)m, strlen(m), mac);
  char hex[9];
  for (int i = 0; i < 4; i++) sprintf(hex + i * 2, "%02x", mac[i]);
  Serial.printf("[AUTOPRUEBA] HMAC %s\n", strcmp(hex, esperado) == 0 ? "OK" : "FALLO");
}

void setup() {
  Serial.begin(115200);
  delay(800);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);
  dht.setup(PIN_DHT, DHTesp::DHT22);
  snprintf(arranque, sizeof arranque, "%08lx", (unsigned long)esp_random());
  nvs.begin("lab13", false);
  ultimaSecuenciaComando = nvs.getULong64("ultSec", 0);
  Serial.printf("Arranque %s, última secuencia de comando aceptada: %llu\n",
                arranque, (unsigned long long)ultimaSecuenciaComando);
  autoPrueba();

  base = String("tecsup/ii3010/lab13/") + ID;
  topicTelemetria = base + "/telemetria";
  topicComando = base + "/comando";
  topicAuditoria = base + "/auditoria";
  conectarWiFi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(recibir);
  mqtt.setBufferSize(512);
  conectarMQTT();
  publicarTelemetria();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) conectarWiFi();
  if (!mqtt.connected()) conectarMQTT();
  mqtt.loop();
  if (millis() - ultimaPublicacion >= INTERVALO) {
    ultimaPublicacion = millis();
    publicarTelemetria();
  }
  delay(10);
}
