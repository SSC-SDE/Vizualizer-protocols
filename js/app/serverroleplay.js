// ServerRolePlayDirector — "Run the server" mode. The player operates one server
// and answers incoming clients: completes the server half of the TCP handshake,
// serves the response, closes; echoes pings; resolves DNS queries. For TCP it
// drives a real `manualServer` TcpConnection (so the inspector / ladder / datagram
// card all keep working); the virtual client drives itself automatically.

import { KIND, KIND_COLOR, Packet } from '../sim/engine.js';
import { TcpConnection } from '../sim/tcp.js';
import { SERVER_MISSIONS } from './missions.js';

function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

// the response actions a server dispatches (reply side of each protocol)
export const SERVER_ACTION_KINDS = [
  KIND.ARP_REP, KIND.DNS_R, KIND.ECHO_REP, KIND.SYNACK, KIND.ACK, KIND.DATA, KIND.FIN, KIND.RST,
];

export const SERVER_WHO_OPTIONS = [
  { key: 'requester', label: 'requester', sub: 'the asking client' },
  { key: 'broadcast', label: 'broadcast', sub: 'all hosts' },
  { key: 'router', label: 'CORE-RTR', sub: 'gateway' },
];

const SERVER_LAYER_FOR_KIND = {
  [KIND.ARP_REP]: 'L2',
  [KIND.ECHO_REP]: 'L3',
  [KIND.DNS_R]: 'L4_UDP',
  [KIND.SYNACK]: 'L4_TCP', [KIND.ACK]: 'L4_TCP', [KIND.DATA]: 'L4_TCP',
  [KIND.FIN]: 'L4_TCP', [KIND.RST]: 'L4_TCP',
};

const LAYER_LABEL = { L2: 'the link layer (L2)', L3: 'the network layer (L3)', L4_UDP: 'UDP', L4_TCP: 'TCP' };

export class ServerRolePlayDirector {
  constructor(engine, topo, deps = {}) {
    this.engine = engine;
    this.topo = topo;
    this.controls = deps.controls;
    this.world = deps.world;
    this.inspector = deps.inspector;
    this.role = 'server';

    this.active = false;
    this.done = false;
    this.player = null;        // the server you run
    this.requester = null;     // the client currently asking

    this.onActivity = null;
    this.onState = null;
    this.onComplete = null;
    this.onReject = null;
    this.onExit = null;

    this.lastFeedback = '';
  }

  actionKinds() { return SERVER_ACTION_KINDS; }
  whoOptions() { return SERVER_WHO_OPTIONS; }

  // ---------------------------------------------------------------- lifecycle

  enter(missionKey) {
    const m = SERVER_MISSIONS[missionKey];
    if (!m) return;
    this.active = true;
    this.done = false;
    this.missionKey = missionKey;
    this.mission = m;
    this.steps = m.steps;
    this.stepIndex = 0;
    this.mistakes = 0;
    this.hintsUsed = 0;
    this.packetsSent = 0;
    this.conn = null;
    this.startedAt = this.engine.time;
    this.lastFeedback = m.intro;

    this.player = this.topo[m.serverKey] || this.topo.web;
    this.requester = pick(this.topo.clients);
    this.inspector?.setFlowFilter?.((f) => f.client === this.player || f.server === this.player);
    this.inspector?.setRolePlay?.(true);
    this.world?.markPlayer?.(this.player);
    this.world?.focusHost?.(this.player);
    this.onActivity?.(this.player, '👤 YOU (server)', 0x41a6ff, 6);
    this.engine.log(`▶ server role-play: ${m.title} — you run ${this.player.name}`, 'ok');

    if (m.type === 'tcp') this._spawnTcp();
    else this._spawnStateless();
    this.onState?.();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.done = false;
    this.inspector?.setFlowFilter?.(null);
    this.inspector?.setRolePlay?.(false);
    this.world?.unmarkPlayer?.();
    this.engine.log('■ server role-play ended', '');
    this.onExit?.();
    this.onState?.();
  }

  // ---------------------------------------------------------------- incoming traffic

