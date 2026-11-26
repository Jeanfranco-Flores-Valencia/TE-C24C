'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { ws: null, token: null, dev: null, status: null, last: {}, retry: 0 };
  const GAUGE_LEN = Math.PI * 80; // longitud del semicírculo r=80

  // ---------- Gráfico ----------
  let chart = null;
  function initChart() {
    if (!window.Chart) { $('chart').replaceWith(Object.assign(document.createElement('p'), { textContent: 'Chart.js no cargó (sin Internet).' })); return; }
    chart = new Chart($('chart'), {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'Temperatura (°C)', data: [], borderColor: '#f97316', tension: .3, yAxisID: 'y' },
        { label: 'Humedad (%)', data: [], borderColor: '#38bdf8', tension: .3, yAxisID: 'y1' },
      ] },
      options: { animation: false, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        scales: { y: { position: 'left', ticks: { color: '#cbd5e1' } }, y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: { color: '#cbd5e1' } },
          x: { ticks: { color: '#cbd5e1', maxTicksLimit: 8 } } },
        plugins: { legend: { labels: { color: '#e2e8f0' } } } },
    });
  }
  function pushPoint(t) {
    if (!chart) return;
    const d = chart.data;
    d.labels.push(new Date(t.fecha).toLocaleTimeString());
    d.datasets[0].data.push(t.temp); d.datasets[1].data.push(t.hum);
    if (d.labels.length > 60) { d.labels.shift(); d.datasets.forEach((s) => s.data.shift()); }
  }

  // ---------- Widgets ----------
  function gauge(el, v, min, max) {
    const f = Math.max(0, Math.min(1, (v - min) / (max - min)));
    el.style.strokeDasharray = GAUGE_LEN;
    el.style.strokeDashoffset = GAUGE_LEN * (1 - f);
  }
  function showTelemetry(t) {
    state.last[t.deviceId] = t;
    if (t.deviceId !== state.dev) return;
    $('vTemp').textContent = t.temp.toFixed(1); $('vHum').textContent = t.hum.toFixed(1);
    gauge($('gTemp'), t.temp, -40, 80); gauge($('gHum'), t.hum, 0, 100);
    $('sLast').textContent = new Date(t.fecha).toLocaleString();
    $('sSig').textContent = t.firmaVerificada ? '✔ verificada' : '✖';
    setLed(t.led);
  }
  function setLed(on) {
    $('sLed').classList.toggle('on', !!on);
    $('sLedTxt').textContent = on === null || on === undefined ? '--' : on ? 'Encendido' : 'Apagado';
  }
  function pill(id, ok, txt) { const p = $(id); p.className = 'pill ' + (ok ? 'ok' : 'bad'); p.textContent = txt; }
  function showStatus(s) {
    state.status = s;
    pill('pMqtt', s.mqtt, 'MQTT ' + (s.mqtt ? 'conectado' : 'desconectado'));
    pill('pDb', true, 'BD: ' + s.bd);
    const d = s.dispositivos.find((x) => x.deviceId === state.dev);
    if (!d) return;
    pill('pDev', d.online, state.dev + (d.online ? ' en línea' : ' fuera de línea'));
    $('sOnline').textContent = d.online ? '🟢 En línea' : '🔴 Fuera de línea';
    $('sBlk').textContent = d.bloqueado ? '⛔ Sí (abuso)' : 'No';
    if (d.led !== null) setLed(d.led);
    $('bOn').disabled = $('bOff').disabled = !d.online || !s.mqtt;
  }
  function addAudit(a, prepend = true) {
    const tr = document.createElement('tr');
    tr.className = a.nivel;
    for (const v of [new Date(a.fecha).toLocaleString(), a.nivel, a.origen, a.codigo, a.deviceId || '', a.detalle || '']) {
      const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); // textContent: sin XSS
    }
    const tb = $('audit');
    if (prepend) tb.prepend(tr); else tb.appendChild(tr);
    while (tb.rows.length > 200) tb.deleteRow(-1);
  }

  // ---------- WebSocket ----------
  function connect() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    state.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: state.token }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      switch (m.type) {
        case 'auth':
          if (!m.ok) { sessionStorage.removeItem('tok'); $('loginErr').textContent = 'Token inválido'; $('app').hidden = true; $('login').hidden = false; return; }
          state.retry = 0; $('login').hidden = true; $('app').hidden = false; pill('pWs', true, 'WebSocket OK');
          $('devSel').innerHTML = '';
          for (const id of m.devices) $('devSel').append(new Option(id, id));
          state.dev = state.dev || m.devices[0]; $('devSel').value = state.dev;
          break;
        case 'snapshot':
          if (chart) { chart.data.labels = []; chart.data.datasets.forEach((s) => (s.data = [])); }
          for (const t of m.data.telemetria.filter((x) => x.deviceId === state.dev)) { pushPoint(t); showTelemetry(t); }
          chart?.update();
          $('audit').innerHTML = '';
          for (const a of m.data.auditoria) addAudit(a, false);
          break;
        case 'telemetry':
          if (m.data.deviceId === state.dev) { pushPoint(m.data); chart?.update(); }
          showTelemetry(m.data); break;
        case 'status': showStatus(m.data); break;
        case 'audit': addAudit(m.data); break;
        case 'cmd':
          $('cmdMsg').textContent = `Comando ${m.data.cmdId || ''}: ${m.data.estado}${m.data.detalle ? ' — ' + m.data.detalle : ''}`; break;
      }
    };
    ws.onclose = (e) => {
      pill('pWs', false, 'WebSocket desconectado');
      if (e.code === 4003) return;
      setTimeout(connect, Math.min(10000, 1000 * 2 ** state.retry++));
    };
  }

  function sendCmd(value) {
    if (state.ws?.readyState !== 1) return;
    state.ws.send(JSON.stringify({ type: 'cmd', deviceId: state.dev, value }));
    $('cmdMsg').textContent = 'Enviando comando firmado...';
  }

  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.token = $('token').value;
    sessionStorage.setItem('tok', state.token);
    connect();
  });
  $('bOn').onclick = () => sendCmd('on');
  $('bOff').onclick = () => sendCmd('off');
  $('devSel').onchange = (e) => { state.dev = e.target.value; state.ws?.close(); };

  initChart();
  try { state.token = sessionStorage.getItem('tok'); } catch {}
  if (state.token) connect();
})();
