// UDP flows: fire-and-forget datagrams. Reliability (or lack of it) lives in
// the application layer — DNS retries on timeout, media streams just lose frames.

import { Packet, KIND } from './engine.js';

let ephemeral = 32768;
function nextEphemeral() {
  ephemeral = ephemeral >= 49000 ? 32768 : ephemeral + 1;
  return ephemeral;
}

const DOMAINS = [
  'api.hyperion.dev', 'cdn.nebula.io', 'auth.kraken.net', 'tiles.atlas.gg',
  'metrics.pulse.app', 'img.vortex.cc', 'ws.signal.fm', 'edge.quanta.ai',
];

export class DnsTransaction {
  constructor(engine, client, server, opts = {}) {
    this.engine = engine;
    this.client = client;
    this.server = server;
    this.proto = 'UDP';
    this.domain = opts.domain || DOMAINS[(Math.random() * DOMAINS.length) | 0];
    this.label = `DNS ${this.domain}`;
    this.sport = nextEphemeral();
    this.dport = 53;
    this.txid = (Math.random() * 0xffff) | 0;
    this.tries = 0;
    this.maxTries = 3;
    this.timeout = 2.8;
    this.deadline = null;
    this.answered = false;
    this.dead = false;
    this.doneAt = null;
    this.history = [];
    this.startedAt = engine.time;
    this.state = 'QUERYING';
  }

  get name() { return `${this.client.ip}:${this.sport} → ${this.server.ip}:53`; }
  get stateStr() { return this.state; }

  open() { this._query(); }

  _query() {
    this.tries++;
    this.deadline = this.engine.time + this.timeout;
    const p = new Packet({
      src: this.client, dst: this.server, proto: 'UDP', kind: KIND.DNS_Q,
      sport: this.sport, dport: 53, len: 17 + this.domain.length + 16,
      seq: this.txid, flow: this,
      note: `A? ${this.domain} (txid 0x${this.txid.toString(16)}${this.tries > 1 ? `, retry ${this.tries - 1}` : ''})`,
    });
    this.engine.send(p);
    this.history.push({ t: this.engine.time, dir: 'c2s', kind: p.kind, len: p.len, lost: p.lost });
  }

  onPacket(p) {
    if (p.kind === KIND.DNS_Q && p.dst === this.server) {
      // server resolves after a small "lookup" — answer with A record(s)
      const answer = new Packet({
        src: this.server, dst: this.client, proto: 'UDP', kind: KIND.DNS_R,
        sport: 53, dport: this.sport, len: 90 + ((Math.random() * 140) | 0),
        seq: this.txid, flow: this,
        note: `${this.domain} A ${randIp()} TTL=300`,
      });
      this.engine.send(answer);
      this.history.push({ t: this.engine.time, dir: 's2c', kind: answer.kind, len: answer.len, lost: answer.lost });
    } else if (p.kind === KIND.DNS_R && p.dst === this.client) {
      if (this.answered) return;
      this.answered = true;
      this.state = 'RESOLVED';
      this.doneAt = this.engine.time;
      this.engine.log(`✓ DNS ${this.domain} resolved in ${(this.engine.time - this.startedAt).toFixed(1)}s (${this.tries} tx)`, 'ok');
    }
  }

  update() {
    const now = this.engine.time;
    if (this.answered || this.state === 'FAILED') {
      if (now - this.doneAt > 2) this.dead = true;
      return;
    }
    if (this.deadline && now > this.deadline) {
      if (this.tries >= this.maxTries) {
        this.state = 'FAILED';
        this.doneAt = now;
        this.engine.log(`✖ DNS ${this.domain} SERVFAIL — ${this.maxTries} timeouts`, 'bad');
        return;
      }
      this.engine.log(`⌛ DNS ${this.domain} timeout — retrying`, 'warn');
      this._query();
    }
  }
}

export class MediaStream {
  /** Constant-rate UDP stream (RTP-style): seq numbers, receiver tracks loss & jitter. */
  constructor(engine, server, client, opts = {}) {
    this.engine = engine;
    this.client = client;
    this.server = server;
    this.proto = 'UDP';
    this.label = opts.label || 'media stream';
    this.sport = nextEphemeral();
    this.dport = nextEphemeral();
    this.rate = opts.rate ?? 12;          // packets per second
    this.pktLen = opts.pktLen ?? 1200;
    this.duration = opts.duration ?? 20;
    this.seq = 0;
    this.rxSeqMax = -1;
    this.rxCount = 0;
    this.lostCount = 0;
    this.lastArrival = null;
    this.jitter = 0;                       // RFC 3550-style smoothed interarrival jitter
    this.acc = 0;
    this.endAt = engine.time + this.duration;
    this.dead = false;
    this.doneAt = null;
    this.history = [];
    this.startedAt = engine.time;
    this.state = 'STREAMING';
  }

  get name() { return `${this.server.ip}:${this.sport} → ${this.client.ip}:${this.dport}`; }
  get stateStr() {
    const lossPct = this.rxSeqMax > 0 ? ((this.lostCount / (this.rxSeqMax + 1)) * 100).toFixed(1) : '0.0';
    return `${this.state} loss=${lossPct}%`;
  }

  open() {
    this.engine.log(`▶ UDP stream ${this.server.name} → ${this.client.name} @${this.rate}pps ×${this.duration}s`, '');
  }

  onPacket(p) {
    if (p.dst !== this.client) return;
    this.rxCount++;
    const expected = this.rxSeqMax + 1;
    if (p.seq > expected) this.lostCount += p.seq - expected;  // gap = frames gone, no recovery
    if (p.seq > this.rxSeqMax) this.rxSeqMax = p.seq;
    const now = this.engine.time;
    if (this.lastArrival !== null) {
      const d = Math.abs((now - this.lastArrival) - 1 / this.rate);
      this.jitter += (d - this.jitter) / 16;
    }
    this.lastArrival = now;
  }

  update(dt) {
    const now = this.engine.time;
    if (this.state === 'DONE') {
      if (now - this.doneAt > 2) this.dead = true;
      return;
    }
    if (now >= this.endAt) {
      this.state = 'DONE';
      this.doneAt = now;
      const total = this.seq;
      this.engine.log(`■ stream ended: ${this.rxCount}/${total} rx, jitter ${(this.jitter * 1000).toFixed(0)}ms`, '');
      return;
    }
    this.acc += dt * this.rate;
    while (this.acc >= 1) {
      this.acc -= 1;
      const p = new Packet({
        src: this.server, dst: this.client, proto: 'UDP', kind: KIND.STREAM,
        sport: this.sport, dport: this.dport, len: this.pktLen,
        seq: this.seq, flow: this,
        note: `frame #${this.seq} pt=96 ts=${(this.seq * 3000) >>> 0}`,
      });
      this.engine.send(p);
      this.history.push({ t: now, dir: 's2c', kind: p.kind, len: p.len, lost: p.lost });
      if (this.history.length > 300) this.history.splice(0, 100);
      this.seq++;
    }
  }
}

function randIp() {
  return `${10 + ((Math.random() * 200) | 0)}.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${1 + ((Math.random() * 250) | 0)}`;
}
