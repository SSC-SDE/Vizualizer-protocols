// RolePlayDirector — "Be the Client" mode. The player drives the client side of
// every flow by hand; the servers and router keep answering automatically. It
// owns the active mission, validates each (WHAT, WHO, LAYER) dispatch against the
// mission script, drives the real sim flow classes so the inspector/HUD/tutor all
// keep working, and emits the consequences of wrong choices.

import { KIND, KIND_COLOR, Packet } from '../sim/engine.js';
import { TcpConnection } from '../sim/tcp.js';
import { DnsTransaction, MediaStream } from '../sim/udp.js';
import { ArpExchange, PingFlow } from '../sim/l2l3.js';
import { MISSIONS } from './missions.js';

function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

// The full list of dispatchable actions the action deck shows (always all of
// them — picking the wrong one is the learning mechanic).
export const ACTION_KINDS = [
  KIND.ARP_REQ, KIND.DNS_Q, KIND.ECHO_REQ, KIND.SYN, KIND.ACK,
  KIND.REQ, KIND.DATA, KIND.RETRANS, KIND.FIN, KIND.RST,
];

export const WHO_OPTIONS = [
  { key: 'broadcast', label: 'broadcast', sub: 'ff:ff:ff:ff:ff:ff' },
  { key: 'router', label: 'CORE-RTR', sub: 'gateway' },
  { key: 'dns', label: 'DNS-CORE', sub: 'resolver' },
  { key: 'web', label: 'WEB-EDGE', sub: 'web server' },
  { key: 'media', label: 'MEDIA-RELAY', sub: 'stream' },
];

export const LAYER_OPTIONS = [
  { key: 'L2', label: 'L2', sub: 'link' },
  { key: 'L3', label: 'L3', sub: 'network' },
  { key: 'L4_UDP', label: 'UDP', sub: 'L4' },
  { key: 'L4_TCP', label: 'TCP', sub: 'L4' },
];

// the OSI lane each action naturally rides in (validated in reverse)
const LAYER_FOR_KIND = {
  [KIND.ARP_REQ]: 'L2',
  [KIND.ECHO_REQ]: 'L3',
  [KIND.DNS_Q]: 'L4_UDP',
  [KIND.SYN]: 'L4_TCP', [KIND.ACK]: 'L4_TCP', [KIND.REQ]: 'L4_TCP',
  [KIND.DATA]: 'L4_TCP', [KIND.RETRANS]: 'L4_TCP', [KIND.FIN]: 'L4_TCP', [KIND.RST]: 'L4_TCP',
};

const PROTO_FOR_KIND = {
  [KIND.ARP_REQ]: 'ARP', [KIND.ECHO_REQ]: 'ICMP', [KIND.DNS_Q]: 'UDP',
  [KIND.SYN]: 'TCP', [KIND.ACK]: 'TCP', [KIND.REQ]: 'TCP',
  [KIND.DATA]: 'TCP', [KIND.RETRANS]: 'TCP', [KIND.FIN]: 'TCP', [KIND.RST]: 'TCP',
};

const LAYER_LABEL = { L2: 'the link layer (L2)', L3: 'the network layer (L3)', L4_UDP: 'UDP', L4_TCP: 'TCP' };

export class RolePlayDirector {
  constructor(engine, topo, deps = {}) {
    this.engine = engine;
    this.topo = topo;
    this.controls = deps.controls;
    this.world = deps.world;
    this.tutor = deps.tutor;
    this.inspector = deps.inspector;

    this.active = false;
    this.done = false;
    this.player = null;

    // UI hooks (wired by main / action deck)
    this.onActivity = null;        // (host, text, color, dur) — speech bubbles
    this.onState = null;           // () — deck should re-read state
    this.onComplete = null;        // (stats)
    this.onReject = null;          // (hintText) — dispatch refused at the NIC
    this.onEnter = null;
    this.onExit = null;

    this.role = 'client';
    this.lastFeedback = '';        // short line shown under the deck
  }

  actionKinds() { return ACTION_KINDS; }
  whoOptions() { return WHO_OPTIONS; }

  // ---------------------------------------------------------------- lifecycle

  enter(missionKey) {
    const m = MISSIONS[missionKey];
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
    this.stream = null;
    this.startedAt = this.engine.time;
    this.lastFeedback = m.intro;

    this.player = pick(this.topo.clients);
    // ambient stays on — the rest of the network keeps living around you
    this.inspector?.setFlowFilter?.((f) => f.client === this.player || f.server === this.player);
    this.inspector?.setRolePlay?.(true);
    if (m.lossBurst) {
      this.engine.lossBurstUntil = this.engine.time + m.lossBurst.secs;
      this.engine.lossBurstRate = m.lossBurst.rate;
    }
    this.world?.markPlayer?.(this.player);
    this.world?.focusHost?.(this.player);
    this.onActivity?.(this.player, '👤 YOU', 0x41a6ff, 6);
    this.engine.log(`▶ role-play: ${m.title} — you are ${this.player.name} (${this.player.ip})`, 'ok');
    this._enterStep();
    this.onEnter?.();
    this.onState?.();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.done = false;
    if (this.stream && !this.stream.dead) this.stream.endAt = this.engine.time;  // wind the stream down
    this.inspector?.setFlowFilter?.(null);
    this.inspector?.setRolePlay?.(false);
    this.engine.lossBurstUntil = 0;
    this.world?.unmarkPlayer?.();
    this.world?.clearFocus?.();
    this.engine.log('■ role-play ended — back to ambient mode', '');
    this.onExit?.();
    this.onState?.();
  }

