// Layers below transport: ARP (L2 address resolution), ICMP echo (ping),
// and classic UDP-probe traceroute with ICMP TTL-exceeded replies.

import { Packet, KIND } from './engine.js';

// ============================== ARP ==============================
// Broadcast who-has → unicast is-at. Link-local: never crosses the router.

export class ArpExchange {
  constructor(engine, requester, target, onResolved = null) {
    this.engine = engine;
    this.client = requester;        // inspector compat
    this.server = target;
    this.proto = 'ARP';
    this.label = `ARP who-has ${target.ip}`;
    this.onResolved = onResolved;
    this.tries = 0;
    this.maxTries = 3;
    this.deadline = null;
    this.state = 'RESOLVING';
    this.dead = false;
    this.doneAt = null;
    this.history = [];
    this.startedAt = engine.time;
  }

  get name() { return `${this.client.mac} → ff:ff:ff:ff:ff:ff`; }
  get stateStr() { return this.state; }

  open() { this._request(); }

  _request() {
    this.tries++;
    this.deadline = this.engine.time + 1.6;
    const p = new Packet({
      src: this.client, dst: this.server, proto: 'ARP', kind: KIND.ARP_REQ,
      len: 0, flow: this,
      note: `who-has ${this.server.ip}? tell ${this.client.ip} (broadcast${this.tries > 1 ? `, retry ${this.tries - 1}` : ''})`,
    });
    this.engine.send(p);
    this.history.push({ t: this.engine.time, dir: 'c2s', kind: p.kind, len: 28, lost: p.lost });
  }

  onPacket(p) {
    if (p.kind === KIND.ARP_REQ && p.dst === this.server) {
      const rep = new Packet({
        src: this.server, dst: this.client, proto: 'ARP', kind: KIND.ARP_REP,
        len: 0, flow: this,
        note: `${this.server.ip} is-at ${this.server.mac}`,
      });
      this.engine.send(rep);
      this.history.push({ t: this.engine.time, dir: 's2c', kind: rep.kind, len: 28, lost: rep.lost });
    } else if (p.kind === KIND.ARP_REP && p.dst === this.client) {
      if (this.state !== 'RESOLVING') return;
      this.state = 'RESOLVED';
      this.doneAt = this.engine.time;
      this.engine.log(`⌗ ARP ${this.server.ip} is-at ${this.server.mac} → ${this.client.name} cache`, 'ok');
      if (this.onResolved) this.onResolved();
    }
  }

  update() {
    const now = this.engine.time;
    if (this.state !== 'RESOLVING') {
      if (now - this.doneAt > 2) this.dead = true;
      return;
    }
    if (this.deadline && now > this.deadline) {
      if (this.tries >= this.maxTries) {
        this.state = 'INCOMPLETE';
        this.doneAt = now;
        this.engine.log(`✖ ARP ${this.server.ip} incomplete — host silent`, 'bad');
        if (this.onResolved) this.onResolved();   // proceed anyway; upper layers will fail loudly
        return;
      }
      this._request();
    }
  }
}

// ============================== ICMP echo (ping) ==============================

export class PingFlow {
  constructor(engine, client, target, opts = {}) {
    this.engine = engine;
    this.client = client;
    this.server = target;
    this.proto = 'ICMP';
    this.label = `ping ${target.ip}`;
    this.count = opts.count ?? 5;
    this.interval = opts.interval ?? 1.4;
    this.timeout = 4.0;
    this.icmpId = (Math.random() * 0xffff) | 0;
    this.seq = 0;
    this.pending = new Map();        // seq -> sentAt
    this.rtts = [];
    this.lost = 0;
    this.nextAt = engine.time;
    this.state = 'PINGING';
    this.dead = false;
    this.doneAt = null;
    this.history = [];
    this.startedAt = engine.time;
  }

