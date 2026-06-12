// Stats panel, telemetry charts, legend, event ticker.

import { KIND_COLOR, LAYER_META } from '../sim/engine.js';

const LAYER_ORDER = ['L4_TCP', 'L4_UDP', 'L3', 'L2'];   // top of the stack first, like the OSI model

export class Hud {
  constructor(engine) {
    this.engine = engine;
    this.statGrid = document.getElementById('stat-grid');
    this.ticker = document.getElementById('ticker');
    this.cThroughput = document.getElementById('chart-throughput');
    this.cPps = document.getElementById('chart-pps');
    this.layerCounts = null;          // fed by main loop
    this._layerShown = { L2: 0, L3: 0, L4_UDP: 0, L4_TCP: 0 };
    this._buildLegend();
    this._buildLayerMeter();
    engine.onLog = (text, cls) => this.log(text, cls);
  }

  _buildLayerMeter() {
    const wrap = document.getElementById('layer-meter');
    this._layerBars = {};
    for (const key of LAYER_ORDER) {
      const m = LAYER_META[key];
      const hex = '#' + m.color.toString(16).padStart(6, '0');
      const row = document.createElement('div');
      row.className = 'lm-row';
      row.innerHTML =
        `<span class="lm-name" style="color:${hex}">${m.sub}</span>` +
        `<span class="lm-track"><span class="lm-fill" style="background:${hex}"></span></span>` +
        `<span class="lm-count">0</span>`;
      wrap.appendChild(row);
      this._layerBars[key] = {
        fill: row.querySelector('.lm-fill'),
        count: row.querySelector('.lm-count'),
      };
    }
  }

  _buildLegend() {
    const el = document.getElementById('legend');
    for (const [kind, color] of Object.entries(KIND_COLOR)) {
      const li = document.createElement('span');
      li.className = 'li';
      li.innerHTML = `<span class="sw" style="background:#${color.toString(16).padStart(6, '0')}"></span>${kind}`;
      el.appendChild(li);
    }
  }

  log(text, cls = '') {
    const d = document.createElement('div');
    d.className = 'tk ' + cls;
    d.textContent = text;
    this.ticker.appendChild(d);
    while (this.ticker.children.length > 12) this.ticker.firstChild.remove();
    setTimeout(() => d.remove(), 6200);
  }

  update() {
    const e = this.engine;
    const c = e.counters;
    const lossPct = c.sent ? ((c.dropped / c.sent) * 100).toFixed(1) : '0.0';
    const burst = e.time < e.lossBurstUntil;
    const rows = [
      ['sim time', e.time.toFixed(1) + 's'],
      ['flows', String(e.flows.length)],
      ['in flight', String(e.inFlight.length)],
      ['conns total', String(c.conns)],
      ['pkts sent', String(c.sent)],
      ['delivered', String(c.delivered)],
      ['dropped', `<span class="${c.dropped ? 'bad' : ''}">${c.dropped} (${lossPct}%)</span>`],
      ['retransmits', `<span class="${c.retx ? 'warn' : ''}">${c.retx}</span>`],
      ['data moved', fmtBytes(c.bytes)],
      ['wire loss', `<span class="${burst ? 'bad' : ''}">${(e.effectiveLoss() * 100).toFixed(0)}%${burst ? ' BURST' : ''}</span>`],
      ['SYN backlog', `<span class="${e.synBacklog > 40 ? 'bad' : e.synBacklog > 10 ? 'warn' : ''}">${e.synBacklog}/${e.synBacklogMax}</span>`],
    ];
    this.statGrid.innerHTML = rows
      .map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
      .join('');

    this._drawThroughput();
    this._drawPps();
    this._updateLayerMeter();
  }

  _updateLayerMeter() {
    if (!this.layerCounts) return;
    for (const key of LAYER_ORDER) {
      const n = this.layerCounts[key];
      // smooth so the bars breathe instead of flicker
      this._layerShown[key] += (n - this._layerShown[key]) * 0.15;
      const v = this._layerShown[key];
      const bar = this._layerBars[key];
      bar.fill.style.width = Math.min(100, (v / 12) * 100).toFixed(1) + '%';
      bar.count.textContent = String(n);
    }
  }

  _series(arr, head, n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = arr[(head + i) % n];
    return out;
  }

  _drawThroughput() {
    const ctx = this.cThroughput.getContext('2d');
    const { width: W, height: H } = this.cThroughput;
    ctx.clearRect(0, 0, W, H);
    const s = this.engine.series;
    const data = this._series(s.mbps, s.head, s.n);
    const max = Math.max(0.5, ...data) * 1.15;
    ctx.beginPath();
    ctx.moveTo(0, H);
    data.forEach((v, i) => ctx.lineTo((i / (s.n - 1)) * W, H - (v / max) * H));
    ctx.lineTo(W, H);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(65,166,255,0.55)');
    g.addColorStop(1, 'rgba(65,166,255,0.05)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = '#41a6ff';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (s.n - 1)) * W, y = H - (v / max) * H;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = 'rgba(120,170,220,0.8)';
    ctx.font = '9px Menlo';
    ctx.fillText(max.toFixed(1), 4, 10);
  }

  _drawPps() {
    const ctx = this.cPps.getContext('2d');
    const { width: W, height: H } = this.cPps;
    ctx.clearRect(0, 0, W, H);
    const s = this.engine.series;
    const ok = this._series(s.pps, s.head, s.n);
    const drop = this._series(s.dps, s.head, s.n);
    const retx = this._series(s.rps, s.head, s.n);
    const max = Math.max(4, ...ok, ...drop, ...retx) * 1.15;
    const line = (data, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = (i / (s.n - 1)) * W, y = H - (v / max) * H;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    };
    line(ok, '#00ff88');
    line(retx, '#ff7700');
    line(drop, '#ff2244');
    ctx.fillStyle = 'rgba(120,170,220,0.8)';
    ctx.font = '9px Menlo';
    ctx.fillText(max.toFixed(0) + ' pps', 4, 10);
  }
}

export function fmtBytes(b) {
  if (b >= 1 << 30) return (b / (1 << 30)).toFixed(2) + ' GB';
  if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
  if (b >= 1 << 10) return (b / (1 << 10)).toFixed(0) + ' KB';
  return b + ' B';
}