  // ---------------------------------------------------------------- player input

  /** Single entry point from the action deck. */
  dispatch({ kind, dst, layer }) {
    if (!this.active || this.done) return;
    const step = this.steps[this.stepIndex];
    if (!step || step.auto) {
      this._feedback('⏳ hold on — the network is still answering your last move');
      this._quip(this.player, '⏳ waiting for a reply…', 0xffaa00);
      return;
    }
    const exp = step.expect;
    const natural = LAYER_FOR_KIND[kind];

    // 1) layer sanity — wrong lane is refused at the NIC, no packet flies
    if (!natural || layer !== natural) {
      this._mistake(`${kind} can’t ride ${LAYER_LABEL[layer] || layer}`);
      const hint = layerHint(kind, natural);
      this.onReject?.(hint);
      this._feedback(`✋ refused: ${hint}`);
      return;
    }

    // 2) wrong WHAT — out of order
    if (kind !== exp.kind) {
      this._mistake(`${kind} isn’t the next step`);
      const tgt = this._dstHost(dst) || this._dstHost(exp.dst);
      if (tgt) this._quip(tgt, wrongWhatQuip(kind, tgt), 0xff7700);
      this._feedback(`🤔 ${kind} is out of order — ${exp.kind} is what comes next.`);
      return;
    }

    // 3) wrong WHO — packet really flies to the wrong host, which complains
    if (dst !== exp.dst) {
      this._mistake(`right packet, wrong host (${this._dstName(dst)})`);
      this._stray(kind, dst);
      this._feedback(`🧭 ${kind} went to ${this._dstName(dst)} — wrong host.`);
      return;
    }

    // ✅ correct
    this._execute(kind, this._dstHost(exp.dst), step);
    this.packetsSent++;
    this._quip(this.player, `📤 ${kind} → ${this._dstName(exp.dst)}`, KIND_COLOR[kind] || 0x41a6ff);
    this._advance();
  }

  hint() {
    const step = this.steps?.[this.stepIndex];
    if (!step || !step.expect) return '';
    this.hintsUsed++;
    this.onState?.();
    return step.hint || '';
  }

  // ---------------------------------------------------------------- correct execution

  _execute(kind, host, step) {
    const e = this.engine, me = this.player;
    let focus = null;                       // flow to pin in the inspector
    switch (kind) {
      case KIND.ARP_REQ: {
        focus = new ArpExchange(e, me, host);
        e.addFlow(focus); focus.open();
        break;
      }
      case KIND.DNS_Q: {
        const domain = this.mission.target === 'media' ? 'media.example' : 'web.example';
        focus = new DnsTransaction(e, me, host, { domain });
        e.addFlow(focus); focus.open();
        break;
      }
      case KIND.ECHO_REQ: {
        focus = new PingFlow(e, me, host, { count: 3 });   // a few echoes so a reply reliably returns
        e.addFlow(focus); focus.open();
        break;
      }
      case KIND.SYN: {
        this.conn = new TcpConnection(e, me, host, {
          manual: true, bytes: this.mission.bytes ?? 0,
          dport: this.mission.target === 'media' ? 1935 : 80,
          label: `role-play ${host.name}`,
        });
        e.addFlow(this.conn);
        this.conn.open();
        focus = this.conn;
        break;
      }
      case KIND.ACK:
        this.conn?.clientAck();
        focus = this.conn;
        break;
      case KIND.REQ:
        this.conn?.clientRequest();
        if (this.mission.streamAfterRequest) {
          this.stream = new MediaStream(e, this.topo.media, me, {
            rate: 14, duration: 60, label: 'live stream',
          });
          e.addFlow(this.stream);
          this.stream.open();
          focus = this.stream;
        } else {
          focus = this.conn;
        }
        break;
      case KIND.FIN:
        this.conn?.clientFin();
        focus = this.conn;
        break;
      default:
        break;
    }
    if (focus) this.inspector?.selectFlow?.(focus);
  }

  // ---------------------------------------------------------------- step machine

  _advance() {
    this.stepIndex++;
    this._enterStep();
  }

  _enterStep() {
    const step = this.steps[this.stepIndex];
    if (!step) { this._complete(); return; }
    this._feedback(step.prompt);
    this.onState?.();
  }

