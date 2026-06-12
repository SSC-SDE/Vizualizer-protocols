// Scenario triggers + the ambient traffic generator that keeps the wire alive.

import { Host } from './engine.js';
import { TcpConnection } from './tcp.js';
import { DnsTransaction, MediaStream } from './udp.js';
import { ArpExchange, PingFlow, TracerouteFlow } from './l2l3.js';

function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

const MAX_AMBIENT_FLOWS = 26;      // decongestion: cap concurrent ambient flows

// [flow label, human activity bubble] — the bubble always matches the real traffic
const WEB_ACTIVITIES = [
  ['page load', '🌐 doomscrolling reddit'],
  ['page load', '📰 reading hacker news'],
  ['page load', '🎮 downloading game patch'],
  ['API call', '💬 sending discord message'],
  ['API call', '📈 refreshing stock app'],
  ['API call', '🤖 asking claude something'],
  ['asset fetch', '🛒 browsing amazon'],
  ['asset fetch', '📱 scrolling instagram'],
  ['asset fetch', '🗺 loading google maps'],
  ['upload sync', '📤 uploading youtube video'],
  ['upload sync', '☁️ backing up photos'],
  ['upload sync', '📦 pushing to github'],
  ['page load', '🍕 ordering pizza online'],
  ['page load', '🧦 panic-buying socks at 2am'],
  ['page load', '📚 wikipedia rabbit hole'],
  ['API call', '🌦 checking weather (again)'],
  ['API call', '🏦 anxiously checking bank app'],
  ['API call', '💘 swiping on dating app'],
  ['asset fetch', '🐱 loading cat pictures'],
  ['asset fetch', '🍳 finding a recipe, skipping the life story'],
  ['upload sync', '🤳 posting gym selfie'],
];

const STREAM_ACTIVITIES = [
  '📺 streaming twitch',
  '🎬 binge-watching netflix',
  '🎵 spotify on shuffle',
  '📹 stuck in a zoom call',
  '🎥 watching youtube live',
  '🕹 cloud gaming session',
  '🎙 podcast at 2x speed',
  '🧘 streaming a meditation app, stressfully',
  '😱 "you still watching?" ...yes',
  '🐢 4K stream on hotel wifi',
];

const PING_ACTIVITIES = [
  '🏓 checking game ping',
  '📶 testing the connection',
  '🩺 is the server alive?',
  '😤 blaming lag, not skill',
  '🔌 wiggling the ethernet cable',
];

// witty IT jokes, per machine — color matches each server's hue
const SERVER_QUIPS = [
  ['web', 0x00ccff, [
    '🔁 have you tried turning it off and on again?',
    '🤷 works on my machine',
    '🐛 it’s not a bug, it’s a feature',
    '🔥 99 little bugs in the code…',
    '🫖 418: I’m a teapot',
    '📜 my logs are write-only',
    '🧯 prod is just staging with confidence',
  ]],
  ['dns', 0xcc66ff, [
    '☝️ it’s ALWAYS DNS',
    '🧹 have you tried flushing the cache?',
    '🤥 TTL stands for Time To Lie',
    '🌀 I’m not lost, I’m recursive',
    '🔮 I know where everyone lives',
    '⏳ propagation takes 24-48 hours (it doesn’t)',
  ]],
  ['media', 0xff66cc, [
    '⏳ buffering builds character',
    '🧠 lag is a state of mind',
    '🎞 I stream, therefore I am',
    '😅 jitter? I barely know her',
    '🔇 "you’re on mute" — me, all day',
    '🐌 240p: the cinematic experience',
  ]],
  ['router', 0xffcc44, [
    '🧭 I route, therefore I am',
    '📦 all your packets are belong to us',
    '🚌 hop on, hop off',
    '🪦 TTL hit zero? not my problem',
    '👑 default gateway, premium attitude',
    '🚦 dropping packets is self-care',
  ]],
];

export class TrafficDirector {
  constructor(engine, topo) {
    this.engine = engine;
    this.topo = topo;              // {web, dns, media, router, clients[]}
    this.ambient = 2;              // 0..10 density
    this._acc = 0;
    this.onSpawnBot = null;        // gfx hook for temporary flood bots
    this.onActivity = null;        // gfx hook: (host, text, color) → speech bubble
    this.arpCache = new Set();     // host ids that already resolved the gateway MAC
    this._quipIn = 4 + Math.random() * 4;   // countdown to next server joke
    this._lastQuip = new Map();    // server key -> last joke index (no repeats)
  }

  announce(host, text, color) {
    this.onActivity?.(host, text, color);
  }

  reset() {
    this.arpCache.clear();
    this._acc = 0;
    clearSimTimers();
  }

  /** Resolve gateway MAC first (once per host), then run the flow. Real stacks do exactly this. */
  ensureArp(host, then) {
    const gw = this.topo.router;
    if (!gw || this.arpCache.has(host.id)) { then(); return; }
    this.arpCache.add(host.id);
    const arp = new ArpExchange(this.engine, host, gw, then);
    this.engine.addFlow(arp);
    arp.open();
  }

  // ---------- scenarios ----------

  handshake() {
    // single slow connection — small payload so the 3-way + teardown reads clearly
    const c = pick(this.topo.clients);
    const conn = new TcpConnection(this.engine, c, this.topo.web, {
      bytes: 6 * 1460, label: 'handshake demo', dport: 80,
    });
    this.engine.addFlow(conn);
    this.ensureArp(c, () => conn.open());
    this.announce(c, '🤝 opening a connection', 0x00ff88);
    this.engine.log('— scenario: 3-way handshake → 6 segments → FIN teardown', 'ok');
    return conn;
  }

