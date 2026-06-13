// Role-play validator + manual-TCP tests. Drives the RolePlayDirector with no
// rendering: feeds the golden sequence per mission, then probes each category of
// wrong dispatch, and confirms the manual TCP machine completes + tears down.

import { Engine, Host, KIND } from '../js/sim/engine.js';
import { RolePlayDirector } from '../js/app/roleplay.js';
import { MISSIONS } from '../js/app/missions.js';

function buildTopo(e) {
  const web = e.addHost(new Host('WEB-EDGE', '203.0.113.10', 'server', { x: 0, y: 5, z: -10 }));
  const dns = e.addHost(new Host('DNS-CORE', '203.0.113.53', 'server', { x: -15, y: 3.6, z: 8 }));
  const media = e.addHost(new Host('MEDIA-RELAY', '203.0.113.77', 'server', { x: 15, y: 4.2, z: 8 }));
  const router = e.addHost(new Host('CORE-RTR', '10.0.0.1', 'router', { x: 0, y: 13, z: 2 }));
  e.router = router;
  const clients = [];
  for (let i = 0; i < 4; i++) clients.push(e.addHost(new Host(`client-0${i + 1}`, `10.0.0.${11 + i}`, 'client', { x: 30, y: 2, z: i * 3 })));
  return { web, dns, media, router, clients };
}

function newRP() {
  const e = new Engine();
  const topo = buildTopo(e);
  const rp = new RolePlayDirector(e, topo, {});
  e.onDeliver = (p) => rp.observeDeliver(p);
  return { e, rp };
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  if (!cond) console.log(`FAIL ${name} ${detail}`);
}

// ---------------- golden sequence completes every mission ----------------

function runMission(key, simSeconds) {
  const { e, rp } = newRP();
  rp.enter(key);
  let last = -1;
  for (let t = 0; t < simSeconds * 20 && !rp.done; t++) {
    const step = rp.steps[rp.stepIndex];
    if (step && step.expect && rp.stepIndex !== last) {
      last = rp.stepIndex;
      rp.dispatch({ kind: step.expect.kind, dst: step.expect.dst, layer: step.expect.layer });
    }
    e.update(0.05);
    rp.update();
  }
  return rp;
}

for (const [key, secs] of [['ping', 120], ['liveStream', 200], ['webPage', 600]]) {
  const rp = runMission(key, secs);
  check(`golden ${key} completes`, rp.done, `(stepIndex ${rp.stepIndex}/${rp.steps.length})`);
  check(`golden ${key} no mistakes`, rp.mistakes === 0, `(mistakes ${rp.mistakes})`);
  const expected = MISSIONS[key].steps.filter(s => s.expect).length;
  check(`golden ${key} sent every action`, rp.packetsSent === expected, `(${rp.packetsSent} != ${expected})`);
}

// manual TCP actually finishes + tears down cleanly (webPage)
{
  const { e, rp } = newRP();
  rp.enter('webPage');
  let last = -1;
  for (let t = 0; t < 600 * 20 && !rp.done; t++) {
    const step = rp.steps[rp.stepIndex];
    if (step && step.expect && rp.stepIndex !== last) {
      last = rp.stepIndex;
      rp.dispatch({ kind: step.expect.kind, dst: step.expect.dst, layer: step.expect.layer });
    }
    e.update(0.05);
    rp.update();
  }
  check('manual TCP transfer complete', rp.conn && rp.conn.snd_una >= rp.conn.totalBytes, `(${rp.conn?.snd_una}/${rp.conn?.totalBytes})`);
  check('manual TCP closed', rp.conn && rp.conn.finished && rp.conn.cstate === 'CLOSED', `(c=${rp.conn?.cstate})`);
}

// ---------------- rejects every category of wrong dispatch ----------------

// wrong LAYER — refused at the NIC, nothing advances
{
  const { rp } = newRP();
  rp.enter('ping');
  rp.dispatch({ kind: KIND.ARP_REQ, dst: 'broadcast', layer: 'L4_TCP' });
  check('wrong layer counts a mistake', rp.mistakes === 1, `(${rp.mistakes})`);
  check('wrong layer does not advance', rp.stepIndex === 0, `(${rp.stepIndex})`);
}

// wrong WHAT — out of order
{
  const { rp } = newRP();
  rp.enter('ping');
  rp.dispatch({ kind: KIND.SYN, dst: 'web', layer: 'L4_TCP' });   // SYN before ARP
  check('wrong what counts a mistake', rp.mistakes === 1, `(${rp.mistakes})`);
  check('wrong what does not advance', rp.stepIndex === 0, `(${rp.stepIndex})`);
}

// wrong WHO — right packet, wrong host
{
  const { rp } = newRP();
  rp.enter('liveStream');
  // advance to the DNS step the legit way (ARP first)
  rp.dispatch({ kind: KIND.ARP_REQ, dst: 'broadcast', layer: 'L2' });
  // force-resolve the auto ARP-REP without waiting on the wire
  rp.observeDeliver({ dst: rp.player, kind: KIND.ARP_REP });
  const at = rp.stepIndex;
  rp.dispatch({ kind: KIND.DNS_Q, dst: 'web', layer: 'L4_UDP' });   // DNS query to the wrong server
  check('wrong who counts a mistake', rp.mistakes === 1, `(${rp.mistakes})`);
  check('wrong who does not advance', rp.stepIndex === at, `(${rp.stepIndex} != ${at})`);
}

// correct dispatch advances
{
  const { rp } = newRP();
  rp.enter('ping');
  rp.dispatch({ kind: KIND.ARP_REQ, dst: 'broadcast', layer: 'L2' });
  check('correct dispatch advances', rp.stepIndex === 1 && rp.mistakes === 0, `(idx ${rp.stepIndex}, m ${rp.mistakes})`);
}

const failed = results.filter(r => !r.pass).length;
console.log(failed ? `FAIL roleplay: ${failed}/${results.length} checks failed` : `PASS roleplay: ${results.length} checks`);
process.exit(failed ? 1 : 0);
