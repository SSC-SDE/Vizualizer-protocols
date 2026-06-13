# Plan: "Be the Client" Role-Play Mode

Status: **implemented.** Press `P` (or the HUD "🎭 role-play" button), or load
`?mode=roleplay`. Code lives in `js/app/missions.js`, `js/app/roleplay.js`,
`js/ui/actiondeck.js`; the only sim-core change is a `manual: true` option on
`TcpConnection` (pauses the client side at the handshake-ACK / REQUEST / FIN
points so the player drives them). Tests: `tests/roleplay.test.mjs`.

Deviations from the design below: DNS/ARP stay auto-retrying (no `manual` flag —
loss just recovers), the web-page DATA step uses a single cumulative auto-ACK
(client auto-ACKs incoming segments) rather than a manual per-segment ACK, and
camera glide is a simple target lerp.

There is also a second mode, **"Run the server"** (`js/app/serverroleplay.js`,
`SERVER_MISSIONS` in `missions.js`), where you operate a server and answer
incoming clients. It mirrors the client mode through a generalized action deck
(`actiondeck.js` now hosts both directors) and adds a `manualServer: true` option
to `TcpConnection` that pauses the *server* side (SYN-ACK / serve-data / FIN)
while a virtual client drives itself. Server missions: serve a web request (TCP,
flagship), answer a ping (ICMP), be the DNS resolver (UDP). Tests:
`tests/serverroleplay.test.mjs`.

## Concept

