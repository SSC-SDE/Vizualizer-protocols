// WIREDEPTH — boot, topology, wiring, render loop.

import * as THREE from 'three';
import { Engine, Host, KIND } from './sim/engine.js';
import { TrafficDirector } from './sim/scenarios.js';
import { World } from './gfx/world.js';
import { PacketLayer } from './gfx/packets.js';
import { Hud } from './ui/hud.js';
import { Inspector } from './ui/inspector.js';

// ---------------- topology ----------------

const engine = new Engine();

const web = engine.addHost(new Host('WEB-EDGE', '203.0.113.10', 'server', { x: 0, y: 5, z: -2 }));
const dns = engine.addHost(new Host('DNS-CORE', '203.0.113.53', 'server', { x: -8.5, y: 3.6, z: 4 }));
const media = engine.addHost(new Host('MEDIA-RELAY', '203.0.113.77', 'server', { x: 8.5, y: 4.2, z: 4 }));

const clients = [];
const N_CLIENTS = 10;
for (let i = 0; i < N_CLIENTS; i++) {
  const a = (i / N_CLIENTS) * Math.PI * 2;
  const r = 27 + (i % 3) * 3;
  clients.push(engine.addHost(new Host(
    `client-${String(i + 1).padStart(2, '0')}`,
    `10.0.0.${i + 11}`,
    'client',
    { x: Math.cos(a) * r, y: 1.6 + (i % 4) * 1.1, z: Math.sin(a) * r },
  )));
}

const director = new TrafficDirector(engine, { web, dns, media, clients });

// ---------------- scene ----------------

const world = new World(document.getElementById('app'));
world.addServer(web, 0x00ccff);
world.addServer(dns, 0xcc66ff);
world.addServer(media, 0xff66cc);
const clientHues = [0x41a6ff, 0x44ddcc, 0x6688ff];
clients.forEach((c, i) => world.addClient(c, clientHues[i % clientHues.length]));

const packets = new PacketLayer(world.scene);
world.setPacketLayer(packets);

const hud = new Hud(engine);
const inspector = new Inspector(engine);

// sim → gfx wiring
engine.onSend = (pkt) => { packets.onSend(pkt); world.pulseHost(pkt.src, 0.5); };
engine.onDeliver = (pkt) => { packets.onDeliver(pkt); world.pulseHost(pkt.dst, 0.7); };
engine.onDrop = (pkt) => packets.onDrop(pkt);

world.onPickPacket = (pkt) => inspector.showPacket(pkt);
world.onPickHost = (host) => inspector.showHost(host);

director.onSpawnBot = (bot) => world.addBot(bot);

// sweep dead flood bots out of the scene
setInterval(() => {
  const inUse = new Set();
  for (const f of engine.flows) { inUse.add(f.client.id); inUse.add(f.server.id); }
  engine.hosts = engine.hosts.filter(h => {
    if (h.kind === 'bot' && !inUse.has(h.id)) { world.removeHost(h); return false; }
    return true;
  });
}, 2000);

// ---------------- controls ----------------

let paused = false;
let timeScale = 1;

const $ = (id) => document.getElementById(id);

$('btn-pause').onclick = togglePause;
function togglePause() {
  paused = !paused;
  $('btn-pause').textContent = paused ? '▶ resume' : '⏸ pause';
  $('btn-pause').classList.toggle('active', paused);
}

$('sl-speed').oninput = (e) => {
  timeScale = Number(e.target.value);
  $('sl-speed-v').textContent = timeScale.toFixed(1) + '×';
};
$('sl-loss').oninput = (e) => {
  engine.lossRate = Number(e.target.value) / 100;
  $('sl-loss-v').textContent = e.target.value + '%';
};
$('sl-ambient').oninput = (e) => {
  director.ambient = Number(e.target.value);
  $('sl-ambient-v').textContent = e.target.value;
};

const scenarios = {
  handshake: () => inspector.selectFlow(director.handshake()),
  download: () => inspector.selectFlow(director.download()),
  lossburst: () => director.lossBurst(),
  synflood: () => director.synFlood(),
  dnsstorm: () => director.dnsStorm(),
  stream: () => inspector.selectFlow(director.stream()),
};
document.querySelectorAll('[data-scn]').forEach(btn => {
  btn.onclick = () => scenarios[btn.dataset.scn]();
});
const keyMap = ['handshake', 'download', 'lossburst', 'synflood', 'dnsstorm', 'stream'];
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  const i = Number(e.key) - 1;
  if (i >= 0 && i < keyMap.length) scenarios[keyMap[i]]();
});

// ---------------- loop ----------------

const clock = new THREE.Clock();
engine.log('⏚ WIREDEPTH online — 1-6 fire scenarios, click any packet mid-flight', 'ok');
engine.log('ambient traffic warming up…', '');

// ?scn=handshake|download|lossburst|synflood|dnsstorm|stream — autostart for demos
const scnParam = new URLSearchParams(location.search).get('scn');
if (scnParam && scenarios[scnParam]) setTimeout(() => scenarios[scnParam](), 800);

function frame() {
  requestAnimationFrame(frame);
  const dtReal = Math.min(clock.getDelta(), 0.1);
  if (!paused) {
    const dt = dtReal * timeScale;
    engine.update(dt);
    director.update(dt);
  }
  packets.update(engine.time, paused ? 0 : dtReal * timeScale);
  world.update(dtReal);
  hud.update();
  inspector.tick();
  world.render();
}
frame();
