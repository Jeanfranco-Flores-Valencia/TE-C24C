// Prueba cruzada: Node.js firma comandos (igual que Node-RED) y el firmware REAL
// de la Parte B, compilado en el PC, decide si los acepta. Cada tanda es un
// arranque nuevo del ESP32.
const { execFileSync } = require('child_process');
const path = require('path');
const P = require('../protocolo');
const KEY = 'clave-de-prueba-solo-para-test-host-0123456789';   // la de stubs/secrets.h
const on1000 = P.comandoFirmado(KEY, 'ON', 1000);
const tandas = [
  [['ON en texto plano (formato Parte A)', 'ON'],
   ['Comando firmado válido ON (seq 1000)', on1000],
   ['Repetición del mismo comando', on1000],
   ['Firma falsa', { accion: 'OFF', secuencia: 2000, firma: 'f'.repeat(64) }],
   ['Firma de ON reutilizada para OFF', { ...on1000, accion: 'OFF', secuencia: 3000 }]],
  [['Comando firmado válido ON (seq 1000)', on1000],
   ['Firmado, pero con secuencia antigua (500)', P.comandoFirmado(KEY, 'OFF', 500)],
   ['Comando firmado válido OFF (seq 1001)', P.comandoFirmado(KEY, 'OFF', 1001)]],
  Array.from({ length: 7 }, (_, i) => [`Ráfaga: comando válido ${i + 1} de 7`, P.comandoFirmado(KEY, i % 2 ? 'OFF' : 'ON', 5000 + i)]),
];
let autoprueba;
tandas.forEach((casos, t) => {
  const args = casos.map(([, c]) => (typeof c === 'string' ? c : JSON.stringify(c)));
  const out = execFileSync(path.join(__dirname, 'harness_b'), args).toString();
  autoprueba = (out.match(/\[AUTOPRUEBA\] HMAC (\w+)/) || [])[1];
  const aud = out.split('\n').filter((l) => /^PUB \S+\/auditoria /.test(l)).map((l) => l.split(' ')[2]);
  console.log(`\nTanda ${t + 1} (ESP32 recién iniciado)`);
  casos.forEach(([n], i) => console.log(`  ${n.padEnd(42)} -> ${aud[i]}`));
  console.log(`  ${'Estado final'.padEnd(42)} -> ${out.match(/LED=\d/)[0]}`);
  if (t === 0) console.log('  Telemetría publicada:', out.split('\n').filter((l) => l.includes('/telemetria ')).pop().split(' ')[2]);
});
console.log('\nAutoprueba HMAC del firmware:', autoprueba);
