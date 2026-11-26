'use strict';
const { load } = require('./config');
const { createApp } = require('./app');

const cfg = load();
const app = createApp(cfg);
app.start().catch((e) => {
  console.error('No se pudo iniciar el servidor:', e.message);
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { console.log('\nCerrando...'); await app.stop().catch(() => {}); process.exit(0); });
}
