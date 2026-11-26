#pragma once
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <cctype>
#include <cstdlib>
#include <cmath>
#include <string>
#include <chrono>
#include <math.h>
using std::isnan;
typedef uint8_t byte;
#define HIGH 1
#define LOW 0
#define OUTPUT 1
inline uint32_t millis(){ using namespace std::chrono; return (uint32_t)duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count(); }
inline void delay(int){}
inline void pinMode(int,int){}
extern int g_led; inline void digitalWrite(int,int v){ g_led=v; }
inline uint32_t esp_random(){ return 0x0000abcd; }
inline void configTime(int,int,const char*,const char*){}
struct SerialC { void begin(int){} template<class...A> void printf(const char*f,A...a){ ::printf(f,a...);} void print(const char*s){::printf("%s",s);} void println(const char*s=""){::printf("%s\n",s);} };
extern SerialC Serial;
