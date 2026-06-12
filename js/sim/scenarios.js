// Scenario triggers + the ambient traffic generator that keeps the wire alive.

import { Host } from './engine.js';
import { TcpConnection } from './tcp.js';
import { DnsTransaction, MediaStream } from './udp.js';

function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

export class TrafficDirector {
  constructor(engine, topo) {
    this.engine = engine;
    this.topo = topo;              // {web, dns, media, clients[]}
    this.ambient = 3;              // 0..10 density
    this._acc = 0;
    this.onSpawnBot = null;        // gfx hook for temporary flood bots
  }

  // ---------- scenarios ----------

  handshake() {
    // single slow connection — small payload so the 3-way + teardown reads clearly
    const c = pick(this.topo.clients);
    const conn = new TcpConnection(this.engine, c, this.topo.web, {
      bytes: 6 * 1460, label: 'handshake demo', dport: 80,
    });
    this.engine.addFlow(conn);
    conn.open();
    this.engine.log('— scenario: 3-way handshake → 6 segments → FIN teardown', 'ok');
    return conn;
  }

  download() {
    const c = pick(this.topo.clients);
    const conn = new TcpConnection(this.engine, c, this.topo.web, {
      bytes: (300 + ((Math.random() * 900) | 0)) * 1024, label: 'large download', dport: 443,
    });
    this.engine.addFlow(conn);
    conn.open();
    this.engine.log('— scenario: bulk transfer — watch slow start open the window', 'ok');
    return conn;
  }

  lossBurst() {
    this.engine.lossBurstUntil = this.engine.time + 6;
    this.engine.lossBurstRate = 0.35;
    this.engine.log('— scenario: 35% loss for 6s — dup ACKs, fast retransmit, RTOs incoming', 'bad');
  }

  synFlood(count = 28) {
    const { web } = this.topo;
    for (let i = 0; i < count; i++) {
      const bot = new Host(
        `bot-${i}`, randSpoofIp(), 'bot',
        botPosition(i, count),
      );
      this.engine.addHost(bot);
      if (this.onSpawnBot) this.onSpawnBot(bot);
      const conn = new TcpConnection(this.engine, bot, web, {
        bytes: 0, label: 'SYN flood', synFloodVictim: true,
      });
      this.engine.addFlow(conn);
      // stagger the SYNs
      setTimeoutSim(this.engine, Math.random() * 3, () => conn.open());
    }
    this.engine.log(`— scenario: ${count} spoofed SYNs — server backlog fills with half-open connections`, 'bad');
  }

  dnsStorm(count = 14) {
    for (let i = 0; i < count; i++) {
      const c = pick(this.topo.clients);
      const tx = new DnsTransaction(this.engine, c, this.topo.dns);
      this.engine.addFlow(tx);
      setTimeoutSim(this.engine, Math.random() * 2.5, () => tx.open());
    }
    this.engine.log(`— scenario: ${count} parallel DNS lookups (UDP/53, retry on timeout)`, 'ok');
  }

  stream() {
    const c = pick(this.topo.clients);
    const s = new MediaStream(this.engine, this.topo.media, c, {
      rate: 14, duration: 25, label: 'video stream',
    });
    this.engine.addFlow(s);
    s.open();
    return s;
  }

  // ---------- ambient ----------

  update(dt) {
    runSimTimers(this.engine);   // flush deferred scenario timers regardless of density
    if (this.ambient <= 0) return;
    // expected spawns/sec scales with density
    this._acc += dt * (this.ambient * 0.14);
    while (this._acc >= 1) {
      this._acc -= 1;
      this._spawnRandom();
    }
  }

  _spawnRandom() {
    const r = Math.random();
    const c = pick(this.topo.clients);
    if (r < 0.5) {
      const conn = new TcpConnection(this.engine, c, this.topo.web, {
        bytes: (20 + ((Math.random() * 400) | 0)) * 1024,
        label: pick(['page load', 'API call', 'asset fetch', 'upload sync']),
        dport: pick([80, 443, 443, 8080]),
      });
      this.engine.addFlow(conn);
      conn.open();
    } else if (r < 0.8) {
      const tx = new DnsTransaction(this.engine, c, this.topo.dns);
      this.engine.addFlow(tx);
      tx.open();
    } else {
      const s = new MediaStream(this.engine, this.topo.media, c, {
        rate: 8 + ((Math.random() * 10) | 0),
        duration: 8 + Math.random() * 14,
      });
      this.engine.addFlow(s);
      s.open();
    }
  }
}

// ---------- tiny sim-time timer helper ----------
const timers = [];
function setTimeoutSim(engine, delay, fn) {
  timers.push({ at: engine.time + delay, fn });
}
function runSimTimers(engine) {
  for (let i = timers.length - 1; i >= 0; i--) {
    if (engine.time >= timers[i].at) {
      const t = timers.splice(i, 1)[0];
      t.fn();
    }
  }
}

function randSpoofIp() {
  return `${(Math.random() * 223 + 1) | 0}.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${(Math.random() * 254 + 1) | 0}`;
}

function botPosition(i, n) {
  const a = (i / n) * Math.PI * 2 + Math.random() * 0.3;
  const r = 40 + Math.random() * 8;
  return { x: Math.cos(a) * r, y: 6 + Math.random() * 10, z: Math.sin(a) * r };
}