A game mode where the user *is* one of the clients. Instead of watching
`TrafficDirector` fire pre-scripted flows, the user picks a goal (e.g. "watch a
live stream") and must manually dispatch every protocol action, in the right
order, to the right host, on the right OSI layer — building the whole exchange
from scratch: ARP → DNS → TCP 3-way handshake → request → stream → teardown.

The sim engine already simulates all of this faithfully (`js/sim/*`); today the
flow classes (`TcpConnection`, `DnsTransaction`, `ArpExchange`, `MediaStream`)
drive themselves. This mode puts the *client side* of those state machines
under user control, while the servers/router keep responding automatically.

## Player loop

1. **Enter mode** — press `P` (or HUD button "ROLE-PLAY"). Ambient traffic is
   dimmed (`director.ambient = 0`), camera glides to a random client, that
   client gets a 👤 marker and a "YOU" label.
2. **Pick a mission** — modal with mission cards (see Missions below).
3. **Dispatch actions** — an "action deck" panel shows every dispatchable
   action (full list, *not* filtered to only-legal ones — choosing wrong is
   the learning mechanic). For each dispatch the user picks three things:
   - **WHAT**: the action (ARP-REQ, DNS-QUERY, SYN, ACK, REQUEST, FIN, …)
   - **WHO**: the destination host (click a host in the 3D scene, or pick from
     a dropdown: CORE-RTR / DNS-CORE / WEB-EDGE / MEDIA-RELAY / broadcast)
   - **LAYER**: which OSI lane it should fly in (L2 / L3 / L4-UDP / L4-TCP)
4. **Judge** — the mission validator checks the triple (what, who, layer)
   against the current step of the mission script:
   - ✅ correct → packet actually dispatched into the engine, server-side
     responds for real (SYN gets a real SYN-ACK, DNS-QUERY gets a real
     DNS-REPLY, …), step advances, progress checklist ticks.
   - ❌ wrong WHO → packet flies to the wrong host and gets an RST /
     no-answer / ICMP unreachable where protocol-appropriate; witty bubble
     from the wrong server ("🧐 wrong window, friend — try DNS-CORE").
   - ❌ wrong LAYER → packet refused at dispatch with a tutor hint
     ("ARP never leaves the link — it lives in L2").
   - ❌ wrong WHAT (out of order, e.g. SYN before DNS) → server bubble
     ("🤔 SYN to whom? you don't even know my IP yet") + hint.
5. **Finish** — when the script completes (e.g. stream delivered + FIN/ACK
   teardown) show a recap: packets sent, mistakes, RTTs, a per-layer replay of
   what the exchange looked like, and a grade (S/A/B/C by mistake count).

## Missions

Each mission is a declarative script of expected steps. Reuse the existing
flow vocabulary (`KIND` in `js/sim/engine.js`).

### Mission 1 — "Watch a live stream" (flagship, the example in the ask)
| # | WHAT | WHO | LAYER | Teaches |
|---|------|-----|-------|---------|
| 1 | ARP-REQ | broadcast (resolves CORE-RTR) | L2 | you need the gateway MAC first |
| 2 | *(auto)* ARP-REP arrives | — | L2 | reply comes back unicast |
| 3 | DNS-QUERY "media.example" | DNS-CORE | L4-UDP | names → IPs before anything else |
| 4 | *(auto)* DNS-REPLY | — | L4-UDP | now you know MEDIA-RELAY's IP |
| 5 | SYN | MEDIA-RELAY | L4-TCP | control channel handshake begins |
| 6 | *(auto)* SYN-ACK arrives | — | L4-TCP | server's half of the handshake |
| 7 | ACK | MEDIA-RELAY | L4-TCP | handshake complete — "sync ack from scratch" |
| 8 | REQUEST ("play stream") | MEDIA-RELAY | L4-TCP | app-layer ask rides the TCP pipe |
| 9 | *(auto)* STREAM packets flow | — | L4-UDP | media itself is UDP, not TCP |
| 10 | FIN | MEDIA-RELAY | L4-TCP | polite teardown of the control channel |
| 11 | *(auto)* FIN/ACK back, ACK auto-completes | — | L4-TCP | full close |

### Mission 2 — "Load a web page"
ARP → DNS-QUERY (WEB-EDGE name) → SYN/SYN-ACK/ACK → REQUEST → DATA+ACKs
(user must ACK received DATA segments — teaches cumulative ACKs) → FIN.

### Mission 3 — "Is the server even up?"
ARP → ECHO-REQ to WEB-EDGE (L3) → read RTT from the ECHO-REP. Short intro
mission; good first pick.

### Mission 4 — "Survive packet loss" (advanced)
Mission 2 but with `engine.lossBurstUntil` armed: lost SYN / lost ACKs force
the user to recognize the timeout and pick RETRANS. Teaches retransmission.

### Step schema (proposed)
```js
// js/app/missions.js
export const MISSIONS = {
  liveStream: {
    title: '📺 Watch a live stream',
    intro: 'Your user clicked play. Nothing works yet — not even ARP.',
    steps: [
      { expect: { kind: 'ARP-REQ', dst: 'broadcast', layer: 'L2' },
        prompt: 'You know the gateway IP (10.0.0.1) but not its MAC.',
        hint:   'L2 broadcast: "who has 10.0.0.1?"',
        wrong:  { dstServer: '…I am not your gateway 🙄' } },
      { auto: 'ARP-REP' },
      { expect: { kind: 'DNS-QUERY', dst: 'dns', layer: 'L4_UDP' },
        prompt: 'You have a name, media.example — but TCP needs an IP.', … },
      // …
    ],
  },
  // webPage, ping, lossy …
};
```

## Architecture

New pieces (no rewrites of the sim core needed):

```
js/app/missions.js      mission scripts (data only)
js/app/roleplay.js      RolePlayDirector — state machine + validator
js/ui/actiondeck.js     action deck panel + WHO/LAYER pickers
css/ (additions)        deck panel, step checklist, "YOU" marker styles
```

### RolePlayDirector (`js/app/roleplay.js`)
- Owns: active mission, current step index, mistake count, the player's
  client `Host`, learned facts (`gatewayMac: bool`, `resolvedIp: bool`).
- `dispatch({ kind, dst, layer })` — the single entry point from the UI:
  1. Validate layer vs kind using existing `layerOf()` logic in reverse
     (ARP→L2, ICMP→L3, DNS/STREAM→L4_UDP, TCP kinds→L4_TCP). Wrong layer =
     rejected at the NIC, no packet flies.
  2. Compare against `steps[i].expect`. Correct → drive the real flow object
     (see below). Wrong-but-plausible → actually send it and let the engine
     show the consequence (RST from a server with no listener, silence + arrow
     to the timeout, ICMP unreachable).
- Drives **real flow classes** rather than faking packets, so the inspector,
  HUD, tutor, and layer-strata glow all keep working untouched:
  - ARP step → `new ArpExchange(engine, you, router)` but `.open()` only
    fires on the player's dispatch.
  - TCP steps → `TcpConnection` needs a small new option, `manual: true`,
    which pauses its client-side state machine at each "client would now
    send X" point and exposes `proceed()` — the only sim-core change.
    Server side stays fully automatic (SYN-ACK, DATA, FIN-ACK).
  - DNS → same pattern on `DnsTransaction` (`manual: true` skips auto-retry;
    timeouts surface as a "your query died, send it again" hint).
  - Stream → `MediaStream` unchanged (server-pushed; step 9 is watch-only).
- Emits events the UI consumes: `onStep(step)`, `onMistake(reason)`,
  `onComplete(stats)`.

### Action deck UI (`js/ui/actiondeck.js`)
- Bottom-center panel, visible only in role-play mode.
- **WHAT**: a button per dispatchable `KIND` — `ARP-REQ`, `DNS-QUERY`,
  `ECHO-REQ`, `SYN`, `ACK`, `REQUEST`, `DATA`, `RETRANS`, `FIN`, `RST` —
  each tinted with its `KIND_COLOR`, full list always shown.
- **WHO**: after picking WHAT, hosts become click-targets in the 3D scene
  (reuse `world.onPickHost`); a fallback dropdown lists router/servers +
  "broadcast". Player's own client excluded.
- **LAYER**: four chips (L2 / L3 / UDP / TCP) colored with `LAYER_META`;
  picking one arms the dispatch button.
- Right side: mission checklist (steps grey → green), mistake counter, hint
  button (reveals `step.hint`, costs half a grade).
- Esc or mode button exits back to normal ambient mode.

### Wiring (`js/main.js`)
```js
const roleplay = new RolePlayDirector(engine, topo, { tutor, world, controls });
const deck = new ActionDeck(roleplay, world);
roleplay.onActivity = director.onActivity;   // reuse speech bubbles for banter
```
- Keyboard: `P` toggles mode. Entering mode: `controls.setAmbient(0)`, store
  previous value, restore on exit. `controls.onReset` also exits role-play.
- Server quips (`_quipTick`) keep running — they're ambient flavor.

## Feedback & fun

- Wrong-host dispatches get scene-matching bubbles from the *receiving* host:
  WEB-EDGE on a stray DNS query → "🧐 do I look like a phone book?";
  MEDIA-RELAY on a premature SYN → "🤝 a handshake? we haven't even met";
  CORE-RTR on a misdirected REQUEST → "🚦 I forward packets, I don't serve them".
- Correct steps get a small celebration bubble on the player client
  ("🧠 gateway MAC learned!", "🎉 handshake complete — connection ESTABLISHED").
- The tutor panel (existing `Tutor`) narrates each *auto* response so the
  user understands what came back and why.

## Milestones

1. **M1 — skeleton**: mode toggle, client takeover, action deck rendering,
   dispatch plumbed to a stub validator that just logs. No sim changes.
2. **M2 — manual flows**: `manual: true` option on `TcpConnection` +
   `DnsTransaction`; Mission 3 (ping) end-to-end as the proof.
3. **M3 — flagship**: Mission 1 (live stream) full script + wrong-answer
   consequences (RST / unreachable / silence) + recap screen.
4. **M4 — polish**: Missions 2 & 4, grades, hints, camera glide, banter
   bubbles, `?mode=roleplay` URL param for demos.
5. **M5 — tests**: `tests/roleplay.test.mjs` — validator accepts the golden
   sequence per mission, rejects each category of wrong dispatch, and the
   manual TCP machine still completes/teardowns cleanly under loss.

## Open questions (decide at implementation time)

- Should ACKs for incoming DATA be one manual ACK per segment (tedious but
  instructive) or a single "ACK what you've received" action? Lean: single
  cumulative ACK action, mission 2 only.
- Time pressure? Optional "the user is getting impatient" timer per step for
  replayability. Default off.
- Multi-mission progression / unlock order, or all open from the start?
  Lean: all open, ping recommended first.
