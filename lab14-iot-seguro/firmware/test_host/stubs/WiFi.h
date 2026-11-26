#pragma once
#define WL_CONNECTED 3
#define WIFI_STA 1
struct IP { std::string toString(){ return "10.0.0.2"; } };
struct WiFiC { void mode(int){} void begin(const char*,const char*,int){} int status(){return WL_CONNECTED;} IP localIP(){return IP();} };
extern WiFiC WiFi;
struct WiFiClient {};
