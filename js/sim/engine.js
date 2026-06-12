// Simulation core: hosts, packets in flight, flow scheduling, telemetry.
// Pure simulation — no rendering imports. Time unit: seconds (sim time).

export const KIND = {
  SYN: 'SYN', SYNACK: 'SYN-ACK', ACK: 'ACK', DATA: 'DATA', RETRANS: 'RETRANS',
  FIN: 'FIN', RST: 'RST', REQ: 'REQUEST',
  DNS_Q: 'DNS-QUERY', DNS_R: 'DNS-REPLY', STREAM: 'STREAM',
  ARP_REQ: 'ARP-REQ', ARP_REP: 'ARP-REP',
  ECHO_REQ: 'ECHO-REQ', ECHO_REP: 'ECHO-REP',
  TTL_EXC: 'TTL-EXCEED', UNREACH: 'UNREACHABLE',
  PROBE: 'UDP-PROBE',
};

export const KIND_COLOR = {
  [KIND.SYN]: 0x00ff88,
  [KIND.SYNACK]: 0x00ffcc,
  [KIND.ACK]: 0x3d7bff,
  [KIND.DATA]: 0x00ccff,
  [KIND.RETRANS]: 0xff5500,
  [KIND.FIN]: 0xffaa00,
  [KIND.RST]: 0xff2244,
  [KIND.REQ]: 0xffe066,
  [KIND.DNS_Q]: 0xcc66ff,
  [KIND.DNS_R]: 0x9d7bff,
  [KIND.STREAM]: 0xff66cc,
  [KIND.ARP_REQ]: 0x9dff57,
  [KIND.ARP_REP]: 0x57ff9d,
  [KIND.ECHO_REQ]: 0xfafafa,
  [KIND.ECHO_REP]: 0xbfd8d8,
  [KIND.TTL_EXC]: 0xff8866,
  [KIND.UNREACH]: 0xff4488,
  [KIND.PROBE]: 0xd8c869,
};

export const MSS = 1460;

/** OSI lane a packet flies in. Traceroute probes live with their ICMP replies. */
export function layerOf(pkt) {
  if (pkt.proto === 'ARP') return 'L2';
  if (pkt.proto === 'ICMP' || pkt.kind === KIND.PROBE) return 'L3';
  return pkt.proto === 'TCP' ? 'L4_TCP' : 'L4_UDP';
}

export const LAYER_META = {
  L2: { color: 0x9dff57, name: 'LAYER 2 · LINK', sub: 'Ethernet · ARP' },
  L3: { color: 0xff8866, name: 'LAYER 3 · NETWORK', sub: 'IPv4 · ICMP' },
  L4_UDP: { color: 0xcc66ff, name: 'LAYER 4 · TRANSPORT', sub: 'UDP datagrams' },
  L4_TCP: { color: 0x00ccff, name: 'LAYER 4 · TRANSPORT', sub: 'TCP streams' },
};

let _hostId = 0;
function genMac() {
  // locally administered unicast
  const b = [0x02, 0x42, ...Array.from({ length: 4 }, () => (Math.random() * 256) | 0)];
  return b.map(x => x.toString(16).padStart(2, '0')).join(':');
}

export class Host {
  constructor(name, ip, kind, pos) {
    this.id = _hostId++;
    this.name = name;
    this.ip = ip;
    this.mac = genMac();
    this.kind = kind;          // 'server' | 'client' | 'bot' | 'router'
    this.pos = pos;            // {x,y,z} — engine uses it for latency, gfx for placement
    this.txPackets = 0;
    this.rxPackets = 0;
    this.txBytes = 0;
    this.rxBytes = 0;
  }
}

