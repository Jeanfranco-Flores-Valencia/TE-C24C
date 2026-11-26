#pragma once
#include <vector>
#include <functional>
struct PubSubClient {
  std::vector<std::pair<std::string,std::string>> out; bool conn=true;
  PubSubClient(WiFiClient&){}
  bool publish(const char*t,const char*p){ out.push_back({t,p}); return true; }
  bool connected(){return conn;} bool connect(const char*){return true;} bool connect(const char*,const char*,const char*){return true;}
  void subscribe(const char*,int){} void setServer(const char*,int){} void setBufferSize(int){} void setKeepAlive(int){}
  void setCallback(void(*)(char*,byte*,unsigned int)){} int state(){return 0;} void loop(){}
};