  _spawnTcp() {
    this.conn = new TcpConnection(this.engine, this.requester, this.player, {
      manualServer: true, bytes: this.mission.bytes ?? 64 * 1024,
      dport: 80, label: `serve ${this.requester.name}`,
    });
    this.conn.onServerEvent = (what) => this._onServerEvent(what);
    this.engine.addFlow(this.conn);
    this.conn.open();                       // virtual client fires the SYN
    this.inspector?.selectFlow?.(this.conn);
    this._feedback('A client is connecting — watch for the SYN.');
  }

  _spawnStateless() {
    const me = this.player, c = this.requester, e = this.engine;
    if (this.mission.type === 'icmp') {
      this._icmpId = (Math.random() * 0xffff) | 0;
      e.send(new Packet({
        src: c, dst: me, proto: 'ICMP', kind: KIND.ECHO_REQ,
        icmpType: 8, icmpId: this._icmpId, icmpSeq: 0, len: 56, note: 'echo request seq=0',
      }));
    } else {
      this._qsport = 40000 + ((Math.random() * 4000) | 0);
      this._txid = (Math.random() * 0xffff) | 0;
      e.send(new Packet({
        src: c, dst: me, proto: 'UDP', kind: KIND.DNS_Q,
        sport: this._qsport, dport: 53, len: 38, seq: this._txid, note: 'A? example.com',
      }));
    }
    this._feedback('A request is on the wire — it will reach you in a moment.');
  }

  _onServerEvent(what) {
    if (!this.active) return;
    if (what === 'SYN') { this._goto(1); }               // → expect SYN-ACK
    else if (what === 'REQUEST') { this._goto(4); }      // → expect serve DATA
  }

  /** Incoming packets land here (from main's engine.onDeliver). */
  observeDeliver(pkt) {
    if (!this.active || this.done) return;
    if (pkt.dst !== this.player) return;
    const step = this.steps[this.stepIndex];
    if (step && step.auto === pkt.kind) {                // stateless request arrived
      this._feedback('✅ request received — your move.');
      this._goto(this.stepIndex + 1);
    }
  }

  update() {
    if (!this.active || this.done || this.mission.type !== 'tcp' || !this.conn) return;
    const step = this.steps[this.stepIndex];
    if (!step) return;
    if (step.auto === 'XFER' && this.conn.progress >= 1) this._goto(6);    // → expect FIN
    else if (step.auto === 'CLOSE' && this.conn.finished) this._complete();
  }

  // ---------------------------------------------------------------- player input

  dispatch({ kind, dst, layer }) {
    if (!this.active || this.done) return;
    const step = this.steps[this.stepIndex];
    if (!step || !step.expect) {
      this._feedback('⏳ nothing to answer yet — wait for the next request');
      return;
    }
    const exp = step.expect;
    const natural = SERVER_LAYER_FOR_KIND[kind];
    if (!natural || layer !== natural) {
      this._mistake(`${kind} can’t ride ${LAYER_LABEL[layer] || layer}`);
      const hint = layerHint(kind);
      this.onReject?.(hint);
      this._feedback(`✋ refused: ${hint}`);
      return;
    }
    if (kind !== exp.kind) {
      this._mistake(`${kind} isn’t the right response`);
      this._quip(this.requester, wrongWhatQuip(kind), 0xff7700);
      this._feedback(`🤔 ${kind} isn’t what the client is waiting for — it needs ${exp.kind}.`);
      return;
    }
    if (dst !== exp.dst) {
      this._mistake(`replied to the wrong host (${dst})`);
      this._stray(kind, dst);
      this._feedback(`🧭 you answered ${this._dstName(dst)} — the request came from the client.`);
      return;
    }
    this._execute(kind);
    this.packetsSent++;
    this._quip(this.player, `📤 ${kind} → ${this.requester.name}`, KIND_COLOR[kind] || 0x41a6ff);
    this._afterDispatch(kind);
  }

  hint() {
    const step = this.steps?.[this.stepIndex];
    if (!step || !step.expect) return '';
    this.hintsUsed++;
    this.onState?.();
    return step.hint || '';
  }

