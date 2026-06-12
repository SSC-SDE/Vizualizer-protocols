// Network topology: the hosts that exist and where they sit, plus their
// 3D representations. One place to grow the network.

import { Host } from '../sim/engine.js';

const N_CLIENTS = 10;
const CLIENT_HUES = [0x41a6ff, 0x44ddcc, 0x6688ff];

export function buildNetwork(engine) {
  const web = engine.addHost(new Host('WEB-EDGE', '203.0.113.10', 'server', { x: 0, y: 5, z: -2 }));
  const dns = engine.addHost(new Host('DNS-CORE', '203.0.113.53', 'server', { x: -8.5, y: 3.6, z: 4 }));
  const media = engine.addHost(new Host('MEDIA-RELAY', '203.0.113.77', 'server', { x: 8.5, y: 4.2, z: 4 }));
  const router = engine.addHost(new Host('CORE-RTR', '10.0.0.1', 'router', { x: 0, y: 13, z: 6 }));
  engine.router = router;            // all IP traffic hops through the core

  const clients = [];
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

  return { web, dns, media, router, clients };
}

export function buildScene(world, topo) {
  world.addServer(topo.web, 0x00ccff);
  world.addServer(topo.dns, 0xcc66ff);
  world.addServer(topo.media, 0xff66cc);
  world.addRouter(topo.router);
  topo.clients.forEach((c, i) => world.addClient(c, CLIENT_HUES[i % CLIENT_HUES.length]));
}
