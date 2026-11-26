#pragma once
#include <map>
// Mini parser de objetos JSON planos (solo para la verificación en host)
struct JVal { std::string s; bool isStr=false; bool present=false;
  const char* operator|(const char* d) const { return present&&isStr? s.c_str(): d; }
  long long operator|(long long d) const { return present&&!isStr? atoll(s.c_str()): d; } };
struct JsonDocument { std::map<std::string,JVal> m; const JVal& operator[](const char*k){ static JVal none; auto it=m.find(k); return it==m.end()?none:it->second; } };
inline int deserializeJson(JsonDocument&d, byte*p, unsigned n){
  std::string s((char*)p,n); size_t i=0; auto ws=[&]{while(i<s.size()&&isspace(s[i]))i++;};
  ws(); if(i>=s.size()||s[i]!='{') return 1; i++;
  while(true){ ws(); if(i<s.size()&&s[i]=='}') return 0; if(i>=s.size()||s[i]!='"') return 1;
    size_t e=s.find('"',i+1); if(e==std::string::npos) return 1; std::string k=s.substr(i+1,e-i-1); i=e+1; ws(); if(s[i]!=':') return 1; i++; ws();
    JVal v; v.present=true; if(s[i]=='"'){ e=s.find('"',i+1); v.s=s.substr(i+1,e-i-1); v.isStr=true; i=e+1; }
    else { size_t st=i; while(i<s.size()&&s[i]!=','&&s[i]!='}') i++; v.s=s.substr(st,i-st); }
    d.m[k]=v; ws(); if(s[i]==','){i++;continue;} if(s[i]=='}') return 0; return 1; } }
