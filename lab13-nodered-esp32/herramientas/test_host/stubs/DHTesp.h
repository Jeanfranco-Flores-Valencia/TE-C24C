#pragma once
struct TempAndHumidity { float temperature; float humidity; };
extern float g_t, g_h;
struct DHTesp { enum Model { DHT22 = 22 }; void setup(int, Model) {} TempAndHumidity getTempAndHumidity() { return { g_t, g_h }; } };
