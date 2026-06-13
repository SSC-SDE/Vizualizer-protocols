// WIREDEPTH bootstrap: build → wire → loop. The pieces live in:
//   sim/  protocol engine (pure, no rendering)
//   gfx/  Three.js scene + packet tracers
//   ui/   HUD, inspector, tutor
//   app/  topology + control deck

import * as THREE from 'three';
import { Engine, KIND, layerOf } from './sim/engine.js';
import { TrafficDirector } from './sim/scenarios.js';
import { World } from './gfx/world.js';
import { PacketLayer } from './gfx/packets.js';
import { Hud } from './ui/hud.js';
import { Inspector } from './ui/inspector.js';
import { Tutor } from './ui/tutor.js';
import { RolePlayDirector } from './app/roleplay.js';
import { ServerRolePlayDirector } from './app/serverroleplay.js';
import { ActionDeck } from './ui/actiondeck.js';
import { buildNetwork, buildScene } from './app/topology.js';
import { Controls, SCENARIO_KEYS } from './app/controls.js';

// ---------------- build ----------------

const engine = new Engine();
const topo = buildNetwork(engine);
const director = new TrafficDirector(engine, topo);

const world = new World(document.getElementById('app'));
buildScene(world, topo);
const packets = new PacketLayer(world.scene);
world.setPacketLayer(packets);

const hud = new Hud(engine);
const inspector = new Inspector(engine);
const controls = new Controls(engine, director);
const tutor = new Tutor(engine, {
  setPaused: (v) => controls.setPaused(v),
  setSpeed: (v) => controls.setSpeed(v),
  setAmbient: (v) => controls.setAmbient(v),
  getSpeed: () => controls.getSpeed(),
  getAmbient: () => controls.getAmbient(),
});

// ---------------- role-play ("be the client") ----------------

const roleplay = new RolePlayDirector(engine, topo, { controls, world, tutor, inspector });
const serverplay = new ServerRolePlayDirector(engine, topo, { controls, world, inspector });
const announce = (host, text, color, dur) => world.showActivity(host, text, color, dur);
roleplay.onActivity = announce;
serverplay.onActivity = announce;
const deck = new ActionDeck({ client: roleplay, server: serverplay });
const rpPlayer = () => roleplay.active ? roleplay.player : serverplay.active ? serverplay.player : null;
controls.onRoleplay = () => deck.toggle();
controls.onEscape = () => { if (deck.active) deck.toggle(); };
document.getElementById('btn-roleplay').onclick = () => deck.toggle();

// ---------------- wire ----------------

engine.onSend = (pkt) => {
  packets.onSend(pkt);
  world.pulseHost(pkt.src, 0.5);
  if (pkt.kind === KIND.ARP_REQ) world.spawnRipple(pkt.src.pos);   // L2 broadcast hits the segment
  tutor.onSend(pkt);
};
engine.onDeliver = (pkt) => {
  packets.onDeliver(pkt);
  world.pulseHost(pkt.dst, 0.7);
  roleplay.observeDeliver(pkt);
  serverplay.observeDeliver(pkt);
};
engine.onDrop = (pkt) => { packets.onDrop(pkt); tutor.onDrop(pkt); };

world.onPickPacket = (pkt) => {
  // during role-play the inspector stays pinned to your own traffic
  const pl = rpPlayer();
  if (pl && pkt.src !== pl && pkt.dst !== pl) return;
  inspector.showPacket(pkt);
};
world.onPickHost = (host) => { if (deck.active) deck.pickHost(host); else inspector.showHost(host); };
director.onSpawnBot = (bot) => world.addBot(bot);
director.onActivity = (host, text, color) => world.showActivity(host, text, color);

function follow(name, flow) {
  inspector.selectFlow(flow);
  tutor.onScenario(name, flow);
}
controls.tutor = tutor;
controls.scenarios = {
  handshake: () => follow('handshake', director.handshake()),
  download: () => follow('download', director.download()),
  lossburst: () => { director.lossBurst(); tutor.onScenario('lossburst', null); },
  synflood: () => { director.synFlood(); tutor.onScenario('synflood', null); },
  dnsstorm: () => { director.dnsStorm(); },
  stream: () => follow('stream', director.stream()),
  ping: () => follow('ping', director.ping()),
  traceroute: () => follow('traceroute', director.traceroute()),
  arp: () => director.arpSweep(),
};

controls.onReset = () => {
  if (roleplay.active) roleplay.exit();
  if (serverplay.active) serverplay.exit();
  engine.reset();
  director.reset();
  packets.clear();
  world.clearDynamic();
  inspector.reset();
  tutor.onReset();
  engine.log('⟲ reset — topology kept, traffic and telemetry wiped', 'ok');
};

// periodic maintenance: flow ribbons + dead flood-bot sweep
setInterval(() => world.syncFlowArcs(engine.flows, topo.router), 500);
setInterval(() => {
  const inUse = new Set();
  for (const f of engine.flows) { inUse.add(f.client.id); inUse.add(f.server.id); }
  engine.hosts = engine.hosts.filter(h => {
    if (h.kind === 'bot' && !inUse.has(h.id)) { world.removeHost(h); return false; }
    return true;
  });
}, 2000);

// ---------------- loop ----------------

const clock = new THREE.Clock();
const layerCounts = { L2: 0, L3: 0, L4_UDP: 0, L4_TCP: 0 };

engine.log('⏚ WIREDEPTH online — 1-9 fire scenarios, G guide, P role-play, R resets', 'ok');
engine.log('ambient traffic warming up…', '');

function frame() {
  requestAnimationFrame(frame);
  const dtReal = Math.min(clock.getDelta(), 0.1);
  if (!controls.paused) {
    const dt = dtReal * controls.timeScale;
    engine.update(dt);
    director.update(dt);
    roleplay.update(dt);
    serverplay.update(dt);
  }

  // live per-lane occupancy → strata glow + HUD meter
  layerCounts.L2 = layerCounts.L3 = layerCounts.L4_UDP = layerCounts.L4_TCP = 0;
  for (const p of engine.inFlight) layerCounts[layerOf(p)]++;
  for (const k in layerCounts) world.setLayerActivity(k, Math.min(1, layerCounts[k] / 10));
  hud.layerCounts = layerCounts;

  packets.update(engine.time, controls.paused ? 0 : dtReal * controls.timeScale);
  world.update(dtReal);
  hud.update();
  inspector.tick();
  tutor.update(dtReal);
  world.render();
}
frame();

// ?scn=handshake|...&guide=1 — autostart for demos
const params = new URLSearchParams(location.search);
if (params.get('guide')) tutor.enable();
const scnParam = params.get('scn');
if (scnParam && SCENARIO_KEYS.includes(scnParam)) setTimeout(() => controls.fire(scnParam), 800);
if (params.get('mode') === 'roleplay') setTimeout(() => deck.toggle(), 800);