  download() {
    const c = pick(this.topo.clients);
    const conn = new TcpConnection(this.engine, c, this.topo.web, {
      bytes: (300 + ((Math.random() * 900) | 0)) * 1024, label: 'large download', dport: 443,
    });
    this.engine.addFlow(conn);
    this.ensureArp(c, () => conn.open());
    this.announce(c, '📦 downloading a big file', 0x00ccff);
    this.engine.log('— scenario: bulk transfer — watch slow start open the window', 'ok');
    return conn;
  }

  ping() {
    const c = pick(this.topo.clients);
    const target = pick([this.topo.web, this.topo.media, this.topo.dns]);
    const flow = new PingFlow(this.engine, c, target);
    this.engine.addFlow(flow);
    this.ensureArp(c, () => flow.open());
    this.announce(c, pick(PING_ACTIVITIES), 0xfafafa);
    this.engine.log('— scenario: ICMP echo — L3 ping, RTT per reply', 'ok');
    return flow;
  }

  traceroute() {
    const c = pick(this.topo.clients);
    const flow = new TracerouteFlow(this.engine, c, this.topo.web, this.topo.router);
    this.engine.addFlow(flow);
    this.ensureArp(c, () => flow.open());
    this.announce(c, '🗺 tracing the route', 0xff8866);
    this.engine.log('— scenario: traceroute — TTL=1 dies at router (time-exceeded), TTL=2 lands (port-unreachable)', 'ok');
    return flow;
  }

  arpSweep() {
    this.arpCache.clear();
    this.topo.clients.forEach((c, i) => {
      setTimeoutSim(this.engine, i * 0.35, () => {
        this.arpCache.add(c.id);
        const arp = new ArpExchange(this.engine, c, this.topo.router);
        this.engine.addFlow(arp);
        arp.open();
      });
    });
    this.engine.log('— scenario: gratuitous ARP sweep — every client re-learns the gateway MAC (L2 broadcast)', 'ok');
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
      setTimeoutSim(this.engine, Math.random() * 2.5, () => {
        this.announce(c, `🔍 resolving ${tx.domain}`, 0xcc66ff);
        this.ensureArp(c, () => tx.open());
      });
    }
    this.engine.log(`— scenario: ${count} parallel DNS lookups (UDP/53, retry on timeout)`, 'ok');
  }

  stream() {
    const c = pick(this.topo.clients);
    const activity = pick(STREAM_ACTIVITIES);
    const s = new MediaStream(this.engine, this.topo.media, c, {
      rate: 14, duration: 25, label: activity.replace(/^\S+\s/, ''),
    });
    this.engine.addFlow(s);
    s.open();
    this.announce(c, activity, 0xff66cc);
    return s;
  }

  // ---------- ambient ----------

  update(dt) {
    runSimTimers(this.engine);   // flush deferred scenario timers regardless of density
    this._quipTick(dt);          // servers crack jokes even when traffic is paused
    if (this.ambient <= 0) return;
    // expected spawns/sec scales with density
    this._acc += dt * (this.ambient * 0.14);
    while (this._acc >= 1) {
      this._acc -= 1;
      this._spawnRandom();
    }
  }

  _quipTick(dt) {
    this._quipIn -= dt;
    if (this._quipIn > 0) return;
    this._quipIn = 9 + Math.random() * 9;
    const [key, color, jokes] = pick(SERVER_QUIPS);
    let idx = (Math.random() * jokes.length) | 0;
    if (idx === this._lastQuip.get(key)) idx = (idx + 1) % jokes.length;
    this._lastQuip.set(key, idx);
    this.announce(this.topo[key], jokes[idx], color);
  }

  _spawnRandom() {
    if (this.engine.flows.length >= MAX_AMBIENT_FLOWS) return;   // keep the airspace readable
    const r = Math.random();
    const c = pick(this.topo.clients);
    if (r < 0.45) {
      const [label, activity] = pick(WEB_ACTIVITIES);
      const conn = new TcpConnection(this.engine, c, this.topo.web, {
        bytes: (20 + ((Math.random() * 400) | 0)) * 1024,
        label,
        dport: pick([80, 443, 443, 8080]),
      });
      this.engine.addFlow(conn);
      this.ensureArp(c, () => conn.open());
      this.announce(c, activity, 0x00ccff);
    } else if (r < 0.72) {
      const tx = new DnsTransaction(this.engine, c, this.topo.dns);
      this.engine.addFlow(tx);
      this.ensureArp(c, () => tx.open());
      this.announce(c, `🔍 resolving ${tx.domain}`, 0xcc66ff);
    } else if (r < 0.84) {
      const flow = new PingFlow(this.engine, c, pick([this.topo.web, this.topo.media]), { count: 3 });
      this.engine.addFlow(flow);
      this.ensureArp(c, () => flow.open());
      this.announce(c, pick(PING_ACTIVITIES), 0xfafafa);
    } else {
      const activity = pick(STREAM_ACTIVITIES);
      const s = new MediaStream(this.engine, this.topo.media, c, {
        rate: 8 + ((Math.random() * 10) | 0),
        duration: 8 + Math.random() * 14,
        label: activity.replace(/^\S+\s/, ''),
      });
      this.engine.addFlow(s);
      s.open();
      this.announce(c, activity, 0xff66cc);
    }
  }
}

// ---------- tiny sim-time timer helper ----------
const timers = [];
function setTimeoutSim(engine, delay, fn) {
  timers.push({ at: engine.time + delay, fn });
}
export function clearSimTimers() { timers.length = 0; }
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
