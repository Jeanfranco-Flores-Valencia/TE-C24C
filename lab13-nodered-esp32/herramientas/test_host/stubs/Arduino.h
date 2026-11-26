// Stub mínimo de Arduino para compilar el firmware en el PC (solo pruebas).
#pragma once
#define ARDUINOJSON_ENABLE_ARDUINO_STRING 1
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <cctype>
#include <cstdlib>
#include <cmath>
#include <string>
#include <chrono>
#include <algorithm>
using std::isnan; using std::round;
typedef uint8_t byte;
#define HIGH 1
#define LOW 0
#define OUTPUT 1
#define HEX 16
inline unsigned long millis(){ using namespace std::chrono; static auto t0=steady_clock::now(); return (unsigned long)duration_cast<milliseconds>(steady_clock::now()-t0).count(); }
inline void delay(unsigned long){}
inline void pinMode(int,int){}
extern int g_led;
inline void digitalWrite(int,int v){ g_led=v; }
inline int digitalRead(int){ return g_led; }
inline uint32_t esp_random(){ return 0x1a2b3c4d; }
class String {
  std::string s;
 public:
  String() {}
  String(const char* c) : s(c ? c : "") {}
  String(const std::string& x) : s(x) {}
  String(char c) : s(1, c) {}
  String(int v) : s(std::to_string(v)) {}
  String(unsigned int v) : s(std::to_string(v)) {}
  String(long v) : s(std::to_string(v)) {}
  String(unsigned long v) : s(std::to_string(v)) {}
  String(unsigned long long v) : s(std::to_string(v)) {}
  String(uint32_t v, int base) { char b[16]; snprintf(b, sizeof b, base == 16 ? "%x" : "%u", v); s = b; }
  const char* c_str() const { return s.c_str(); }
  unsigned int length() const { return (unsigned)s.size(); }
  bool concat(const char* c) { s += c; return true; }
  bool concat(const char* c, unsigned n) { s.append(c, n); return true; }
  String& operator+=(const String& o) { s += o.s; return *this; }
  String& operator+=(const char* o) { s += o; return *this; }
  String& operator+=(char c) { s += c; return *this; }
  char operator[](unsigned i) const { return s[i]; }
  bool operator==(const String& o) const { return s == o.s; }
  bool operator==(const char* o) const { return s == o; }
  bool operator!=(const char* o) const { return s != o; }
  void trim() { auto a = s.find_first_not_of(" \t\r\n"); auto b = s.find_last_not_of(" \t\r\n"); s = a == std::string::npos ? "" : s.substr(a, b - a + 1); }
  void toUpperCase() { for (auto& ch : s) ch = toupper(ch); }
  friend String operator+(const String& a, const String& b) { return String(a.s + b.s); }
  friend String operator+(const String& a, const char* b) { return String(a.s + b); }
  friend String operator+(const char* a, const String& b) { return String(std::string(a) + b.s); }
};
struct SerialC {
  void begin(int) {}
  template <class... A> void printf(const char* f, A... a) { ::printf(f, a...); }
  void print(const char* x) { ::printf("%s", x); }
  void println(const char* x = "") { ::printf("%s\n", x); }
  void println(const String& x) { ::printf("%s\n", x.c_str()); }
};
extern SerialC Serial;
struct EspC { uint64_t getEfuseMac() { return 0xA1B2C3D4E5F6ULL; } };
extern EspC ESP;
