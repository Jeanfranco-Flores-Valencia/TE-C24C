// Arnés: compila el main.cpp real del ESP32 en el PC, ejecuta setup(), inyecta
// los comandos recibidos como argumentos y muestra lo que el firmware publica.
#include FIRMWARE
int g_led = 0; float g_t = 24.0f, g_h = 55.0f;
SerialC Serial; WiFiC WiFi; EspC ESP;
int main(int argc, char** argv) {
  setup();
  for (int i = 1; i < argc; i++) recibir((char*)topicComando.c_str(), (byte*)argv[i], strlen(argv[i]));
  g_t = 26.5f; g_h = 61.2f;
  publicarTelemetria();
  for (auto& p : mqtt.out) printf("PUB %s %s\n", p.first.c_str(), p.second.c_str());
  printf("LED=%d\n", g_led);
}
