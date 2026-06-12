// Guide mode: a narrator that turns wire events into a step-by-step lesson.
// It follows one flow at a time, explains each packet in plain language as it
// launches, slows the simulation down, and can pause at every step.

import { KIND } from '../sim/engine.js';

const MIN_CARD_TIME = 5;        // seconds a card stays before the next one shows
const GUIDE_SPEED = 0.5;

// ---------------------------------------------------------------- lesson text

const LESSONS = {
  welcome: {
    chip: 'GUIDE', color: '#ffd24d', title: 'Welcome to guide mode',
    body: 'Time is slowed and background traffic is muted so nothing distracts. ' +
      'Press <b>1</b> for the classic TCP handshake lesson, <b>7</b> for ping, <b>8</b> for traceroute, ' +
      'or <b>9</b> to watch ARP work at layer 2. Tick “pause at each step” below if you want to read at your own pace.',
  },

  // ----- TCP -----
  syn: {
    chip: 'STEP 1', color: '#00ff88', title: 'SYN — “Can we talk?”',
    body: 'The client launches a <b>SYN</b> packet (green comet, top lane). It carries no data — just a random ' +
      'starting sequence number (the ISN) so both sides can count every byte that follows. Watch it arc through the router.',
  },
  synack: {
    chip: 'STEP 2', color: '#00ffcc', title: 'SYN-ACK — “Yes. Here’s my number.”',
    body: 'The server replies with <b>SYN+ACK</b>: it acknowledges the client’s number (ISN+1) and proposes its own. ' +
      'A connection is really two one-way agreements — this packet handles both at once.',
  },
  'ack-handshake': {
    chip: 'STEP 3', color: '#3d7bff', title: 'ACK — handshake complete',
    body: 'The client acknowledges the server’s number. Three packets total, and both sides now agree how to count ' +
      'bytes in both directions. The flow state in the inspector just turned <b>ESTABLISHED</b>.',
  },
  request: {
    chip: 'STEP 4', color: '#ffe066', title: 'The request',
    body: 'First real data: the client sends a small HTTP-style <b>GET</b> (yellow comet). ' +
      'It is slightly fatter than the handshake packets because it actually carries payload bytes.',
  },
  'data-first': {
    chip: 'STEP 5', color: '#00ccff', title: 'Data flows — carefully at first',
    body: 'The server slices the response into ~1460-byte segments (the <b>MSS</b>) — the big cyan comets. ' +
      'It starts cautiously: the <b>congestion window</b> limits how much can be in flight unacknowledged. ' +
      'Watch the cwnd chart in the inspector climb — that is <b>slow start</b>, doubling every round trip.',
  },
  'ack-data': {
    chip: 'STEP 6', color: '#3d7bff', title: 'ACKs slide the window forward',
    body: 'Every blue dart flying back means “got everything up to byte N”. Each one gives the server permission to ' +
      'send more. Data one way, permission the other — that is the <b>sliding window</b>.',
  },
  drop: {
    chip: 'EVENT', color: '#ff2244', title: '💥 A packet just died',
    body: 'That red flare falling out of the sky was a lost packet. The receiver will keep acknowledging the last byte ' +
      'it got <i>in order</i> — duplicate ACKs. Count them: when the sender sees <b>three</b>, it acts.',
  },
  'fast-retx': {
    chip: 'EVENT', color: '#ff7700', title: '⚡ Fast retransmit',
    body: 'Three duplicate ACKs told the server the receiver is missing exactly one piece. It resends just that segment ' +
      '(orange comet) <i>without waiting for a timeout</i>, and halves its congestion window. ' +
      'Look for the cliff in the cwnd chart — that is the price of one lost packet.',
  },
  rto: {
    chip: 'EVENT', color: '#ff5500', title: '⏱ Retransmission timeout',
    body: 'Silence for too long — the retransmit timer fired. TCP assumes serious congestion: it resends the oldest ' +
      'unacknowledged segment and drops the window all the way to <b>1 MSS</b>, restarting slow start from scratch. ' +
      'This is the slowest, most expensive way to recover.',
  },
  fin: {
    chip: 'STEP 7', color: '#ffaa00', title: 'FIN — the polite goodbye',
    body: 'Every byte delivered and acknowledged. The server sends <b>FIN</b> (“I’m done sending”), the client ACKs it ' +
      'and sends its own FIN back. Each direction closes independently — that is why a clean teardown takes four steps.',
  },
  rst: {
    chip: 'EVENT', color: '#ff2244', title: '✖ RST — slammed shut',
    body: 'No polite goodbye: one side aborted the connection instantly with a <b>reset</b>. ' +
      'You see RSTs on refused ports, protocol errors — and on servers defending themselves during a SYN flood.',
  },

  // ----- DNS -----
  'dns-q': {
    chip: 'L4 UDP', color: '#cc66ff', title: 'DNS — asking for directions',
    body: 'Before connecting to a <i>name</i>, you need an IP. The client sends one small purple datagram to the DNS ' +
      'server (UDP port 53): “what is the address for this domain?” No handshake, no connection — ' +
      'if the answer never comes, it simply asks again.',
  },
  'dns-r': {
    chip: 'L4 UDP', color: '#9d7bff', title: 'DNS reply — directions received',
    body: 'The answer maps the domain to an IP address, with a TTL saying how long to cache it. ' +
      'Two packets total. That is exactly why DNS prefers UDP over TCP: a handshake would triple the cost.',
  },

  // ----- ARP -----
  'arp-req': {
    chip: 'L2 LINK', color: '#9dff57', title: 'ARP — finding a neighbor’s hardware address',
    body: 'IP addresses don’t move frames on a local network — <b>MAC addresses</b> do. The client shouts on the floor ' +
      'lane: “who has 10.0.0.1?” It is a broadcast — the green ripple is every machine on the segment hearing it. ' +
      'Only the owner answers.',
  },
  'arp-rep': {
    chip: 'L2 LINK', color: '#57ff9d', title: 'ARP reply — “is-at”',
    body: 'The router answers with its MAC address. The client caches the mapping, and from now on every packet ' +
      'bound for the internet is wrapped in an Ethernet frame addressed to that MAC. ' +
      'Click any packet and look at the Layer 2 section — the next-hop MAC is right there.',
  },

  // ----- ICMP -----
  'echo-req': {
    chip: 'L3 ICMP', color: '#fafafa', title: 'Ping — “are you alive?”',
    body: 'The white comet is an ICMP <b>echo request</b> — pure layer 3. No ports, no connection, just a typed message ' +
      'to the IP stack itself. The target copies the payload straight back.',
  },
  'echo-rep': {
    chip: 'L3 ICMP', color: '#bfd8d8', title: 'Pong — round-trip time measured',
    body: 'The reply is back. Time from request to reply = <b>RTT</b>, the number every gamer and network engineer ' +
      'watches. That is the whole trick — ping is two packets and a stopwatch.',
  },
  probe1: {
    chip: 'STEP 1', color: '#d8c869', title: 'Traceroute — a probe built to die',
    body: 'The trick: send a UDP probe with <b>TTL = 1</b>. Every router must decrement TTL by one; at zero, the packet ' +
      'is destroyed. So this probe cannot survive past the first hop — and that is exactly the point.',
  },
  'ttl-exc': {
    chip: 'STEP 2', color: '#ff8866', title: 'TTL exceeded — hop #1 confesses',
    body: 'The router discarded the probe, but ICMP obliges it to say so: <b>“time exceeded in transit”</b>. ' +
      'That error message carries the router’s own address — hop #1 identified, RTT measured.',
  },
  probe2: {
    chip: 'STEP 3', color: '#d8c869', title: 'Next probe — TTL = 2',
    body: 'Now a probe that survives one decrement. It passes the router (TTL 2 → 1) and reaches the destination — ' +
      'aimed at a port chosen to be closed (33434+).',
  },
  unreach: {
    chip: 'STEP 4', color: '#ff4488', title: 'Port unreachable — destination reached',
    body: 'The server rejects the probe with ICMP <b>“port unreachable”</b> — and that error is good news: ' +
      'only the final destination sends it. The path is fully mapped, one hop per TTL value.',
  },

  // ----- streaming -----
  stream: {
    chip: 'L4 UDP', color: '#ff66cc', title: 'UDP streaming — speed over perfection',
    body: 'Pink frames at a constant rate, sequence-numbered but <b>never retransmitted</b>. A lost frame is a glitch ' +
      'in the video, not a pause. Compare with TCP next door, which would rather stall than lose a byte.',
  },

  // ----- scenarios -----
  synflood: {
    chip: 'ATTACK', color: '#ff2244', title: 'SYN flood — the half-open attack',
    body: 'The red tetrahedrons are bots with <b>spoofed addresses</b>. Each sends a SYN and vanishes. The server ' +
      'politely answers SYN-ACK and waits for step 3… which never comes. Every wait occupies a backlog slot — ' +
      'watch the <b>SYN backlog</b> gauge in the stats panel fill up.',
  },
  'synflood-full': {
    chip: 'ATTACK', color: '#ff2244', title: 'Backlog nearly full',
    body: 'The server keeps retransmitting SYN-ACKs into the void (each retry waits longer — exponential backoff). ' +
      'When the backlog is full it starts <b>RST-ing legitimate clients</b>. This attack is why SYN cookies were invented.',
  },
  lossburst: {
    chip: 'STRESS', color: '#ff7700', title: 'Loss burst — 35% of packets will die',
    body: 'For six seconds the wire becomes hostile. Watch the difference in coping strategies: TCP flows stumble ' +
      '(duplicate ACKs, orange retransmits, cwnd cliffs) but deliver everything; UDP streams just lose frames forever.',
  },
};

