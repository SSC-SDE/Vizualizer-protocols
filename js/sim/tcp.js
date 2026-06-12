// Full TCP connection simulation: 3-way handshake, sequence/ack arithmetic,
// sliding window, Reno congestion control (slow start, congestion avoidance,
// fast retransmit / fast recovery), Jacobson/Karels RTO with Karn's algorithm,
// delayed ACKs, out-of-order reassembly, and 4-way FIN teardown.
//
// The connection owns BOTH endpoints (we simulate the whole wire). The server
// is the bulk sender (HTTP-style response); the client sends a small request
// and ACKs.

import { Packet, KIND, MSS } from './engine.js';

const RWND = 65535 * 4;           // receiver advertised window (constant)
const INIT_CWND = 10 * MSS;       // RFC 6928
const MIN_RTO = 0.9;              // sim seconds (latencies are stretched for visibility)
const MAX_RTO = 12;
const DELACK_TIMEOUT = 0.35;
const TIME_WAIT = 2.5;

let ephemeral = 49152;
function nextEphemeral() {
  ephemeral = ephemeral >= 65500 ? 49152 : ephemeral + 1;
  return ephemeral;
}

export class TcpConnection {
  /**
   * opts: { bytes: response size, dport: 80|443, label, slow: bool (handshake demo pacing) }
   */
  constructor(engine, client, server, opts = {}) {
    this.engine = engine;
    this.client = client;
    this.server = server;
    this.proto = 'TCP';
    this.label = opts.label || `HTTP ${server.name}`;
    this.sport = nextEphemeral();
    this.dport = opts.dport ?? 80;
    this.dead = false;
    this.doneAt = null;

    // endpoint states
    this.cstate = 'CLOSED';
    this.sstate = 'LISTEN';

    // client ISN / server ISN
    this.iss_c = (Math.random() * 0xffffffff) >>> 0;
    this.iss_s = (Math.random() * 0xffffffff) >>> 0;

    // ----- server (bulk sender) congestion state -----
    this.snd_una = 0;            // relative seq space (server stream)
    this.snd_nxt = 0;
    this.cwnd = INIT_CWND;
    this.ssthresh = 64 * MSS;
    this.srtt = null;
    this.rttvar = 0;
    this.rto = 4.5;   // initial RTO > stretched sim RTT (~2.6s via router) to avoid spurious timeout
    this.rtoDeadline = null;
    this.dupAcks = 0;
    this.inRecovery = false;
    this.recoverHigh = 0;
    this.totalBytes = opts.bytes ?? 256 * 1024;
    this.segMeta = new Map();    // seq -> {sentAt, retx:bool, len}
    this.synRetries = 0;         // server SYN-ACK retransmits (flood case)
    this.synAckDeadline = null;

    // ----- client (receiver) state -----
    this.rcv_nxt = 0;            // next expected relative seq from server
    this.ooo = new Map();        // seq -> len (out of order buffer)
    this.delAckPending = 0;      // segments since last ACK
    this.delAckDeadline = null;

    // history for ladder diagram + cwnd chart
    this.history = [];           // {t, dir:'c2s'|'s2c', kind, seq, ack, len, lost}
    this.cwndHist = [];          // {t, cwnd, ssthresh, inflight}
    this.eventNote = '';
    this.synFloodVictim = !!opts.synFloodVictim;  // never completes handshake
    this.requestSent = false;
    this.finished = false;
    this.retxCount = 0;
    this.startedAt = engine.time;
  }

  get name() {
    return `${this.client.ip}:${this.sport} ⇄ ${this.server.ip}:${this.dport}`;
  }
  get stateStr() {
    return `${this.cstate}/${this.sstate}`;
  }
  get progress() {
    return Math.min(1, this.snd_una / this.totalBytes);
  }
  get inflight() {
    return this.snd_nxt - this.snd_una;
  }

  // ---------------------------------------------------------------- helpers

  _mk(dirC2S, kind, o = {}) {
    const p = new Packet({
      src: dirC2S ? this.client : this.server,
      dst: dirC2S ? this.server : this.client,
      proto: 'TCP',
      kind,
      sport: dirC2S ? this.sport : this.dport,
      dport: dirC2S ? this.dport : this.sport,
      win: RWND & 0xffff,
      flow: this,
      ...o,
    });
    return p;
  }

