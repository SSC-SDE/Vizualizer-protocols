// Action deck — the role-play control surface. Shows every dispatchable action
// (WHAT), a host picker (WHO) and the four OSI lanes (LAYER); arming all three
// lights the DISPATCH button, which hands the triple to the RolePlayDirector.
// Also owns the mission-select overlay and the end-of-mission recap.

import { KIND_COLOR } from '../sim/engine.js';
import { ACTION_KINDS, WHO_OPTIONS, LAYER_OPTIONS } from '../app/roleplay.js';
import { MISSIONS, MISSION_ORDER } from '../app/missions.js';

const hex = (c) => '#' + (c ?? 0xffffff).toString(16).padStart(6, '0');
const HOST_KEY = { 'CORE-RTR': 'router', 'DNS-CORE': 'dns', 'WEB-EDGE': 'web', 'MEDIA-RELAY': 'media' };

export class ActionDeck {
  constructor(roleplay) {
    this.rp = roleplay;
    this.sel = { kind: null, dst: null, layer: null };

    this.deck = document.getElementById('hud-deck');
    this.picker = document.getElementById('rp-picker');
    this.recap = document.getElementById('rp-recap');
    this.controlsEl = document.getElementById('hud-controls');   // the regular 1-9 deck

    this._buildPicker();
    this._buildDeck();

    roleplay.onState = () => this.render();
    roleplay.onComplete = (stats) => this.showRecap(stats);
    roleplay.onReject = (hint) => this._flash(hint, 'bad');
    roleplay.onExit = () => this._hideAll();
  }

  // ---------------------------------------------------------------- toggle / overlays

  toggle() {
    if (this.rp.active) { this.rp.exit(); return; }
    this._showPicker();
  }

  _hideAll() {
    this.deck.hidden = true;
    this.picker.hidden = true;
    this.recap.hidden = true;
    if (this.controlsEl) this.controlsEl.hidden = false;   // bring the regular deck back
  }

  _showPicker() {
    this.recap.hidden = true;
    this.deck.hidden = true;
    this.picker.hidden = false;
  }

  // clicking a host in the 3D scene picks WHO while the deck is open
  get active() { return this.rp.active; }
  pickHost(host) {
    const key = HOST_KEY[host?.name];
    if (!key) return;
    this.sel.dst = key;
    this.render();
  }

  // ---------------------------------------------------------------- mission select

  _buildPicker() {
    const cards = MISSION_ORDER.map((key) => {
      const m = MISSIONS[key];
      return `<button class="rp-card" data-mission="${key}">
        <div class="rp-card-t">${m.title}</div>
        <div class="rp-card-b">${m.blurb}</div>
      </button>`;
    }).join('');
    this.picker.innerHTML = `
      <div class="rp-modal">
        <div class="panel-title">🎭 ROLE-PLAY — be the client <span class="dim">// pick a mission</span></div>
        <div class="rp-cards">${cards}</div>
        <div class="rp-foot"><span class="dim">You’ll dispatch every packet by hand. Wrong picks teach — try them.</span>
          <button id="rp-picker-cancel">cancel</button></div>
      </div>`;
    this.picker.querySelectorAll('[data-mission]').forEach((b) => {
      b.onclick = () => { this.picker.hidden = true; this._start(b.dataset.mission); };
    });
    this.picker.querySelector('#rp-picker-cancel').onclick = () => { this.picker.hidden = true; };
  }

  _start(missionKey) {
    this.sel = { kind: null, dst: null, layer: null };
    this.deck.hidden = false;
    if (this.controlsEl) this.controlsEl.hidden = true;    // dedicated mode — hide the 1-9 deck
    this.rp.enter(missionKey);
  }

  // ---------------------------------------------------------------- deck skeleton

  _buildDeck() {
    const whatBtns = ACTION_KINDS.map((k) =>
      `<button class="rp-chip rp-what" data-kind="${k}" style="--c:${hex(KIND_COLOR[k])}">${k}</button>`).join('');
    const whoBtns = WHO_OPTIONS.map((o) =>
      `<button class="rp-chip rp-who" data-dst="${o.key}">${o.label}<span class="rp-sub">${o.sub}</span></button>`).join('');
    const layerBtns = LAYER_OPTIONS.map((o) =>
      `<button class="rp-chip rp-layer" data-layer="${o.key}">${o.label}<span class="rp-sub">${o.sub}</span></button>`).join('');

    this.deck.innerHTML = `
      <div class="rp-left">
        <div class="rp-head">
          <span class="rp-title" id="rp-title">mission</span>
          <button class="rp-x" id="rp-exit" title="Esc — exit role-play">✕</button>
        </div>
        <div class="rp-feedback" id="rp-feedback"></div>
        <div class="rp-pickrow"><span class="rp-lbl">WHAT</span><span class="rp-opts">${whatBtns}</span></div>
        <div class="rp-pickrow"><span class="rp-lbl">WHO</span><span class="rp-opts">${whoBtns}</span></div>
        <div class="rp-pickrow"><span class="rp-lbl">LAYER</span><span class="rp-opts">${layerBtns}</span></div>
        <div class="rp-actions">
          <button class="rp-dispatch" id="rp-dispatch" disabled>▶ DISPATCH</button>
          <button id="rp-hint">💡 hint</button>
          <span class="rp-score dim" id="rp-score"></span>
        </div>
      </div>
      <div class="rp-right">
        <div class="rp-checklist-t">MISSION STEPS</div>
        <div class="rp-checklist" id="rp-checklist"></div>
      </div>`;

    this.deck.querySelectorAll('[data-kind]').forEach((b) =>
      b.onclick = () => { this.sel.kind = b.dataset.kind; this.render(); });
    this.deck.querySelectorAll('[data-dst]').forEach((b) =>
      b.onclick = () => { this.sel.dst = b.dataset.dst; this.render(); });
    this.deck.querySelectorAll('[data-layer]').forEach((b) =>
      b.onclick = () => { this.sel.layer = b.dataset.layer; this.render(); });

    this.deck.querySelector('#rp-dispatch').onclick = () => this._dispatch();
    this.deck.querySelector('#rp-hint').onclick = () => this._hint();
    this.deck.querySelector('#rp-exit').onclick = () => this.rp.exit();
    this.feedbackEl = this.deck.querySelector('#rp-feedback');
  }

