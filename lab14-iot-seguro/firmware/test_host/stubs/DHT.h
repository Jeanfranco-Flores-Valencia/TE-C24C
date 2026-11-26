#pragma once
#define DHT22 22
extern float g_t, g_h;
struct DHT { DHT(int,int){} void begin(){} float readHumidity(){return g_h;} float readTemperature(){return g_t;} };
