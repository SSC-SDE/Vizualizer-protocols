// "Be the Client" role-play missions. Each mission is a declarative script of
// steps. A step is either:
//   { expect: { kind, dst, layer }, prompt, hint, wrong }  — the player must
//     dispatch this exact (WHAT, WHO, LAYER) triple to advance.
//   { auto: 'KIND', prompt }                                — the engine answers
//     on its own (server-side); the step advances when that packet comes back.
//
// `dst` keys: 'broadcast' | 'router' | 'dns' | 'web' | 'media'.
// `layer` keys mirror engine.layerOf: 'L2' | 'L3' | 'L4_UDP' | 'L4_TCP'.

import { KIND } from '../sim/engine.js';

export const MISSIONS = {
  ping: {
    title: '🩺 Is the server even up?',
    blurb: 'Shortest mission — a good first pick. Resolve the gateway, then ping.',
    intro: 'You just want to know if WEB-EDGE answers. But you can’t even send IP yet — first you need the gateway’s hardware address.',
    target: 'web',
    steps: [
      { expect: { kind: KIND.ARP_REQ, dst: 'broadcast', layer: 'L2' },
        prompt: 'You know the gateway IP (10.0.0.1) but not its MAC.',
        hint: 'ARP lives at L2. Broadcast a "who-has 10.0.0.1?" to the whole segment.' },
      { auto: KIND.ARP_REP, prompt: 'CORE-RTR answers unicast: "10.0.0.1 is-at …". Gateway MAC learned.' },
      { expect: { kind: KIND.ECHO_REQ, dst: 'web', layer: 'L3' },
        prompt: 'Now ask WEB-EDGE directly: "are you alive?"',
        hint: 'Ping is ICMP — pure Layer 3, no ports, no handshake. Send an ECHO-REQ to WEB-EDGE.' },
      { auto: KIND.ECHO_REP, prompt: 'Echo reply is back — read the RTT. The server is up. 🎉' },
    ],
  },

  liveStream: {
    title: '📺 Watch a live stream',
    blurb: 'The flagship. Build ARP → DNS → handshake → request → stream → teardown by hand.',
    intro: 'Your user clicked play on a live stream from media.example. Nothing works yet — not even ARP.',
    target: 'media',
    bytes: 0,
    streamAfterRequest: true,
    steps: [
      { expect: { kind: KIND.ARP_REQ, dst: 'broadcast', layer: 'L2' },
        prompt: 'You know the gateway IP (10.0.0.1) but not its MAC.',
        hint: 'L2 broadcast: "who has 10.0.0.1?" — every machine hears it, only the gateway answers.' },
      { auto: KIND.ARP_REP, prompt: 'Reply comes back unicast — gateway MAC cached. 🧠' },
      { expect: { kind: KIND.DNS_Q, dst: 'dns', layer: 'L4_UDP' },
        prompt: 'You have a name, media.example — but the stack needs an IP.',
        hint: 'Names → IPs first. Send a DNS query (UDP/53) to DNS-CORE.' },
      { auto: KIND.DNS_R, prompt: 'DNS-CORE replies — now you know MEDIA-RELAY’s address.' },
      { expect: { kind: KIND.SYN, dst: 'media', layer: 'L4_TCP' },
        prompt: 'Open the control channel to MEDIA-RELAY.',
        hint: 'A TCP connection starts with a SYN (L4-TCP) to MEDIA-RELAY.' },
      { auto: KIND.SYNACK, prompt: 'MEDIA-RELAY sends SYN-ACK — its half of the handshake.' },
      { expect: { kind: KIND.ACK, dst: 'media', layer: 'L4_TCP' },
        prompt: 'Complete the handshake.',
        hint: 'Acknowledge the server’s ISN with an ACK — connection becomes ESTABLISHED.' },
      { expect: { kind: KIND.REQ, dst: 'media', layer: 'L4_TCP' },
        prompt: 'Ask it to start playing.',
        hint: 'The app-layer REQUEST rides the established TCP pipe to MEDIA-RELAY.' },
      { auto: KIND.STREAM, prompt: 'Media frames pour in — and notice they’re UDP, not TCP. Speed over perfection.' },
      { expect: { kind: KIND.FIN, dst: 'media', layer: 'L4_TCP' },
        prompt: 'Done watching — tear the control channel down politely.',
        hint: 'A polite teardown starts with a FIN (L4-TCP) to MEDIA-RELAY.' },
      { auto: KIND.FIN, prompt: 'Server FIN-ACKs back, you send the final ACK — connection closed cleanly. 🎉' },
    ],
  },

  webPage: {
    title: '🌐 Load a web page',
    blurb: 'Like the stream, but the payload is a real TCP download with sliding-window ACKs.',
    intro: 'Your user typed a URL. Resolve it, handshake, request — then watch TCP actually move bytes.',
    target: 'web',
    bytes: 90 * 1024,
    steps: [
      { expect: { kind: KIND.ARP_REQ, dst: 'broadcast', layer: 'L2' },
        prompt: 'Gateway MAC unknown — resolve it first.',
        hint: 'L2 broadcast "who-has 10.0.0.1?" before any IP traffic.' },
      { auto: KIND.ARP_REP, prompt: 'Gateway MAC cached.' },
      { expect: { kind: KIND.DNS_Q, dst: 'dns', layer: 'L4_UDP' },
        prompt: 'Turn the hostname into an IP.',
        hint: 'DNS query (UDP/53) to DNS-CORE.' },
      { auto: KIND.DNS_R, prompt: 'WEB-EDGE’s IP resolved.' },
      { expect: { kind: KIND.SYN, dst: 'web', layer: 'L4_TCP' },
        prompt: 'Start the TCP handshake with WEB-EDGE.',
        hint: 'SYN (L4-TCP) to WEB-EDGE.' },
      { auto: KIND.SYNACK, prompt: 'SYN-ACK from WEB-EDGE.' },
      { expect: { kind: KIND.ACK, dst: 'web', layer: 'L4_TCP' },
        prompt: 'Finish the handshake.',
        hint: 'ACK the server’s ISN — ESTABLISHED.' },
      { expect: { kind: KIND.REQ, dst: 'web', layer: 'L4_TCP' },
        prompt: 'Send the GET request.',
        hint: 'REQUEST over the TCP pipe to WEB-EDGE.' },
      { auto: KIND.DATA, prompt: 'WEB-EDGE streams the page in MSS-sized segments; your stack ACKs each — the sliding window in action.' },
      { expect: { kind: KIND.FIN, dst: 'web', layer: 'L4_TCP' },
        prompt: 'Page delivered — close the connection.',
        hint: 'FIN (L4-TCP) to WEB-EDGE for a clean teardown.' },
      { auto: KIND.FIN, prompt: 'Four-way close complete. 🎉' },
    ],
  },

  lossy: {
    title: '🌩 Survive packet loss',
    blurb: 'A web-page load, but the wire is hostile. Lost handshakes and ACKs fight back.',
    intro: 'Same goal as a page load — but 35% of packets are dying. Watch how TCP grinds through it anyway.',
    target: 'web',
    bytes: 120 * 1024,
    lossBurst: { rate: 0.35, secs: 60 },
    steps: null,   // filled below — identical script to webPage
  },
};

// lossy reuses the web-page script verbatim
MISSIONS.lossy.steps = MISSIONS.webPage.steps;

export const MISSION_ORDER = ['ping', 'liveStream', 'webPage', 'lossy'];
