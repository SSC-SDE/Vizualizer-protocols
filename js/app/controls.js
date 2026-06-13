// Control deck: pause / speed / loss / ambient / reset, scenario buttons,
// keyboard shortcuts. Owns playback state; main injects scenarios, tutor
// and the reset routine after wiring.

const $ = (id) => document.getElementById(id);

export const SCENARIO_KEYS = [
  'handshake', 'download', 'lossburst', 'synflood', 'dnsstorm',
  'stream', 'ping', 'traceroute', 'arp',
];

export class Controls {
  constructor(engine, director) {
    this.engine = engine;
    this.director = director;
    this.paused = false;
    this.timeScale = 1;

    // injected by main after construction
    this.scenarios = {};
    this.tutor = null;
    this.onReset = null;
    this.onRoleplay = null;        // P — toggle "be the client" role-play mode

    $('btn-pause').onclick = () => this.togglePause();
    $('btn-reset').onclick = () => this.reset();
    $('sl-speed').oninput = (e) => this.setSpeed(Number(e.target.value));
    $('sl-loss').oninput = (e) => this.setLoss(Number(e.target.value));
    $('sl-ambient').oninput = (e) => this.setAmbient(Number(e.target.value));

    document.querySelectorAll('[data-scn]').forEach(btn => {
      btn.onclick = () => this.fire(btn.dataset.scn);
    });

    addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); this.togglePause(); return; }
      if (e.key === 'g' || e.key === 'G') { this.tutor?.toggle(); return; }
      if (e.key === 'p' || e.key === 'P') { this.onRoleplay?.(); return; }
      if (e.key === 'Escape') { this.onEscape?.(); return; }
      if (e.key === 'r' || e.key === 'R') { this.reset(); return; }
      const i = Number(e.key) - 1;
      if (i >= 0 && i < SCENARIO_KEYS.length) this.fire(SCENARIO_KEYS[i]);
    });
  }

  fire(name) {
    this.scenarios[name]?.();
  }

  reset() {
    this.onReset?.();
  }

  togglePause() { this.setPaused(!this.paused); }

  setPaused(v) {
    this.paused = v;
    $('btn-pause').textContent = v ? '▶ resume' : '⏸ pause';
    $('btn-pause').classList.toggle('active', v);
  }

  setSpeed(v) {
    this.timeScale = v;
    $('sl-speed').value = v;
    $('sl-speed-v').textContent = v.toFixed(1) + '×';
  }

  setLoss(pct) {
    this.engine.lossRate = pct / 100;
    $('sl-loss').value = pct;
    $('sl-loss-v').textContent = pct + '%';
  }

  setAmbient(v) {
    this.director.ambient = v;
    $('sl-ambient').value = v;
    $('sl-ambient-v').textContent = String(v);
  }

  getSpeed() { return this.timeScale; }
  getAmbient() { return this.director.ambient; }
}
