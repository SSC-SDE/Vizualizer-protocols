// Server role-play tests: golden sequence completes each server mission (incl. the
// manual-server TCP machine), and each category of wrong response is rejected.

import { Engine, Host, KIND } from '../js/sim/engine.js';
import { ServerRolePlayDirector } from '../js/app/serverroleplay.js';

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

function newSP() {
  const e = new Engine();
  const topo = buildTopo(e);
  const sp = new ServerRolePlayDirector(e, topo, {});
  e.onDeliver = (p) => sp.observeDeliver(p);
  return { e, sp };
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ pass: !!cond });
  if (!cond) console.log(`FAIL ${name} ${detail}`);
}

function runMission(key, simSeconds) {
  const { e, sp } = newSP();
  sp.enter(key);
  let last = -1;
  for (let t = 0; t < simSeconds * 20 && !sp.done; t++) {
    const step = sp.steps[sp.stepIndex];
    if (step && step.expect && sp.stepIndex !== last) {
      last = sp.stepIndex;
      sp.dispatch({ kind: step.expect.kind, dst: step.expect.dst, layer: step.expect.layer });
    }
    e.update(0.05);
    sp.update();
  }
  return sp;
}

for (const [key, secs, expected] of [['acceptConn', 400, 3], ['answerPing', 60, 1], ['beDNS', 60, 1]]) {
  const sp = runMission(key, secs);
  check(`server ${key} completes`, sp.done, `(stepIndex ${sp.stepIndex}/${sp.steps.length})`);
  check(`server ${key} no mistakes`, sp.mistakes === 0, `(mistakes ${sp.mistakes})`);
  check(`server ${key} sent ${expected}`, sp.packetsSent === expected, `(${sp.packetsSent} != ${expected})`);
}

// manual-server TCP actually serves + closes
{
  const sp = runMission('acceptConn', 400);
  check('manual-server transfer complete', sp.conn && sp.conn.snd_una >= sp.conn.totalBytes, `(${sp.conn?.snd_una}/${sp.conn?.totalBytes})`);
  check('manual-server closed', sp.conn && sp.conn.finished, `(c=${sp.conn?.cstate} s=${sp.conn?.sstate})`);
}

// reject wrong responses on the ping mission
function pingAtExpect() {
  const { sp } = newSP();
  sp.enter('answerPing');
  sp.observeDeliver({ dst: sp.player, kind: KIND.ECHO_REQ });   // advance to the reply step
  return sp;
}
{
  const sp = pingAtExpect();
  sp.dispatch({ kind: KIND.ECHO_REP, dst: 'requester', layer: 'L4_TCP' });   // wrong layer
  check('server wrong layer mistake', sp.mistakes === 1 && sp.stepIndex === 1, `(m ${sp.mistakes}, idx ${sp.stepIndex})`);
}
{
  const sp = pingAtExpect();
  sp.dispatch({ kind: KIND.SYNACK, dst: 'requester', layer: 'L4_TCP' });      // wrong WHAT
  check('server wrong what mistake', sp.mistakes === 1 && sp.stepIndex === 1, `(m ${sp.mistakes}, idx ${sp.stepIndex})`);
}
{
  const sp = pingAtExpect();
  sp.dispatch({ kind: KIND.ECHO_REP, dst: 'router', layer: 'L3' });           // wrong WHO
  check('server wrong who mistake', sp.mistakes === 1 && sp.stepIndex === 1, `(m ${sp.mistakes}, idx ${sp.stepIndex})`);
}
{
  const sp = pingAtExpect();
  sp.dispatch({ kind: KIND.ECHO_REP, dst: 'requester', layer: 'L3' });        // correct
  check('server correct completes', sp.done && sp.mistakes === 0, `(done ${sp.done}, m ${sp.mistakes})`);
}

const failed = results.filter(r => !r.pass).length;
console.log(failed ? `FAIL serverroleplay: ${failed}/${results.length} checks failed` : `PASS serverroleplay: ${results.length} checks`);
process.exit(failed ? 1 : 0);
