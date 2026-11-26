// Laboratorio 13 - Parte A: ESP32 + DHT22 + LED con MQTT y Node-RED
// Código de la guía; solo se reemplazó "tuapellido" por el identificador del estudiante.
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHTesp.h>

const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";
const char* MQTT_HOST = "test.mosquitto.org";
const int MQTT_PORT = 1883;
const char* ID = "floresvalencia";
const int PIN_DHT = 15;
const int PIN_LED = 2;
const unsigned long INTERVALO = 5000;

WiFiClient red;
PubSubClient mqtt(red);
DHTesp dht;

String base;
String topicTelemetria;
String topicComando;
String topicAuditoria;
unsigned long ultimaPublicacion = 0;
uint32_t secuencia = 1;

void publicarAuditoria(const String& evento) {
  mqtt.publish(topicAuditoria.c_str(), evento.c_str());
  Serial.println("[AUDITORÍA] " + evento);
}

void recibir(char* topic, byte* payload, unsigned int length) {
  String mensaje;
  for (unsigned int i = 0; i < length; i++) mensaje += (char)payload[i];
  mensaje.trim();
  mensaje.toUpperCase();
  Serial.printf("[MQTT] Recibido en %s: %s\n", topic, mensaje.c_str());
  if (mensaje == "ON") {
    digitalWrite(PIN_LED, HIGH);
    publicarAuditoria("COMANDO_ACEPTADO:ON");
  } else if (mensaje == "OFF") {
    digitalWrite(PIN_LED, LOW);
    publicarAuditoria("COMANDO_ACEPTADO:OFF");
  } else {
    publicarAuditoria("COMANDO_RECHAZADO:ACCION_INVALIDA");
  }
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
  if (isnan(lectura.temperature) || isnan(lectura.humidity)) return;
  JsonDocument json;
  json["dispositivo"] = ID;
  json["temperatura"] = round(lectura.temperature * 10) / 10.0;
  json["humedad"] = round(lectura.humidity * 10) / 10.0;
  json["led"] = digitalRead(PIN_LED) ? "ON" : "OFF";
  json["secuencia"] = secuencia++;
  json["uptime"] = millis();
  String mensaje;
  serializeJson(json, mensaje);
  mqtt.publish(topicTelemetria.c_str(), mensaje.c_str());
  Serial.println("[TELEMETRÍA] " + mensaje);
}

void setup() {
  Serial.begin(115200);
  delay(800);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);
  dht.setup(PIN_DHT, DHTesp::DHT22);
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