  get name() { return `${this.client.ip} → ${this.server.ip} icmp id=${this.icmpId}`; }
  get stateStr() {
    if (this.rtts.length === 0 && this.lost === 0) return this.state;
    const avg = this.rtts.length ? (this.rtts.reduce((a, b) => a + b, 0) / this.rtts.length).toFixed(2) : '—';
    return `${this.state} ${this.rtts.length}/${this.count} avg=${avg}s`;
  }

  open() {
    this.started = true;
    this.nextAt = this.engine.time;
    this.engine.log(`◌ PING ${this.server.ip} (${this.server.name}): 56 data bytes ×${this.count}`, '');
  }

  onPacket(p) {
    if (p.kind === KIND.ECHO_REQ && p.dst === this.server) {
      const rep = new Packet({
        src: this.server, dst: this.client, proto: 'ICMP', kind: KIND.ECHO_REP,
        len: 56, flow: this, icmpType: 0, icmpCode: 0, icmpId: this.icmpId, icmpSeq: p.icmpSeq,
        note: `echo reply seq=${p.icmpSeq}`,
      });
      this.engine.send(rep);
      this.history.push({ t: this.engine.time, dir: 's2c', kind: rep.kind, len: 56, lost: rep.lost });
    } else if (p.kind === KIND.ECHO_REP && p.dst === this.client) {
      const sentAt = this.pending.get(p.icmpSeq);
      if (sentAt === undefined) return;
      this.pending.delete(p.icmpSeq);
      const rtt = this.engine.time - sentAt;
      this.rtts.push(rtt);
      this.engine.log(`◌ 64 bytes from ${this.server.ip}: icmp_seq=${p.icmpSeq} ttl=63 time=${(rtt * 1000).toFixed(0)}ms (sim)`, '');
    }
  }

  update() {
    if (!this.started) return;
    const now = this.engine.time;
    if (this.state === 'DONE') {
      if (now - this.doneAt > 2.5) this.dead = true;
      return;
    }
    // fire next echo
    if (this.seq < this.count && now >= this.nextAt) {
      const p = new Packet({
        src: this.client, dst: this.server, proto: 'ICMP', kind: KIND.ECHO_REQ,
        len: 56, flow: this, icmpType: 8, icmpCode: 0, icmpId: this.icmpId, icmpSeq: this.seq,
        note: `echo request seq=${this.seq}`,
      });
      this.engine.send(p);
      this.history.push({ t: now, dir: 'c2s', kind: p.kind, len: 56, lost: p.lost });
      this.pending.set(this.seq, now);
      this.seq++;
      this.nextAt = now + this.interval;
    }
    // expire timeouts
    for (const [seq, sentAt] of this.pending) {
      if (now - sentAt > this.timeout) {
        this.pending.delete(seq);
        this.lost++;
        this.engine.log(`◌ request timeout for icmp_seq=${seq}`, 'warn');
      }
    }
    // finished?
    if (this.seq >= this.count && this.pending.size === 0) {
      this.state = 'DONE';
      this.doneAt = now;
      const pct = ((this.lost / this.count) * 100).toFixed(0);
      this.engine.log(`◌ ping done: ${this.count} tx, ${this.rtts.length} rx, ${pct}% loss`, this.lost ? 'warn' : 'ok');
    }
  }
}

// ============================== traceroute ==============================
// Real algorithm: UDP probes to dport 33434+, TTL=1 dies at the router
// (ICMP time-exceeded), TTL=2 reaches the host (ICMP port-unreachable).

export class TracerouteFlow {
  constructor(engine, client, server, router) {
    this.engine = engine;
    this.client = client;
    this.server = server;
    this.router = router;
    this.proto = 'ICMP';
    this.label = `traceroute ${server.ip}`;
    this.hops = [router, server];
    this.probesPerHop = 3;
    this.hopIdx = 0;
    this.probeIdx = 0;
    this.nextAt = engine.time;
    this.pending = new Map();        // dport -> {sentAt, hopIdx}
    this.hopRtts = this.hops.map(() => []);
    this.timeout = 4.5;
    this.state = 'TRACING';
    this.dead = false;
    this.doneAt = null;
    this.history = [];
    this.startedAt = engine.time;
    this.basePort = 33434;
  }

