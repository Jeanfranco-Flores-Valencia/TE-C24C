#!/usr/bin/env bash
# Verificación del firmware en el PC (sin ESP32): compila main.cpp con stubs de
# Arduino/WiFi/MQTT/DHT y OpenSSL en lugar de mbedtls, y comprueba que el
# servidor Node.js acepta lo que firma el firmware y viceversa.
# Requisitos: g++, libssl-dev, Node.js y "npm install" hecho en /server.
set -e
cd "$(dirname "$0")"
g++ -std=c++17 -Wall -Wno-deprecated-declarations -I stubs harness.cpp -o harness -lcrypto
node cross.js ./harness