// kind → topic resolution for followed-flow packets
function topicFor(pkt, f) {
  switch (pkt.kind) {
    case KIND.SYN: return 'syn';
    case KIND.SYNACK: return 'synack';
    case KIND.ACK:
      if (f && f.proto === 'TCP') return f.snd_nxt === 0 ? 'ack-handshake' : 'ack-data';
      return null;
    case KIND.REQ: return 'request';
    case KIND.DATA: return 'data-first';
    case KIND.RETRANS: return (f && /RTO/.test(f.eventNote)) ? 'rto' : 'fast-retx';
    case KIND.FIN: return 'fin';
    case KIND.RST: return 'rst';
    case KIND.DNS_Q: return 'dns-q';
    case KIND.DNS_R: return 'dns-r';
    case KIND.ARP_REQ: return 'arp-req';
    case KIND.ARP_REP: return 'arp-rep';
    case KIND.ECHO_REQ: return 'echo-req';
    case KIND.ECHO_REP: return 'echo-rep';
    case KIND.PROBE: return pkt.ttl === 1 ? 'probe1' : 'probe2';
    case KIND.TTL_EXC: return 'ttl-exc';
    case KIND.UNREACH: return 'unreach';
    case KIND.STREAM: return 'stream';
    default: return null;
  }
}