  get name() { return `${this.client.ip} → ${this.server.ip} (max 2 hops)`; }
  get stateStr() { return this.state === 'TRACING' ? `hop ${this.hopIdx + 1}/${this.hops.length}` : this.state; }

  open() {
    this.started = true;
    this.nextAt = this.engine.time;
    this.engine.log(`⇢ traceroute to ${this.server.ip} (${this.server.name}), 2 hops max, UDP probes`, '');
  }

  _probe() {
    const ttl = this.hopIdx + 1;
    const hopTarget = this.hops[this.hopIdx];        // where this probe physically dies
    const dport = this.basePort + this.hopIdx * this.probesPerHop + this.probeIdx;
    const p = new Packet({
      src: this.client, dst: hopTarget, proto: 'UDP', kind: KIND.PROBE,
      sport: 45000 + this.probeIdx, dport, len: 32, ttl, flow: this,
      dstIp: this.server.ip,                          // header says server; TTL decides where it stops
      note: `probe ttl=${ttl} → ${this.server.ip}:${dport}`,
    });
    this.engine.send(p);
    this.history.push({ t: this.engine.time, dir: 'c2s', kind: p.kind, len: 32, lost: p.lost });
    this.pending.set(dport, { sentAt: this.engine.time, hopIdx: this.hopIdx });
    this.probeIdx++;
  }

  onPacket(p) {
    if (p.kind === KIND.PROBE) {
      const atRouter = p.dst === this.router;
      const rep = new Packet({
        src: p.dst, dst: this.client, proto: 'ICMP',
        kind: atRouter ? KIND.TTL_EXC : KIND.UNREACH,
        len: 36,                                       // embeds offending IP header + 8 bytes
        flow: this,
        icmpType: atRouter ? 11 : 3, icmpCode: atRouter ? 0 : 3,
        icmpSeq: p.dport,
        note: atRouter
          ? `time exceeded in transit (TTL=0 at ${p.dst.name})`
          : `port ${p.dport} unreachable — destination reached`,
      });
      this.engine.send(rep);
      this.history.push({ t: this.engine.time, dir: 's2c', kind: rep.kind, len: 36, lost: rep.lost });
    } else if ((p.kind === KIND.TTL_EXC || p.kind === KIND.UNREACH) && p.dst === this.client) {
      const rec = this.pending.get(p.icmpSeq);
      if (!rec) return;
      this.pending.delete(p.icmpSeq);
      const rtt = this.engine.time - rec.sentAt;
      this.hopRtts[rec.hopIdx].push(rtt);
      if (this.hopRtts[rec.hopIdx].length === this.probesPerHop) {
        const hop = this.hops[rec.hopIdx];
        const times = this.hopRtts[rec.hopIdx].map(r => (r * 1000).toFixed(0) + 'ms').join('  ');
        this.engine.log(`⇢ ${rec.hopIdx + 1}  ${hop.name} (${hop.ip})  ${times}`, 'ok');
      }
    }
  }

  update() {
    if (!this.started) return;
    const now = this.engine.time;
    if (this.state === 'DONE') {
      if (now - this.doneAt > 2.5) this.dead = true;
      return;
    }
    if (this.hopIdx < this.hops.length && now >= this.nextAt) {
      if (this.probeIdx < this.probesPerHop) {
        this._probe();
        this.nextAt = now + 0.55;
      } else {
        this.hopIdx++;
        this.probeIdx = 0;
      }
    }
    for (const [dport, rec] of this.pending) {
      if (now - rec.sentAt > this.timeout) {
        this.pending.delete(dport);
        this.hopRtts[rec.hopIdx].push(NaN);
        this.engine.log(`⇢ ${rec.hopIdx + 1}  * probe lost`, 'warn');
      }
    }
    if (this.hopIdx >= this.hops.length && this.pending.size === 0) {
      this.state = 'DONE';
      this.doneAt = now;
      this.engine.log(`⇢ traceroute complete: ${this.hops.length} hops`, 'ok');
    }
  }
}