  _dispatch() {
    if (!this.sel.kind || !this.sel.dst || !this.sel.layer) return;
    this.rp.dispatch({ kind: this.sel.kind, dst: this.sel.dst, layer: this.sel.layer });
    this.sel = { kind: null, dst: null, layer: null };
    this.render();
  }

  _hint() {
    const h = this.rp.hint();
    if (h) this._flash('💡 ' + h, 'warn');
  }

  _flash(text, cls) {
    if (!this.feedbackEl) return;
    this.feedbackEl.innerHTML = `<span class="${cls}">${text}</span>`;
  }

  // ---------------------------------------------------------------- render

  render() {
    if (!this.rp.active) { this.deck.hidden = true; return; }
    this.deck.hidden = false;
    const s = this.rp.getState();

    this.deck.querySelector('#rp-title').textContent = s.mission.title;
    if (this.feedbackEl) this.feedbackEl.textContent = s.feedback || '';

    // highlight current selections
    for (const b of this.deck.querySelectorAll('[data-kind]')) b.classList.toggle('on', b.dataset.kind === this.sel.kind);
    for (const b of this.deck.querySelectorAll('[data-dst]')) b.classList.toggle('on', b.dataset.dst === this.sel.dst);
    for (const b of this.deck.querySelectorAll('[data-layer]')) b.classList.toggle('on', b.dataset.layer === this.sel.layer);

    const ready = this.sel.kind && this.sel.dst && this.sel.layer && !s.done;
    this.deck.querySelector('#rp-dispatch').disabled = !ready;

    this.deck.querySelector('#rp-score').textContent =
      `sent ${s.packets} · mistakes ${s.mistakes} · hints ${s.hints}`;

    // checklist — only the expect steps are player-actionable; show all with state
    const cl = this.deck.querySelector('#rp-checklist');
    cl.innerHTML = s.steps.map((step, i) => {
      const done = i < s.stepIndex;
      const current = i === s.stepIndex;
      const auto = !!step.auto;
      const label = auto
        ? `<span class="rp-auto">⟳ ${step.auto}</span> <span class="dim">auto</span>`
        : `${step.expect.kind} → ${whoName(step.expect.dst)} <span class="dim">${step.expect.layer.replace('L4_', '')}</span>`;
      const mark = done ? '✅' : current ? '▶' : '•';
      return `<div class="rp-step ${done ? 'done' : ''} ${current ? 'cur' : ''}">${mark} ${label}</div>`;
    }).join('');
  }

  // ---------------------------------------------------------------- recap

  showRecap(stats) {
    this.deck.hidden = true;
    const gradeColor = { S: '#00ffcc', A: '#00ff88', B: '#ffd24d', C: '#ff7700' }[stats.grade] || '#fff';
    this.recap.innerHTML = `
      <div class="rp-modal">
        <div class="panel-title">★ MISSION COMPLETE <span class="dim">// ${stats.title}</span></div>
        <div class="rp-grade" style="color:${gradeColor}">${stats.grade}</div>
        <table class="field-table rp-recap-table">
          <tr><td>packets dispatched</td><td>${stats.packets}</td></tr>
          <tr><td>mistakes</td><td class="${stats.mistakes ? 'warn' : 'ok'}">${stats.mistakes}</td></tr>
          <tr><td>hints used</td><td>${stats.hints}</td></tr>
          <tr><td>time</td><td>${stats.secs.toFixed(1)}s (sim)</td></tr>
        </table>
        <div class="rp-foot">
          <button id="rp-again">↻ another mission</button>
          <button id="rp-recap-close">exit</button>
        </div>
      </div>`;
    this.recap.hidden = false;
    this.recap.querySelector('#rp-again').onclick = () => { this.recap.hidden = true; this.rp.exit(); this._showPicker(); };
    this.recap.querySelector('#rp-recap-close').onclick = () => { this.recap.hidden = true; this.rp.exit(); };
  }
}

function whoName(key) {
  return { broadcast: 'broadcast', router: 'CORE-RTR', dns: 'DNS-CORE', web: 'WEB-EDGE', media: 'MEDIA-RELAY' }[key] || key;
}
