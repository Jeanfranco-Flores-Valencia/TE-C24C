// PLANTILLA. Copie a secrets.h (o ejecute "npm run gen-secrets" en /server).
// secrets.h está en .gitignore: NUNCA suba claves reales.
// Nota: aquí NO va la cadena de MongoDB; solo el servidor la conoce.
#pragma once
#define WIFI_SSID        "Wokwi-GUEST"
#define WIFI_PASS        ""
#define MQTT_HOST        "broker.hivemq.com"
#define MQTT_PORT        1883
#define MQTT_USER        ""
#define MQTT_PASS        ""
#define TOPIC_BASE       "tecsup/lab14/CAMBIAME"
#define DEVICE_ID        "esp32-01"
#define DEVICE_HMAC_KEY  "REEMPLAZAR_CON_LA_MISMA_CLAVE_DE_DEVICE_KEYS_EN_SERVER_ENV"
