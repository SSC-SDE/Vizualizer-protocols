import { Engine, Host } from '../js/sim/engine.js';
import { TcpConnection } from '../js/sim/tcp.js';
import { DnsTransaction, MediaStream } from '../js/sim/udp.js';

function run(name, lossRate, setup, checks, simSeconds = 400) {
  const e = new Engine();
  e.lossRate = lossRate;
  const web = e.addHost(new Host('WEB', '203.0.113.10', 'server', { x: 0, y: 5, z: 0 }));
  const dns = e.addHost(new Host('DNS', '203.0.113.53', 'server', { x: -8, y: 3, z: 4 }));
  const c = e.addHost(new Host('c1', '10.0.0.11', 'client', { x: 27, y: 2, z: 0 }));
  const ctx = setup(e, { web, dns, c });
  for (let t = 0; t < simSeconds * 20; t++) e.update(0.05);
  const errs = checks(e, ctx);
  console.log(errs.length ? `FAIL ${name}: ${errs.join('; ')}` : `PASS ${name}`);
  return errs.length === 0;
}

let ok = true;

ok &= run('clean transfer, 0% loss', 0, (e, h) => {
  const conn = new TcpConnection(e, h.c, h.web, { bytes: 200 * 1024 });
  e.addFlow(conn); conn.open();
  return conn;
}, (e, conn) => {
  const errs = [];
  if (!conn.finished) errs.push(`not finished (c=${conn.cstate} s=${conn.sstate} una=${conn.snd_una}/${conn.totalBytes})`);
  if (conn.snd_una < conn.totalBytes) errs.push('bytes not fully acked');
  if (conn.retxCount > 0) errs.push(`unexpected retx=${conn.retxCount}`);
  if (conn.rcv_nxt !== conn.totalBytes) errs.push(`client rcv_nxt ${conn.rcv_nxt} != ${conn.totalBytes}`);
  return errs;
});

ok &= run('lossy transfer 8%', 0.08, (e, h) => {
  const conn = new TcpConnection(e, h.c, h.web, { bytes: 400 * 1024 });
  e.addFlow(conn); conn.open();
  return conn;
}, (e, conn) => {
  const errs = [];
  if (!conn.finished) errs.push(`not finished (c=${conn.cstate} s=${conn.sstate} una=${conn.snd_una}/${conn.totalBytes} retx=${conn.retxCount} rto=${conn.rto})`);
  if (conn.finished && conn.rcv_nxt !== conn.totalBytes) errs.push(`rcv_nxt ${conn.rcv_nxt} != ${conn.totalBytes}`);
  if (conn.retxCount === 0) errs.push('expected retransmits at 8% loss');
  return errs;
}, 600);

ok &= run('brutal transfer 25%', 0.25, (e, h) => {
  const conn = new TcpConnection(e, h.c, h.web, { bytes: 100 * 1024 });
  e.addFlow(conn); conn.open();
  return conn;
}, (e, conn) => {
  const errs = [];
  if (!conn.finished) errs.push(`not finished (c=${conn.cstate} s=${conn.sstate} una=${conn.snd_una}/${conn.totalBytes} retx=${conn.retxCount})`);
  if (conn.finished && conn.cstate !== 'CLOSED' && conn.cstate !== 'TIME_WAIT') errs.push(`odd cstate ${conn.cstate}`);
  return errs;
}, 900);

ok &= run('DNS with loss', 0.15, (e, h) => {
  const txs = [];
  for (let i = 0; i < 20; i++) { const t = new DnsTransaction(e, h.c, h.dns); e.addFlow(t); t.open(); txs.push(t); }
  return txs;
}, (e, txs) => {
  const errs = [];
  const unresolved = txs.filter(t => t.state === 'QUERYING').length;
  if (unresolved) errs.push(`${unresolved} stuck in QUERYING`);
  return errs;
}, 120);

ok &= run('media stream', 0.1, (e, h) => {
  const s = new MediaStream(e, h.web, h.c, { rate: 20, duration: 15 });
  e.addFlow(s); s.open();
  return s;
}, (e, s) => {
  const errs = [];
  if (s.state !== 'DONE' && !s.dead) errs.push(`stream state ${s.state}`);
  if (s.rxCount === 0) errs.push('nothing received');
  if (s.lostCount === 0) errs.push('expected frame loss at 10%');
  return errs;
}, 60);

ok &= run('SYN flood backlog', 0, (e, h) => {
  const conns = [];
  for (let i = 0; i < 80; i++) {
    const bot = e.addHost(new Host(`bot${i}`, `1.2.3.${i+1}`, 'bot', { x: 40, y: 5, z: 0 }));
    const conn = new TcpConnection(e, bot, h.web, { bytes: 0, synFloodVictim: true });
    e.addFlow(conn); conn.open(); conns.push(conn);
  }
  let peak = 0;
  const orig = e.update.bind(e);
  e.update = (dt) => { orig(dt); peak = Math.max(peak, e.synBacklog); };
  return { conns, getPeak: () => peak };
}, (e, ctx) => {
  const errs = [];
  const peak = ctx.getPeak();
  if (peak < 30) errs.push(`backlog never filled (peak ${peak})`);
  if (peak > e.synBacklogMax) errs.push(`backlog exceeded max (${peak})`);
  if (e.synBacklog !== 0) errs.push(`backlog leaked: ${e.synBacklog} remain`);
  const alive = ctx.conns.filter(c => !c.finished).length;
  if (alive) errs.push(`${alive} flood conns never expired`);
  return errs;
}, 300);

process.exit(ok ? 0 : 1);
