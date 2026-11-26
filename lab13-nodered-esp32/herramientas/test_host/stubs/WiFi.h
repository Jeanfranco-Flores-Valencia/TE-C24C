#pragma once
#define WL_CONNECTED 3
#define WIFI_STA 1
struct WiFiC { void mode(int){} void begin(const char*, const char*, int){} int status(){ return WL_CONNECTED; } };
extern WiFiC WiFi;
struct WiFiClient {};
