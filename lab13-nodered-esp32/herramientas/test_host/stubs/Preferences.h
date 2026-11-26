#pragma once
#include <map>
// NVS en memoria (solo pruebas)
struct Preferences {
  std::map<std::string, uint64_t> m;
  bool begin(const char*, bool) { return true; }
  uint64_t getULong64(const char* k, uint64_t d) { auto it = m.find(k); return it == m.end() ? d : it->second; }
  size_t putULong64(const char* k, uint64_t v) { m[k] = v; return 8; }
};