  _record(p, dirC2S) {
    this.history.push({
      t: this.engine.time, dir: dirC2S ? 'c2s' : 's2c',
      kind: p.kind, seq: p.seq, ack: p.ackNo, len: p.len, lost: p.lost,
      flags: p.flagStr,
    });
    if (this.history.length > 400) this.history.splice(0, this.history.length - 400);
  }

  _send(dirC2S, kind, o = {}) {
    const p = this._mk(dirC2S, kind, o);
    this.engine.send(p, o.noLoss ? { noLoss: true } : {});
    this._record(p, dirC2S);
    return p;
  }

  _snapCwnd() {
    this.cwndHist.push({
      t: this.engine.time, cwnd: this.cwnd,
      ssthresh: this.ssthresh, inflight: this.inflight,
    });
    if (this.cwndHist.length > 600) this.cwndHist.splice(0, this.cwndHist.length - 600);
  }

  // ---------------------------------------------------------------- lifecycle

  open() {
    this.cstate = 'SYN_SENT';
    this.engine.log(`⇄ ${this.name} SYN → connect (${this.label})`, 'ok');
    this._send(true, KIND.SYN, {
      flags: { SYN: 1 }, seq: this.iss_c, note: 'client ISN, MSS=1460, WS=7, SACK-permitted',
    });
  }

  abort(why) {
    this.eventNote = why;
    this._send(false, KIND.RST, { flags: { RST: 1, ACK: 1 }, noLoss: true, note: why });
    this.cstate = 'CLOSED';
    this.sstate = 'CLOSED';
    this._finish();
  }

  _finish() {
    if (!this.finished) {
      this.finished = true;
      this.doneAt = this.engine.time;
    }
  }

  // ---------------------------------------------------------------- receive path

  onPacket(p) {
    if (this.finished && p.kind !== KIND.ACK) return;
    const atServer = p.dst === this.server;
    if (atServer) this._serverRecv(p); else this._clientRecv(p);
  }

  _serverRecv(p) {
    if (p.flags.SYN && !p.flags.ACK) {
      // new connection attempt
      if (this.engine.synBacklog >= this.engine.synBacklogMax) {
        this.engine.log(`✖ ${this.server.name} backlog full — RST to ${this.client.ip}`, 'bad');
        this.abort('backlog exhausted (SYN flood)');
        return;
      }
      this.sstate = 'SYN_RCVD';
      this.engine.synBacklog++;
      this.synAckDeadline = this.engine.time + this.rto;
      this._send(false, KIND.SYNACK, {
        flags: { SYN: 1, ACK: 1 }, seq: this.iss_s, ackNo: (this.iss_c + 1) >>> 0,
        note: 'server ISN, ack client ISN+1',
      });
      return;
    }

    if (p.flags.RST) { this.sstate = 'CLOSED'; this._finish(); return; }

    if (p.flags.ACK && this.sstate === 'SYN_RCVD') {
      this.sstate = 'ESTABLISHED';
      this.engine.synBacklog = Math.max(0, this.engine.synBacklog - 1);
      this.synAckDeadline = null;
    }

    if (p.kind === KIND.REQ) {
      // client request received → start streaming response
      if (this.sstate === 'ESTABLISHED' && this.snd_nxt === 0) {
        this.engine.log(`▶ ${this.name} GET → streaming ${fmtBytes(this.totalBytes)}`, '');
        this._pump();
      }
      // ack the request
      this._send(false, KIND.ACK, {
        flags: { ACK: 1 }, seq: this._sseq(this.snd_nxt), ackNo: this._cack(), len: 0,
      });
      return;
    }

    if (p.flags.ACK && !p.flags.SYN && !p.flags.FIN) {
      this._handleAck(p);
      return;
    }

    if (p.flags.FIN) {
      // client FIN (after our FIN) → final ACK, we're done
      this.sstate = 'CLOSED';
      this._send(false, KIND.ACK, { flags: { ACK: 1 }, noLoss: true, note: 'final ACK' });
      this._finish();
      this.engine.log(`✓ ${this.name} closed cleanly in ${(this.engine.time - this.startedAt).toFixed(1)}s, ${this.retxCount} retx`, 'ok');
    }
  }