let _pktId = 0;
export class Packet {
  constructor(o) {
    this.id = _pktId++;
    this.src = o.src;
    this.dst = o.dst;
    this.proto = o.proto;            // 'TCP' | 'UDP' | 'ICMP' | 'ARP'
    this.kind = o.kind;              // KIND.*
    this.flags = o.flags || {};      // {SYN,ACK,FIN,RST,PSH}
    this.seq = o.seq ?? 0;
    this.ackNo = o.ackNo ?? 0;
    this.sport = o.sport ?? 0;
    this.dport = o.dport ?? 0;
    this.len = o.len ?? 0;           // payload bytes
    this.win = o.win ?? 65535;
    this.ttl = o.ttl ?? 64;
    this.note = o.note || '';
    this.flow = o.flow || null;
    // ICMP header fields
    this.icmpType = o.icmpType ?? 0;
    this.icmpCode = o.icmpCode ?? 0;
    this.icmpId = o.icmpId ?? 0;
    this.icmpSeq = o.icmpSeq ?? 0;
    // display overrides (e.g. traceroute probe addressed to server but dying at router)
    this.dstIp = o.dstIp || null;
    this.via = null;                 // router hop, set by engine.send
    this.t0 = 0;
    this.t1 = 0;
    this.lost = false;
    this.lostAt = 0.5;               // fraction of path where it dies
  }
  get totalLen() {
    // Ethernet II (14) + L3/L4 headers + payload
    if (this.proto === 'ARP') return 14 + 28;
    if (this.proto === 'ICMP') return 14 + 20 + 8 + this.len;
    return 14 + 20 + (this.proto === 'TCP' ? 20 : 8) + this.len;
  }
  get flagStr() {
    const f = [];
    for (const k of ['SYN', 'ACK', 'FIN', 'RST', 'PSH']) if (this.flags[k]) f.push(k);
    return f.join(',') || '·';
  }
}

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class Engine {
  constructor() {
    this.time = 0;
    this.hosts = [];
    this.flows = [];
    this.inFlight = [];
    this.lossRate = 0.02;          // global random loss probability
    this.lossBurstUntil = 0;       // scenario: elevated loss window
    this.lossBurstRate = 0;
    this.latencyBase = 0.35;       // s, propagation floor — slow so packets are watchable
    this.latencyPerUnit = 0.022;   // s per world unit of distance
    this.router = null;            // core router: IP traffic hops through it when set
    this.synBacklog = 0;           // server half-open count (SYN flood gauge)
    this.synBacklogMax = 64;

    // observers wired by gfx/ui
    this.onSend = null;            // (pkt) => void
    this.onDeliver = null;         // (pkt) => void
    this.onDrop = null;            // (pkt) => void
    this.onLog = null;             // (text, cls) => void

    // telemetry counters (since start) + per-sample window
    this.counters = { sent: 0, delivered: 0, dropped: 0, retx: 0, bytes: 0, conns: 0 };
    this._win = { delivered: 0, dropped: 0, retx: 0, bytes: 0 };
    this._sampleEvery = 0.25;
    this._nextSample = 0;
    const N = 240;
    this.series = {
      n: N,
      mbps: new Float32Array(N),
      pps: new Float32Array(N),
      dps: new Float32Array(N),
      rps: new Float32Array(N),
      head: 0,
    };
  }

  addHost(h) { this.hosts.push(h); return h; }

  addFlow(f) {
    this.flows.push(f);
    this.counters.conns++;
    return f;
  }

  log(text, cls = '') { if (this.onLog) this.onLog(text, cls); }

  latency(a, b, via = null) {
    const d = via ? dist(a.pos, via.pos) + dist(via.pos, b.pos) : dist(a.pos, b.pos);
    return this.latencyBase + d * this.latencyPerUnit;
  }

  /** IP traffic transits the core router; link-local (ARP) and router-terminated traffic goes direct. */
  routeVia(pkt) {
    if (!this.router || pkt.proto === 'ARP') return null;
    if (pkt.src === this.router || pkt.dst === this.router) return null;
    return this.router;
  }

  effectiveLoss() {
    let p = this.lossRate;
    if (this.time < this.lossBurstUntil) p = Math.max(p, this.lossBurstRate);
    return p;
  }

  /** Put a packet on the wire. Returns the packet. */
  send(pkt, opts = {}) {
    pkt.via = this.routeVia(pkt);
    const lat = this.latency(pkt.src, pkt.dst, pkt.via) * (1 + (Math.random() - 0.5) * 0.12);
    pkt.t0 = this.time;
    pkt.t1 = this.time + lat;
    // links are FIFO queues: jitter must not reorder packets on the same path
    const linkKey = pkt.src.id * 100000 + pkt.dst.id;
    const lastT1 = this._linkLast?.get(linkKey) ?? 0;
    if (pkt.t1 <= lastT1) pkt.t1 = lastT1 + 0.004;
    (this._linkLast ??= new Map()).set(linkKey, pkt.t1);
    if (!opts.noLoss && Math.random() < this.effectiveLoss()) {
      pkt.lost = true;
      pkt.lostAt = 0.3 + Math.random() * 0.45;
    }
    pkt.src.txPackets++;
    pkt.src.txBytes += pkt.totalLen;
    this.inFlight.push(pkt);
    this.counters.sent++;
    if (pkt.kind === KIND.RETRANS) { this.counters.retx++; this._win.retx++; }
    if (this.onSend) this.onSend(pkt);
    return pkt;
  }

  update(dt) {
    this.time += dt;

    // advance flows (senders, timers)
    for (const f of this.flows) f.update(dt);
    this.flows = this.flows.filter(f => !f.dead);

    // deliveries & drops
    const still = [];
    for (const p of this.inFlight) {
      if (p.lost) {
        const tDie = p.t0 + (p.t1 - p.t0) * p.lostAt;
        if (this.time >= tDie) {
          this.counters.dropped++;
          this._win.dropped++;
          if (this.onDrop) this.onDrop(p);
          continue;
        }
        still.push(p);
      } else if (this.time >= p.t1) {
        p.dst.rxPackets++;
        p.dst.rxBytes += p.totalLen;
        this.counters.delivered++;
        this._win.delivered++;
        this.counters.bytes += p.totalLen;
        this._win.bytes += p.totalLen;
        if (this.onDeliver) this.onDeliver(p);
        if (p.flow && !p.flow.dead) p.flow.onPacket(p);
        continue;
      } else {
        still.push(p);
      }
    }
    this.inFlight = still;

    // sample telemetry series
    if (this.time >= this._nextSample) {
      this._nextSample = this.time + this._sampleEvery;
      const s = this.series, inv = 1 / this._sampleEvery;
      s.mbps[s.head] = (this._win.bytes * 8 * inv) / 1e6;
      s.pps[s.head] = this._win.delivered * inv;
      s.dps[s.head] = this._win.dropped * inv;
      s.rps[s.head] = this._win.retx * inv;
      s.head = (s.head + 1) % s.n;
      this._win = { delivered: 0, dropped: 0, retx: 0, bytes: 0 };
    }
  }
}