  _execute(kind) {
    const e = this.engine, me = this.player, c = this.requester;
    switch (kind) {
      case KIND.SYNACK: this.conn?.serverSynAck(); break;
      case KIND.DATA: this.conn?.serverRespond(); break;
      case KIND.FIN: this.conn?.serverFin(); break;
      case KIND.ECHO_REP:
        e.send(new Packet({
          src: me, dst: c, proto: 'ICMP', kind: KIND.ECHO_REP,
          icmpType: 0, icmpId: this._icmpId, icmpSeq: 0, len: 56, note: 'echo reply seq=0',
        }));
        break;
      case KIND.DNS_R:
        e.send(new Packet({
          src: me, dst: c, proto: 'UDP', kind: KIND.DNS_R,
          sport: 53, dport: this._qsport, len: 96, seq: this._txid,
          note: 'example.com A 93.184.216.34 TTL=300',
        }));
        break;
      default: break;
    }
  }

  _afterDispatch(kind) {
    if (this.mission.type !== 'tcp') { this._complete(); return; }
    if (kind === KIND.SYNACK) this._goto(2);        // wait for client ACK + REQUEST
    else if (kind === KIND.DATA) this._goto(5);     // wait for transfer to finish
    else if (kind === KIND.FIN) this._goto(7);      // wait for teardown
  }

  // ---------------------------------------------------------------- step machine

  _goto(i) {
    this.stepIndex = i;
    const step = this.steps[i];
    if (step) this._feedback(step.expect ? step.prompt : ('… ' + (step.label || 'working')));
    this.onState?.();
  }

  _complete() {
    this.done = true;
    const secs = this.engine.time - this.startedAt;
    const penalty = this.mistakes + this.hintsUsed * 0.5;
    const grade = penalty === 0 ? 'S' : penalty <= 1 ? 'A' : penalty <= 3 ? 'B' : 'C';
    this.engine.log(`★ server mission complete — grade ${grade} (${this.packetsSent} sent, ${this.mistakes} mistakes)`, 'ok');
    this._quip(this.player, `★ ${grade}`, 0x00ff88, 6);
    this.onComplete?.({ title: this.mission.title, packets: this.packetsSent, mistakes: this.mistakes, hints: this.hintsUsed, secs, grade });
    this.onState?.();
  }

  // ---------------------------------------------------------------- consequences / helpers

  _stray(kind, dstKey) {
    const host = this._dstHost(dstKey);
    if (!host) return;
    const proto = { [KIND.ARP_REP]: 'ARP', [KIND.ECHO_REP]: 'ICMP', [KIND.DNS_R]: 'UDP' }[kind] || 'TCP';
    const o = { src: this.player, dst: host, proto, kind, ttl: 64, note: `misdirected ${kind}` };
    if (proto === 'ICMP') { o.icmpType = 0; o.len = 56; }
    this.engine.send(new Packet(o));
    this._quip(host, '🤨 why are you telling me? I didn’t ask', 0xff4488);
  }

  _mistake(reason) {
    this.mistakes++;
    this.engine.log(`✖ server role-play: ${reason}`, 'warn');
    this.onState?.();
  }

  _quip(host, text, color, dur = 5) { this.onActivity?.(host, text, color, dur); }
  _feedback(text) { this.lastFeedback = text; this.onState?.(); }

  _dstHost(key) {
    switch (key) {
      case 'requester': return this.requester;
      case 'broadcast': case 'router': return this.topo.router;
      default: return this.topo[key] || null;
    }
  }
  _dstName(key) { return key === 'requester' ? this.requester?.name : (this._dstHost(key)?.name || key); }

  getState() {
    return {
      active: this.active, done: this.done, role: 'server',
      mission: this.mission, steps: this.steps || [], stepIndex: this.stepIndex,
      mistakes: this.mistakes, hints: this.hintsUsed, packets: this.packetsSent,
      feedback: this.lastFeedback, player: this.player,
    };
  }
}

function wrongWhatQuip(kind) {
  if (kind === KIND.SYN || kind === KIND.REQ) return '🙃 I’m the client — that’s your job, server';
  if (kind === KIND.RST) return '😟 a reset? what did I do wrong?';
  return '🤔 that’s not the reply I’m waiting for';
}

function layerHint(kind) {
  const map = {
    [KIND.ARP_REP]: 'An ARP reply lives at L2 — link layer.',
    [KIND.ECHO_REP]: 'An echo reply is ICMP — Layer 3.',
    [KIND.DNS_R]: 'A DNS reply is a UDP datagram — L4 · UDP.',
  };
  return map[kind] || 'TCP segments fly in the L4 · TCP lane.';
}