// ---------------------------------------------------------------- tutor

export class Tutor {
  /**
   * controls: {setPaused, setSpeed, setAmbient, getSpeed, getAmbient}
   */
  constructor(engine, controls) {
    this.engine = engine;
    this.controls = controls;
    this.enabled = false;
    this.follow = null;            // the flow being narrated
    this.queue = [];
    this.current = null;
    this.shownFor = 0;
    this.waiting = false;          // paused on a step, waiting for continue
    this._saved = null;
    this._floodWarned = false;

    this.panel = document.getElementById('hud-tutor');
    this.chipEl = document.getElementById('tutor-chip');
    this.titleEl = document.getElementById('tutor-title');
    this.bodyEl = document.getElementById('tutor-body');
    this.progressEl = document.getElementById('tutor-progress');
    this.stepPauseEl = document.getElementById('tutor-steppause');
    this.continueBtn = document.getElementById('tutor-continue');
    this.btn = document.getElementById('btn-guide');

    this.btn.onclick = () => this.toggle();
    this.continueBtn.onclick = () => this._continue();
    document.getElementById('tutor-exit').onclick = () => this.disable();
  }

  toggle() { this.enabled ? this.disable() : this.enable(); }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this._saved = { speed: this.controls.getSpeed(), ambient: this.controls.getAmbient() };
    this.controls.setSpeed(GUIDE_SPEED);
    this.controls.setAmbient(0);
    this.panel.hidden = false;
    this.btn.classList.add('active');
    this.queue = [];
    this.current = null;
    this.follow = null;
    this._show('welcome');
    this.engine.log('🎓 guide mode on — events will be explained step by step', 'ok');
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.waiting) this._continue();
    this.controls.setSpeed(this._saved.speed);
    this.controls.setAmbient(this._saved.ambient);
    this.panel.hidden = true;
    this.btn.classList.remove('active');
    this.engine.log('🎓 guide mode off', '');
  }

  // ---------------- event intake ----------------

  onScenario(name, flow) {
    if (!this.enabled) return;
    if (flow) {
      this.follow = flow;
      this.queue = [];                       // new lesson, clean slate
    }
    if (name === 'synflood') { this._floodWarned = false; this._push('synflood'); }
    if (name === 'lossburst') this._push('lossburst');
  }

  onSend(pkt) {
    if (!this.enabled || !pkt.flow) return;
    const f = pkt.flow;

    // ARP is always narrated — it is short, rare and foundational
    const isArp = f.proto === 'ARP';

    // adopt the first interesting flow if we are not following anything
    if (!isArp) {
      if (!this.follow || this.follow.dead || this.follow.finished) {
        if (f.synFloodVictim) return;        // flood flows are narrated by the scenario card
        this.follow = f;
      }
      if (f !== this.follow) return;
    }

    const topic = topicFor(pkt, f);
    if (!topic) return;
    f._tutorSeen ??= new Set();
    if (f._tutorSeen.has(topic)) return;     // each concept once per flow
    f._tutorSeen.add(topic);
    this._push(topic);
  }

  onDrop(pkt) {
    if (!this.enabled || pkt.flow !== this.follow) return;
    const now = this.engine.time;
    if (this._lastDropCard && now - this._lastDropCard < 12) return;
    this._lastDropCard = now;
    this._push('drop');
  }

  // ---------------- card machinery ----------------

  _push(topic) {
    if (this.current === topic || this.queue.includes(topic)) return;
    this.queue.push(topic);
  }

  _show(topic) {
    const l = LESSONS[topic];
    if (!l) return;
    this.current = topic;
    this.shownFor = 0;
    this.chipEl.textContent = l.chip;
    this.chipEl.style.color = l.color;
    this.chipEl.style.borderColor = l.color;
    this.titleEl.textContent = l.title;
    this.titleEl.style.color = l.color;
    this.bodyEl.innerHTML = l.body;
    // retrigger entrance animation
    this.panel.classList.remove('tutor-pop');
    void this.panel.offsetWidth;
    this.panel.classList.add('tutor-pop');

    if (this.stepPauseEl.checked && topic !== 'welcome') {
      this.waiting = true;
      this.controls.setPaused(true);
      this.continueBtn.hidden = false;
    }
  }

  _continue() {
    this.waiting = false;
    this.continueBtn.hidden = true;
    this.controls.setPaused(false);
  }

  update(dtReal) {
    if (!this.enabled) return;
    if (!this.waiting) this.shownFor += dtReal;

    // SYN flood backlog threshold card
    if (!this._floodWarned && this.engine.synBacklog > this.engine.synBacklogMax * 0.6) {
      this._floodWarned = true;
      this._push('synflood-full');
    }

    if (this.queue.length && this.shownFor >= MIN_CARD_TIME && !this.waiting) {
      this._show(this.queue.shift());
    }
    this.progressEl.textContent = this.queue.length
      ? `${this.queue.length} step${this.queue.length > 1 ? 's' : ''} queued…`
      : '';
  }
}