  /** Server-side answers arrive here (called from main's engine.onDeliver). */
  observeDeliver(pkt) {
    if (!this.active || this.done) return;
    if (pkt.dst !== this.player) return;
    const step = this.steps[this.stepIndex];
    if (!step || !step.auto) return;
    if (step.auto === KIND.DATA) return;     // resolved by transfer progress in update()
    if (step.auto === pkt.kind) {
      this._feedback('✅ ' + step.prompt);
      this._advance();
    }
  }

  update() {
    if (!this.active || this.done) return;
    const step = this.steps[this.stepIndex];
    if (step && step.auto === KIND.DATA && this.conn && this.conn.progress >= 1) {
      this._feedback('✅ ' + step.prompt);
      this._advance();
    }
  }

  _complete() {
    this.done = true;
    const secs = this.engine.time - this.startedAt;
    const penalty = this.mistakes + this.hintsUsed * 0.5;
    const grade = penalty === 0 ? 'S' : penalty <= 1 ? 'A' : penalty <= 3 ? 'B' : 'C';
    const stats = {
      title: this.mission.title,
      packets: this.packetsSent,
      mistakes: this.mistakes,
      hints: this.hintsUsed,
      secs,
      grade,
    };
    this.engine.log(`★ mission complete — grade ${grade} (${this.packetsSent} sent, ${this.mistakes} mistakes)`, 'ok');
    this._quip(this.player, `★ ${grade}`, 0x00ff88, 6);
    this.onComplete?.(stats);
    this.onState?.();
  }

  // ---------------------------------------------------------------- consequences / banter

  _stray(kind, dstKey) {
    const host = this._dstHost(dstKey);
    if (!host) return;
    const proto = PROTO_FOR_KIND[kind] || 'TCP';
    const o = {
      src: this.player, dst: host, proto, kind, ttl: 64,
      len: kind === KIND.REQ ? 312 : 0,
      note: `misdirected ${kind} — wrong host`,
    };
    if (proto === 'ICMP') { o.icmpType = 8; o.icmpId = (Math.random() * 0xffff) | 0; o.len = 56; }
    this.engine.send(new Packet(o));
    this._quip(host, wrongHostQuip(kind, host), 0xff4488);
  }

  _mistake(reason) {
    this.mistakes++;
    this.engine.log(`✖ role-play: ${reason}`, 'warn');
    this.onState?.();
  }

  _quip(host, text, color, dur = 5) {
    this.onActivity?.(host, text, color, dur);
  }

  _feedback(text) {
    this.lastFeedback = text;
    this.onState?.();
  }

  // ---------------------------------------------------------------- helpers / state

  _dstHost(key) {
    switch (key) {
      case 'broadcast': case 'router': return this.topo.router;
      case 'dns': return this.topo.dns;
      case 'web': return this.topo.web;
      case 'media': return this.topo.media;
      default: return null;
    }
  }

  _dstName(key) {
    if (key === 'broadcast') return 'broadcast';
    return this._dstHost(key)?.name || key;
  }

  /** Snapshot for the action deck. */
  getState() {
    return {
      active: this.active,
      done: this.done,
      mission: this.mission,
      steps: this.steps || [],
      stepIndex: this.stepIndex,
      mistakes: this.mistakes,
      hints: this.hintsUsed,
      packets: this.packetsSent,
      feedback: this.lastFeedback,
      player: this.player,
    };
  }
}

// ---------------------------------------------------------------- quip text

function wrongHostQuip(kind, host) {
  const byHost = {
    'CORE-RTR': '🚦 I forward packets, I don’t serve them — try a server',
    'DNS-CORE': '🧐 do I look like I run TCP? I map names to IPs',
    'WEB-EDGE': '🌐 wrong window, friend — that’s not for me',
    'MEDIA-RELAY': '🎬 you knocked on the wrong door',
  };
  if (kind === KIND.DNS_Q && host.name !== 'DNS-CORE') return '🧐 do I look like a phone book? ask DNS-CORE';
  if (kind === KIND.SYN && host.name === 'CORE-RTR') return '🤝 a handshake? I just route, I don’t listen';
  return byHost[host.name] || '🤨 you’ve got the wrong host';
}

function wrongWhatQuip(kind, host) {
  if (kind === KIND.SYN) return '🤝 a handshake already? you don’t even know my IP yet';
  if (kind === KIND.ACK) return '🤨 ACK what? we haven’t shaken hands';
  if (kind === KIND.REQ) return '🛑 slow down — there’s no connection yet';
  return '🤔 that’s out of order — you skipped a step';
}

function layerHint(kind, natural) {
  const map = {
    [KIND.ARP_REQ]: 'ARP never leaves the link — it lives in L2.',
    [KIND.ECHO_REQ]: 'Ping is ICMP — that’s the L3 network layer.',
    [KIND.DNS_Q]: 'DNS is a single UDP datagram — pick L4 · UDP.',
  };
  return map[kind] || 'TCP segments fly in the L4 · TCP lane.';
}
