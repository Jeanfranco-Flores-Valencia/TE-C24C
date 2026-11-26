#!/usr/bin/env bash
# Compila el firmware de la Parte A y de la Parte B en el PC (con stubs de Arduino
# y OpenSSL) y cruza las firmas HMAC con las de Node-RED/Node.js.
# Requisitos: g++, libssl-dev, git, Node.js.
set -e
cd "$(dirname "$0")"
[ -d ArduinoJson ] || git clone -q --depth 1 --branch v7.2.1 https://github.com/bblanchon/ArduinoJson.git ArduinoJson
for p in a b; do
  g++ -std=c++17 -Wall -Wno-deprecated-declarations -Wno-format-truncation -I stubs -I ArduinoJson/src \
      -DFIRMWARE="\"../../parte_$p/src/main.cpp\"" harness.cpp -o harness_$p -lcrypto
done
node cruzado.js
