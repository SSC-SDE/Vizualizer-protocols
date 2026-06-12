# ⏚ WIREDEPTH — 3D Protocol Traffic Visualizer

Every packet is a real protocol event, not an animation. A full TCP/UDP/ICMP/ARP
stack runs in simulation; the 3D scene just shows you the wire.

## Run

```bash
npm start          # python3 -m http.server 8077
# open http://localhost:8077
```

No build step, no dependencies to install — Three.js loads from CDN via import map.

## The airspace is the OSI model

Altitude = layer. Each lane has a faint reference ring:

| Lane | Protocol | What flies there |
|------|----------|------------------|
| top | **TCP** (L4) | SYN/SYN-ACK/ACK handshakes, data comets, dup-ACKs, retransmits, FIN/RST |
| high | **UDP** (L4) | DNS query/reply, RTP-style media frames, traceroute probes |
| low | **ICMP** (L3) | echo request/reply, TTL-exceeded, port-unreachable |
| floor | **ARP** (L2) | who-has broadcasts (floor ripple) and is-at replies, link-local — never crosses the router |

All IP traffic arcs through **CORE-RTR**, the glowing octahedron — hub-and-spoke
instead of arc spaghetti. Lost packets flare red and fall out of the sky.

## What is actually simulated

**TCP (full state machine):** 3-way handshake, sequence/ack arithmetic from random
ISNs, sliding window, Reno congestion control (slow start, AIMD congestion
avoidance, fast retransmit on 3 dup ACKs, fast recovery with window inflation,
NewReno partial-ACK retransmit), RTO from Jacobson/Karels SRTT/RTTVAR with Karn's
algorithm and exponential backoff, delayed ACKs, out-of-order reassembly with dup
ACKs, 4-way FIN teardown, TIME_WAIT, RST on backlog exhaustion. Lost handshake
ACKs, requests and FINs are all retransmitted correctly.

**UDP:** DNS transactions (txid, timeout, retry, SERVFAIL) and RTP-style media
streams (sequence numbers, RFC 3550-style smoothed jitter, unrecovered frame loss).

**ICMP:** ping with per-reply RTT and timeout accounting; traceroute using real
UDP probes to ports 33434+ — TTL=1 dies at the router (type 11 time-exceeded),
TTL=2 reaches the host (type 3/3 port-unreachable).

**ARP:** every client resolves the gateway MAC before its first IP flow (cached
afterwards), with retry on loss. The 9 key re-sweeps the segment.

**Wire model:** distance-based latency with jitter, FIFO per-link ordering,
global + burst loss rates, per-link byte/packet accounting.

## Click things

- **Any packet mid-flight** → frozen capture: Ethernet II + IPv4 + TCP/UDP/ICMP/ARP
  dissection built byte-for-byte (IPv4 and ICMP checksums computed for real),
  hover a field and its bytes light up in the hex dump. TTL shows the router
  decrement; Ethernet dst shows the next-hop MAC.
- **Any flow in the list** → live view: cwnd/ssthresh/in-flight chart, SRTT/RTO,
  dup-ACK and recovery state, and a wire ladder diagram (lost segments marked ✕).
- **Any host** → traffic counters and active flows.

## 🎓 Guide mode (key G)

Spoon-fed learning: hit **G** (or the 🎓 button) and the narrator takes over —
time slows to 0.5×, background traffic is muted, and a card at the bottom
explains every packet of the flow you fire, step by step, in plain language:
SYN ("can we talk?"), slow start, duplicate ACKs, fast retransmit vs RTO, the
four-step goodbye, ARP broadcasts, traceroute's TTL trick, and so on. Tick
**pause at each step** and the sim freezes on every new card until you press
continue — read at your own pace. Each concept is explained once per flow, so
it never spams. `?guide=1&scn=handshake` autostarts a lesson.

## Scenarios (keys 1–9)

1 handshake · 2 file transfer · 3 loss burst (35% for 6 s) · 4 SYN flood
(watch the backlog gauge fill with half-open connections) · 5 DNS storm ·
6 UDP stream · 7 ping · 8 traceroute · 9 ARP sweep

Sliders: time scale, wire loss %, ambient traffic density. Space pauses.
`?scn=download` (etc.) in the URL autostarts a scenario.

## Layout

```
js/sim/    engine, tcp, udp, l2l3, scenarios   — pure simulation, zero rendering deps
js/gfx/    world, packets, paths               — Three.js scene + instanced tracers
js/ui/     hud, inspector                      — telemetry, dissection, ladder
```

The sim layer runs headless — `npm test` soak-tests lossy transfers, floods,
ARP, ping and traceroute without a browser.

Not modeled (knowingly): SACK blocks, window scaling in flight, IP fragmentation,
TCP/UDP checksums (needs pseudo-header), IPv6.