  _clientRecv(p) {
    if (p.flags.RST) {
      this.cstate = 'CLOSED';
      this.engine.log(`✖ ${this.name} RST received — ${p.note || 'connection reset'}`, 'bad');
      this._finish();
      return;
    }

    if (p.flags.SYN && p.flags.ACK) {
      if (this.cstate === 'ESTABLISHED') {
        // our handshake ACK was lost — server is retransmitting SYN-ACK. Re-ACK.
        this._send(true, KIND.ACK, {
          flags: { ACK: 1 }, seq: (this.iss_c + 1) >>> 0, ackNo: (this.iss_s + 1) >>> 0,
          note: 're-ACK (lost handshake ACK)',
        });
        return;
      }
      if (this.cstate !== 'SYN_SENT') return;
      this.cstate = 'ESTABLISHED';
      this._send(true, KIND.ACK, {
        flags: { ACK: 1 }, seq: (this.iss_c + 1) >>> 0, ackNo: (this.iss_s + 1) >>> 0,
        note: 'handshake complete',
      });
      if (!this.requestSent) {
        this.requestSent = true;
        this._sendRequest();
      }
      return;
    }

    if (p.kind === KIND.DATA || p.kind === KIND.RETRANS) {
      this._clientRecvData(p);
      return;
    }

    if (p.flags.FIN) {
      // server done sending → ACK it, send our FIN
      this.cstate = 'TIME_WAIT';
      this._send(true, KIND.ACK, { flags: { ACK: 1 }, noLoss: true, note: 'ack server FIN' });
      this._send(true, KIND.FIN, { flags: { FIN: 1, ACK: 1 }, noLoss: true, note: 'client FIN' });
      return;
    }
  }

  _clientRecvData(p) {
    const rel = p.relSeq; // attached on send
    if (rel === this.rcv_nxt) {
      this.rcv_nxt += p.len;
      // absorb contiguous out-of-order segments
      while (this.ooo.has(this.rcv_nxt)) {
        const l = this.ooo.get(this.rcv_nxt);
        this.ooo.delete(this.rcv_nxt);
        this.rcv_nxt += l;
      }
      // delayed ACK: every 2nd segment immediately, else timer
      this.delAckPending++;
      if (this.delAckPending >= 2 || this.ooo.size > 0) this._sendAck('');
      else this.delAckDeadline = this.engine.time + DELACK_TIMEOUT;
    } else if (rel > this.rcv_nxt) {
      // hole → buffer + immediate dup ACK
      this.ooo.set(rel, p.len);
      this._sendAck(`dup-ack (hole at ${this.rcv_nxt})`);
    } else {
      // already have it (spurious retransmit) → ack current edge
      this._sendAck('spurious retransmit');
    }
  }

  _sendRequest(retry = false) {
    this.reqDeadline = this.engine.time + 4.0;
    this._send(true, KIND.REQ, {
      flags: { ACK: 1, PSH: 1 }, seq: (this.iss_c + 1) >>> 0, ackNo: (this.iss_s + 1) >>> 0,
      len: 312, note: `GET / HTTP/1.1 — ${this.label}${retry ? ' (retry)' : ''}`,
    });
  }

  _sendAck(note) {
    this.delAckPending = 0;
    this.delAckDeadline = null;
    this._send(true, KIND.ACK, {
      flags: { ACK: 1 },
      seq: (this.iss_c + 1 + 312) >>> 0,
      ackNo: this._sseq(this.rcv_nxt),
      note,
    });
  }

  // ---------------------------------------------------------------- sender (server)

  _sseq(rel) { return (this.iss_s + 1 + rel) >>> 0; }
  _cack() { return (this.iss_c + 1 + (this.requestSent ? 312 : 0)) >>> 0; }

