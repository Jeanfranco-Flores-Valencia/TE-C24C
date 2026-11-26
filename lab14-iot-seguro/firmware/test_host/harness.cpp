#include "../src/main.cpp"
int g_led=0; float g_t=23.45f, g_h=51.0f; SerialC Serial; WiFiC WiFi;
int main(int argc,char**argv){
  setup();
  publishTelemetry();
  // argv[1] = comando JSON a inyectar (opcional)
  for(int i=1;i<argc;i++){ onMessage(topicCmd,(byte*)argv[i],strlen(argv[i])); }
  for(auto&p:mqtt.out) printf("PUB %s %s\n",p.first.c_str(),p.second.c_str());
  printf("LED=%d\n",g_led);
}
