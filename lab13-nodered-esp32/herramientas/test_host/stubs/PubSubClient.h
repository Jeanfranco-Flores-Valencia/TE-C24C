#pragma once
#include <vector>
#include <utility>
// Captura lo publicado para que el arnés lo imprima.
struct PubSubClient {
  std::vector<std::pair<std::string, std::string>> out;
  PubSubClient(WiFiClient&) {}
  bool publish(const char* t, const char* p) { out.push_back({t, p}); return true; }
  bool connected() { return true; }
  bool connect(const char*) { return true; }
  bool subscribe(const char*) { return true; }
  void setServer(const char*, int) {}
  void setBufferSize(int) {}
  void setCallback(void (*)(char*, byte*, unsigned int)) {}
  int state() { return 0; }
  void loop() {}
};