  _handleAck(p) {
    // map absolute ack back to relative stream offset
    const relAck = (p.ackNo - this.iss_s - 1) >>> 0;
    if (relAck > this.totalBytes + 1) return;

    if (relAck > this.snd_una) {
      // ----- new data acked -----
      const acked = relAck - this.snd_una;
      // RTT sample (Karn: skip retransmitted segments)
      const meta = this.segMeta.get(this.snd_una);
      if (meta && !meta.retx) this._sampleRtt(this.engine.time - meta.sentAt);
      for (const [s] of this.segMeta) if (s < relAck) this.segMeta.delete(s);
      this.snd_una = relAck;
      this.dupAcks = 0;

      if (this.inRecovery) {
        if (relAck >= this.recoverHigh) {
          this.inRecovery = false;
          this.cwnd = this.ssthresh;       // deflate
          this.eventNote = 'exit fast recovery';
        } else {
          // partial ack (NewReno): retransmit next hole
          this._retransmit(this.snd_una, 'partial-ack retransmit');
        }
      } else if (this.cwnd < this.ssthresh) {
        this.cwnd += Math.min(acked, MSS);              // slow start: ~×2 per RTT
      } else {
        this.cwnd += Math.max(1, Math.floor(MSS * MSS / this.cwnd)); // AIMD
      }

      this.rtoDeadline = this.snd_una < this.snd_nxt ? this.engine.time + this.rto : null;
      this._snapCwnd();
      this._pump();
      this._maybeFinish();
    } else if (relAck === this.snd_una && this.snd_una < this.snd_nxt) {
      // ----- duplicate ACK -----
      this.dupAcks++;
      if (this.dupAcks === 3 && !this.inRecovery) {
        // fast retransmit + fast recovery (Reno)
        this.ssthresh = Math.max(Math.floor(this.inflight / 2), 2 * MSS);
        this.cwnd = this.ssthresh + 3 * MSS;
        this.inRecovery = true;
        this.recoverHigh = this.snd_nxt;
        this.eventNote = 'fast retransmit (3 dup ACKs)';
        this.engine.log(`⚡ ${this.name} fast retransmit @${this.snd_una} (3 dupACKs)`, 'warn');
        this._retransmit(this.snd_una, '3 dup ACKs');
        this._snapCwnd();
      } else if (this.inRecovery) {
        this.cwnd += MSS;       // window inflation per extra dup ACK
        this._snapCwnd();
        this._pump();
      }
    }
  }

