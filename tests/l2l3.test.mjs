import { Engine, Host } from '../js/sim/engine.js';
import { TcpConnection } from '../js/sim/tcp.js';
import { ArpExchange, PingFlow, TracerouteFlow } from '../js/sim/l2l3.js';

function mk(lossRate) {
  const e = new Engine();
  e.lossRate = lossRate;
  const web = e.addHost(new Host('WEB', '203.0.113.10', 'server', { x: 0, y: 5, z: 0 }));
  const rtr = e.addHost(new Host('RTR', '10.0.0.1', 'router', { x: 0, y: 13, z: 6 }));
  e.router = rtr;
  const c = e.addHost(new Host('c1', '10.0.0.11', 'client', { x: 27, y: 2, z: 0 }));
  return { e, web, rtr, c };
}
const run = (e, secs) => { for (let t = 0; t < secs * 20; t++) e.update(0.05); };
let ok = true;
const check = (name, errs) => { console.log(errs.length ? `FAIL ${name}: ${errs.join('; ')}` : `PASS ${name}`); if (errs.length) ok = false; };

{ // TCP through router, lossy
  const { e, web, c } = mk(0.08);
  const conn = new TcpConnection(e, c, web, { bytes: 300 * 1024 });
  e.addFlow(conn); conn.open();
  run(e, 600);
  const errs = [];
  if (!conn.finished) errs.push(`not finished c=${conn.cstate} s=${conn.sstate} una=${conn.snd_una}/${conn.totalBytes}`);
  if (conn.finished && conn.rcv_nxt !== conn.totalBytes) errs.push('bytes mismatch');
  check('TCP via router, 8% loss', errs);
}
{ // ARP resolve with loss + callback
  const { e, rtr, c } = mk(0.2);
  let resolved = false;
  const arp = new ArpExchange(e, c, rtr, () => resolved = true);
  e.addFlow(arp); arp.open();
  run(e, 30);
  const errs = [];
  if (!resolved) errs.push('callback never fired');
  if (arp.state !== 'RESOLVED' && arp.state !== 'INCOMPLETE') errs.push(`state ${arp.state}`);
  check('ARP with 20% loss', errs);
}
{ // ping
  const { e, web, c } = mk(0.1);
  const p = new PingFlow(e, c, web, { count: 5 });
  e.addFlow(p); p.open();
  run(e, 60);
  const errs = [];
  if (p.state !== 'DONE' && !p.dead) errs.push(`state ${p.state}`);
  if (p.rtts.length + p.lost !== p.count) errs.push(`accounting ${p.rtts.length}+${p.lost}!=${p.count}`);
  check('ping 10% loss', errs);
}
{ // traceroute
  const { e, web, rtr, c } = mk(0.05);
  const tr = new TracerouteFlow(e, c, web, rtr);
  e.addFlow(tr); tr.open();
  run(e, 60);
  const errs = [];
  if (tr.state !== 'DONE' && !tr.dead) errs.push(`state ${tr.state} hop=${tr.hopIdx} pending=${tr.pending.size}`);
  const h1 = tr.hopRtts[0].filter(r => !isNaN(r)).length;
  const h2 = tr.hopRtts[1].filter(r => !isNaN(r)).length;
  if (h1 === 0) errs.push('no TTL-exceeded replies from router');
  if (h2 === 0) errs.push('no port-unreachable from server');
  check('traceroute 2 hops', errs);
}
process.exit(ok ? 0 : 1);