  _sampleRtt(r) {
    if (this.srtt === null) {
      this.srtt = r;
      this.rttvar = r / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - r);
      this.srtt = 0.875 * this.srtt + 0.125 * r;
    }
    this.rto = Math.min(MAX_RTO, Math.max(MIN_RTO, this.srtt + 4 * this.rttvar));
  }

  _pump() {
    if (this.sstate !== 'ESTABLISHED') return;
    const wnd = Math.min(this.cwnd, RWND);
    while (this.snd_nxt < this.totalBytes && this.snd_nxt - this.snd_una < wnd) {
      const len = Math.min(MSS, this.totalBytes - this.snd_nxt);
      const rel = this.snd_nxt;
      const p = this._send(false, KIND.DATA, {
        flags: { ACK: 1, PSH: rel + len >= this.totalBytes ? 1 : 0 },
        seq: this._sseq(rel), ackNo: this._cack(), len,
        note: `bytes ${rel}–${rel + len} of ${this.totalBytes}`,
      });
      p.relSeq = rel;
      this.segMeta.set(rel, { sentAt: this.engine.time, retx: false, len });
      this.snd_nxt += len;
      if (this.rtoDeadline === null) this.rtoDeadline = this.engine.time + this.rto;
    }
  }

  _retransmit(rel, why) {
    const meta = this.segMeta.get(rel);
    const len = meta ? meta.len : Math.min(MSS, this.totalBytes - rel);
    const p = this._send(false, KIND.RETRANS, {
      flags: { ACK: 1 }, seq: this._sseq(rel), ackNo: this._cack(), len,
      note: `retransmit ${rel}–${rel + len} — ${why}`,
    });
    p.relSeq = rel;
    this.segMeta.set(rel, { sentAt: this.engine.time, retx: true, len });
    this.retxCount++;
  }

  _maybeFinish() {
    if (this.snd_una >= this.totalBytes && this.sstate === 'ESTABLISHED') {
      this.sstate = 'FIN_WAIT_1';
      this._sendFin();
    }
  }

  _sendFin(retry = false) {
    this.finDeadline = this.engine.time + this.rto * 2;
    this._send(false, KIND.FIN, {
      flags: { FIN: 1, ACK: 1 }, seq: this._sseq(this.totalBytes), ackNo: this._cack(),
      note: `server FIN — transfer complete${retry ? ' (retry)' : ''}`,
    });
  }

  // ---------------------------------------------------------------- timers

  update() {
    const now = this.engine.time;

    if (this.finished) {
      if (now - this.doneAt > TIME_WAIT) this.dead = true;
      return;
    }

    // client SYN retransmission (no SYN-ACK back)
    if (this.cstate === 'SYN_SENT' && !this._synTimer) this._synTimer = now + 2.0;
    if (this.cstate === 'SYN_SENT' && now > this._synTimer) {
      this._synRetries = (this._synRetries || 0) + 1;
      if (this._synRetries > 4) {
        this.engine.log(`✖ ${this.name} connect timeout`, 'bad');
        this.cstate = 'CLOSED'; this._finish(); return;
      }
      this._synTimer = now + 2.0 * 2 ** this._synRetries;
      this._send(true, KIND.SYN, { flags: { SYN: 1 }, seq: this.iss_c, note: `SYN retry #${this._synRetries}` });
    }

    // server SYN-ACK retransmission (half-open; the SYN-flood burn)
    if (this.sstate === 'SYN_RCVD' && this.synAckDeadline && now > this.synAckDeadline) {
      this.synRetries++;
      if (this.synRetries > 3) {
        this.engine.synBacklog = Math.max(0, this.engine.synBacklog - 1);
        this.sstate = 'CLOSED';
        this.engine.log(`⌛ ${this.server.name} half-open ${this.client.ip} expired`, 'warn');
        this._finish();
        return;
      }
      this.synAckDeadline = now + this.rto * 2 ** this.synRetries;
      this._send(false, KIND.SYNACK, {
        flags: { SYN: 1, ACK: 1 }, seq: this.iss_s, ackNo: (this.iss_c + 1) >>> 0,
        note: `SYN-ACK retry #${this.synRetries} (half-open)`,
      });
    }
    if (this.synFloodVictim && this.cstate === 'SYN_SENT') {
      // spoofed source: client never answers; silence the client side
      this.cstate = 'SPOOFED';
    }

    // delayed ACK timer (client)
    if (this.delAckDeadline && now > this.delAckDeadline) this._sendAck('delayed ACK timer');

    // lost request: established but server never started sending
    if (this.cstate === 'ESTABLISHED' && this.requestSent && this.rcv_nxt === 0
        && this.reqDeadline && now > this.reqDeadline) {
      this._sendRequest(true);
    }

    // lost server FIN: keep nudging until the client FINs back
    if (this.sstate === 'FIN_WAIT_1' && this.finDeadline && now > this.finDeadline) {
      this._sendFin(true);
    }

    // RTO (server sender)
    if (this.rtoDeadline && now > this.rtoDeadline && this.snd_una < this.snd_nxt) {
      this.ssthresh = Math.max(Math.floor(this.inflight / 2), 2 * MSS);
      this.cwnd = MSS;                       // back to slow start
      this.rto = Math.min(MAX_RTO, this.rto * 2);   // exponential backoff
      this.inRecovery = false;
      this.dupAcks = 0;
      this.eventNote = 'RTO — timeout retransmit';
      this.engine.log(`⏱ ${this.name} RTO fired @${this.snd_una}, cwnd→1 MSS, rto→${this.rto.toFixed(1)}s`, 'bad');
      this._retransmit(this.snd_una, 'RTO timeout');
      this.rtoDeadline = now + this.rto;
      this._snapCwnd();
    }
  }
}

export function fmtBytes(b) {
  if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
  if (b >= 1 << 10) return (b / (1 << 10)).toFixed(0) + ' KB';
  return b + ' B';
}
