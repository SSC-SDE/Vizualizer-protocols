// Inspector: flow list, full packet dissection (IPv4 + TCP/UDP headers built
// byte-for-byte with a real IPv4 checksum), hover-linked hex dump, per-connection
// congestion chart and a wire ladder diagram.

import { KIND_COLOR, KIND, MSS } from '../sim/engine.js';
import { fmtBytes } from './hud.js';

export class Inspector {
  constructor(engine) {
    this.engine = engine;
    this.listEl = document.getElementById('flow-list');
    this.bodyEl = document.getElementById('inspector-body');
    this.modeEl = document.getElementById('inspector-mode');
    this.selected = null;        // flow
    this.pinnedPacket = null;
    this._lastListRender = 0;
  }

  reset() {
    this.selected = null;
    this.pinnedPacket = null;
    this.modeEl.textContent = '// click a packet, host or flow';
    this.listEl.innerHTML = '';
    this.bodyEl.innerHTML = '';
    this._lastListRender = 0;
  }

  // ---------------- flow list ----------------

  updateList() {
    const now = performance.now();
    if (now - this._lastListRender < 250) return;
    this._lastListRender = now;

    const flows = this.engine.flows.slice(-40).reverse();
    this.listEl.innerHTML = '';
    for (const f of flows) {
      const row = document.createElement('div');
      row.className = 'flow-row' + (f === this.selected ? ' sel' : '');
      const protoColor = { TCP: '#00ccff', UDP: '#cc66ff', ICMP: '#ff8866', ARP: '#9dff57' }[f.proto] || '#fff';
      let extra = '';
      if (f.proto === 'TCP' && f.totalBytes > 0) {
        extra = `${Math.round(f.progress * 100)}%`;
      }
      row.innerHTML =
        `<span class="proto" style="color:${protoColor}">${f.proto}</span>` +
        `<span>${esc(f.label)}</span>` +
        `<span class="dim">${extra}</span>` +
        `<span class="st">${esc(f.stateStr)}</span>`;
      row.onclick = () => this.selectFlow(f);
      this.listEl.appendChild(row);
    }
  }

  selectFlow(f) {
    this.selected = f;
    this.pinnedPacket = null;
    this._finalRendered = false;
    this.modeEl.textContent = '// flow';
    this.renderFlow();
  }

  showPacket(pkt) {
    this.pinnedPacket = pkt;
    this.selected = pkt.flow;
    this.modeEl.textContent = '// packet (frozen at capture)';
    this.renderPacket(pkt);
  }

  showHost(host) {
    this.pinnedPacket = null;
    this.selected = null;
    this.modeEl.textContent = '// host';
    const flows = this.engine.flows.filter(f => f.client === host || f.server === host);
    this.bodyEl.innerHTML = `
      <div class="sec-title">${esc(host.name)} — ${esc(host.ip)} (${host.kind})</div>
      <table class="field-table">
        <tr><td>packets tx / rx</td><td>${host.txPackets} / ${host.rxPackets}</td></tr>
        <tr><td>bytes tx / rx</td><td>${fmtBytes(host.txBytes)} / ${fmtBytes(host.rxBytes)}</td></tr>
        <tr><td>active flows</td><td>${flows.length}</td></tr>
      </table>
      <div class="sec-title">flows touching this host</div>
      ${flows.slice(0, 12).map(f => `<div class="dim" style="font-size:11px">· ${f.proto} ${esc(f.label)} — ${esc(f.stateStr)}</div>`).join('') || '<div class="dim">none</div>'}
    `;
  }

  // periodic refresh of live flow view
  tick() {
    this.updateList();
    if (this.pinnedPacket) return;                 // packet view is a frozen capture
    if (!this.selected) return;
    if (this.selected.dead) {
      // flow ended: render its final state once, then freeze until the user picks something else
      if (!this._finalRendered) {
        this._finalRendered = true;
        this.modeEl.textContent = '// flow (ended — frozen)';
        this.renderFlow();
      }
      return;
    }
    this.renderFlow();
  }

  // ---------------- flow view ----------------

  renderFlow() {
    const f = this.selected;
    if (!f) return;
    if (f.proto === 'TCP') this._renderTcp(f);
    else this._renderUdp(f);
  }

  _renderTcp(f) {
    const rows = [
      ...(f.dead ? [['status', '<span class="warn">flow ended — final state, frozen</span>']] : []),
      ['endpoints', esc(f.name)],
      ['state c/s', `<b>${esc(f.stateStr)}</b>`],
      ['transfer', `${fmtBytes(f.snd_una)} / ${fmtBytes(f.totalBytes)} (${Math.round(f.progress * 100)}%)`],
      ['cwnd', `${fmtBytes(f.cwnd)} (${(f.cwnd / MSS).toFixed(1)} MSS)`],
      ['ssthresh', f.ssthresh > 1e7 ? '∞' : fmtBytes(f.ssthresh)],
      ['in flight', fmtBytes(f.inflight)],
      ['SRTT / RTO', `${f.srtt ? f.srtt.toFixed(2) + 's' : '—'} / ${f.rto.toFixed(2)}s`],
      ['dup ACKs', `${f.dupAcks}${f.inRecovery ? ' <span class="warn">FAST RECOVERY</span>' : ''}`],
      ['retransmits', `<span class="${f.retxCount ? 'warn' : ''}">${f.retxCount}</span>`],
      ['snd_una / snd_nxt', `${f.snd_una} / ${f.snd_nxt}`],
      ['rcv_nxt (client)', String(f.rcv_nxt)],
      ['ooo buffered', String(f.ooo.size)],
    ];
    if (f.eventNote) rows.push(['last event', `<span class="warn">${esc(f.eventNote)}</span>`]);

    this.bodyEl.innerHTML = `
      <div class="sec-title">TCP · ${esc(f.label)}</div>
      <table class="field-table">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
      <div class="sec-title">congestion window <span class="dim">cwnd ▬ · ssthresh ┄ · in-flight ▒</span></div>
      <canvas id="chart-cwnd" width="356" height="92"></canvas>
      <div class="sec-title">wire ladder <span class="dim">client ⟷ server, newest at bottom</span></div>
      <canvas id="ladder" width="356" height="300"></canvas>
    `;
    this._drawCwnd(f);
    this._drawLadder(f);
  }

  _renderUdp(f) {
    const rows = [
      ...(f.dead ? [['status', '<span class="warn">flow ended — final state, frozen</span>']] : []),
      ['endpoints', esc(f.name)], ['state', esc(f.stateStr)],
    ];
    if (f.domain) {
      rows.push(['query', `A? ${esc(f.domain)}`]);
      rows.push(['txid', '0x' + f.txid.toString(16)]);
      rows.push(['attempts', `${f.tries}/${f.maxTries}`]);
    }
    if (f.rate) {
      rows.push(['rate', `${f.rate} pps × ${f.pktLen} B`]);
      rows.push(['rx / sent', `${f.rxCount} / ${f.seq}`]);
      rows.push(['frames lost', `<span class="${f.lostCount ? 'bad' : ''}">${f.lostCount}</span> (no recovery — UDP)`]);
      rows.push(['jitter (smoothed)', (f.jitter * 1000).toFixed(0) + ' ms']);
    }
    if (f.rtts) {                          // ping
      const ms = f.rtts.map(r => r * 1000);
      rows.push(['replies', `${f.rtts.length}/${f.count}, ${f.lost} lost`]);
      if (ms.length) rows.push(['rtt min/avg/max', `${Math.min(...ms).toFixed(0)} / ${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(0)} / ${Math.max(...ms).toFixed(0)} ms`]);
    }
    if (f.hopRtts) {                       // traceroute
      f.hops.forEach((hop, i) => {
        const times = f.hopRtts[i].map(r => isNaN(r) ? '*' : (r * 1000).toFixed(0) + 'ms').join(' ') || '…';
        rows.push([`hop ${i + 1}`, `${esc(hop.name)} (${hop.ip}) ${times}`]);
      });
    }
    if (f.proto === 'ARP') {
      rows.push(['question', `who-has ${f.server.ip}?`]);
      rows.push(['answer', f.state === 'RESOLVED' ? `is-at ${f.server.mac}` : '—']);
    }
    this.bodyEl.innerHTML = `
      <div class="sec-title">${esc(f.proto)} · ${esc(f.label)}</div>
      <table class="field-table">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
      <div class="sec-title">wire ladder</div>
      <canvas id="ladder" width="356" height="300"></canvas>
    `;
    this._drawLadder(f);
  }

  _drawCwnd(f) {
    const cnv = document.getElementById('chart-cwnd');
    if (!cnv || !f.cwndHist.length) return;
    const ctx = cnv.getContext('2d');
    const { width: W, height: H } = cnv;
    const h = f.cwndHist;
    const max = Math.max(...h.map(p => Math.max(p.cwnd, p.ssthresh > 1e7 ? 0 : p.ssthresh)), MSS * 4) * 1.1;
    const x = i => (i / Math.max(1, h.length - 1)) * W;
    const y = v => H - (v / max) * H;

    // in-flight area
    ctx.fillStyle = 'rgba(0,204,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(0, H);
    h.forEach((p, i) => ctx.lineTo(x(i), y(p.inflight)));
    ctx.lineTo(W, H);
    ctx.fill();
    // ssthresh dashed
    ctx.strokeStyle = '#ff7700';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    h.forEach((p, i) => { const yy = y(Math.min(p.ssthresh, max)); i ? ctx.lineTo(x(i), yy) : ctx.moveTo(x(i), yy); });
    ctx.stroke();
    ctx.setLineDash([]);
    // cwnd line
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    h.forEach((p, i) => { i ? ctx.lineTo(x(i), y(p.cwnd)) : ctx.moveTo(x(i), y(p.cwnd)); });
    ctx.stroke();
    ctx.fillStyle = 'rgba(120,170,220,0.8)';
    ctx.font = '9px Menlo';
    ctx.fillText((max / MSS).toFixed(0) + ' MSS', 4, 10);
  }

  _drawLadder(f) {
    const cnv = document.getElementById('ladder');
    if (!cnv) return;
    const ctx = cnv.getContext('2d');
    const { width: W, height: H } = cnv;
    ctx.clearRect(0, 0, W, H);
    const Lx = 56, Rx = W - 56;
    ctx.strokeStyle = 'rgba(65,166,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Lx, 14); ctx.lineTo(Lx, H - 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(Rx, 14); ctx.lineTo(Rx, H - 4); ctx.stroke();
    ctx.fillStyle = '#4d6a8f';
    ctx.font = '10px Menlo';
    ctx.textAlign = 'center';
    ctx.fillText('CLIENT', Lx, 10);
    ctx.fillText('SERVER', Rx, 10);

    const events = f.history.slice(-24);
    const rowH = (H - 26) / Math.max(1, events.length);
    const slant = Math.min(rowH * 0.7, 10);
    events.forEach((ev, i) => {
      const yTop = 20 + i * rowH;
      const c2s = ev.dir === 'c2s';
      const x1 = c2s ? Lx : Rx, x2 = c2s ? Rx : Lx;
      const color = '#' + (KIND_COLOR[ev.kind] ?? 0xffffff).toString(16).padStart(6, '0');
      ctx.strokeStyle = ev.lost ? 'rgba(255,34,68,0.9)' : color;
      ctx.lineWidth = ev.len > 1000 ? 1.8 : 1;
      ctx.beginPath();
      ctx.moveTo(x1, yTop);
      if (ev.lost) {
        const mx = (x1 + x2) / 2, my = yTop + slant / 2;
        ctx.lineTo(mx, my);
        ctx.stroke();
        ctx.fillStyle = '#ff2244';
        ctx.font = '11px Menlo';
        ctx.fillText('✕', mx + (c2s ? 8 : -8), my + 4);
      } else {
        ctx.lineTo(x2, yTop + slant);
        ctx.stroke();
        // arrowhead
        const ang = Math.atan2(slant, x2 - x1);
        ctx.beginPath();
        ctx.moveTo(x2, yTop + slant);
        ctx.lineTo(x2 - 7 * Math.cos(ang - 0.4), yTop + slant - 7 * Math.sin(ang - 0.4));
        ctx.lineTo(x2 - 7 * Math.cos(ang + 0.4), yTop + slant - 7 * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      }
      // label
      ctx.fillStyle = ev.lost ? '#ff2244' : color;
      ctx.font = '9px Menlo';
      const lbl = ev.len ? `${ev.kind} ${fmtBytes(ev.len)}` : ev.kind;
      ctx.fillText(lbl, (Lx + Rx) / 2, yTop - 1);
    });
    ctx.textAlign = 'left';
  }

  // ---------------- packet dissection ----------------

  renderPacket(pkt) {
    const { bytes, fields } = buildHeaderBytes(pkt);
    const color = '#' + (KIND_COLOR[pkt.kind] ?? 0xffffff).toString(16).padStart(6, '0');
    const flagChips = ['SYN', 'ACK', 'FIN', 'RST', 'PSH']
      .filter(k => pkt.flags[k])
      .map(k => `<span class="flagchip" style="color:${color}">${k}</span>`)
      .join('') || '<span class="dim">none</span>';

    const fieldRows = fields.map((f) =>
      f.section
        ? `<tr><td colspan="2" style="color:var(--accent);letter-spacing:0.08em;padding-top:8px">▾ ${f.section}</td></tr>`
        : `<tr data-hex data-range="${f.off},${f.len}"><td>${f.name}</td><td>${f.value}</td></tr>`,
    ).join('');

    const hops = pkt.via
      ? `${esc(pkt.src.name)} → <span class="dim">${esc(pkt.via.name)}</span> → ${esc(pkt.dst.name)}`
      : `${esc(pkt.src.name)} → ${esc(pkt.dst.name)}`;

    this.bodyEl.innerHTML = `
      <div class="sec-title" style="color:${color}">packet #${pkt.id} · ${pkt.proto} · ${pkt.kind}
        ${pkt.lost ? '<span class="bad"> · LOST IN TRANSIT</span>' : ''}</div>
      <table class="field-table">
        <tr><td>route</td><td>${esc(pkt.src.ip)} → ${esc(pkt.dstIp || pkt.dst.ip)}</td></tr>
        <tr><td>path</td><td>${hops}</td></tr>
        ${pkt.proto === 'TCP' ? `<tr><td>flags</td><td>${flagChips}</td></tr>` : ''}
        <tr><td>size on wire</td><td>${pkt.totalLen} B (hdr ${pkt.totalLen - pkt.len} + payload ${pkt.len})</td></tr>
        <tr><td>one-way latency</td><td>${(pkt.t1 - pkt.t0).toFixed(2)}s (sim)</td></tr>
        ${pkt.note ? `<tr><td>annotation</td><td class="dim">${esc(pkt.note)}</td></tr>` : ''}
        ${pkt.flow ? `<tr><td>flow</td><td><a href="#" id="goto-flow" style="color:var(--accent)">${esc(pkt.flow.label)} ↗</a></td></tr>` : ''}
      </table>
      <div class="sec-title">header dissection <span class="dim">hover a field → bytes light up</span></div>
      <table class="field-table" id="dissect">${fieldRows}</table>
      <div class="sec-title">raw bytes <span class="dim">IPv4 + ${pkt.proto} header${pkt.len ? ' + payload preview' : ''}</span></div>
      <div class="hexdump" id="hexdump">${renderHex(bytes)}</div>
    `;

    // hover ↔ hex highlight
    const dump = this.bodyEl.querySelector('#hexdump');
    this.bodyEl.querySelectorAll('tr[data-hex]').forEach(tr => {
      tr.addEventListener('mouseenter', () => {
        const [off, len] = tr.dataset.range.split(',').map(Number);
        dump.querySelectorAll('.b').forEach(b => {
          const i = Number(b.dataset.i);
          b.classList.toggle('hl', i >= off && i < off + len);
        });
      });
      tr.addEventListener('mouseleave', () => {
        dump.querySelectorAll('.b.hl').forEach(b => b.classList.remove('hl'));
      });
    });
    const link = this.bodyEl.querySelector('#goto-flow');
    if (link) link.onclick = (e) => { e.preventDefault(); this.selectFlow(pkt.flow); };
  }
}

// ================= header byte construction =================

function ipToBytes(ip) {
  return ip.split('.').map(Number);
}

function ipv4Checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) | (bytes[i + 1] || 0);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

function macToBytes(mac) {
  return mac.split(':').map(h => parseInt(h, 16));
}

const u32 = v => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const u16 = v => [(v >> 8) & 0xff, v & 0xff];

function buildHeaderBytes(pkt) {
  const bytes = [];
  const fields = [];
  const section = (name) => fields.push({ section: name });
  const field = (name, value, len, arr) => {
    fields.push({ name, value, off: bytes.length, len });
    if (arr) bytes.push(...arr);
  };

  // ============ Ethernet II — Layer 2 ============
  const isBroadcast = pkt.kind === KIND.ARP_REQ;
  const nextHop = pkt.via || pkt.dst;
  const dstMac = isBroadcast ? 'ff:ff:ff:ff:ff:ff' : nextHop.mac;
  const etherType = pkt.proto === 'ARP' ? 0x0806 : 0x0800;

  section('ETHERNET II · LAYER 2');
  field('dst MAC', isBroadcast
    ? 'ff:ff:ff:ff:ff:ff <span class="dim">(broadcast)</span>'
    : `${dstMac}${pkt.via ? ` <span class="dim">(next hop: ${esc(pkt.via.name)})</span>` : ''}`,
    6, macToBytes(dstMac));
  field('src MAC', pkt.src.mac, 6, macToBytes(pkt.src.mac));
  field('ethertype', `0x${etherType.toString(16).padStart(4, '0')} (${pkt.proto === 'ARP' ? 'ARP' : 'IPv4'})`,
    2, u16(etherType));

  // ============ ARP — resolves L3→L2, no IP header ============
  if (pkt.proto === 'ARP') {
    const isReq = pkt.kind === KIND.ARP_REQ;
    const tha = isReq ? '00:00:00:00:00:00' : pkt.dst.mac;
    section('ARP · ADDRESS RESOLUTION');
    field('hardware type', '1 (Ethernet)', 2, u16(1));
    field('protocol type', '0x0800 (IPv4)', 2, u16(0x0800));
    field('hw / proto size', '6 / 4', 2, [6, 4]);
    field('opcode', isReq ? '1 (who-has)' : '2 (is-at)', 2, u16(isReq ? 1 : 2));
    field('sender MAC', pkt.src.mac, 6, macToBytes(pkt.src.mac));
    field('sender IP', pkt.src.ip, 4, ipToBytes(pkt.src.ip));
    field('target MAC', isReq ? '00:00:00:00:00:00 <span class="dim">(unknown — that’s the question)</span>' : tha,
      6, macToBytes(tha));
    field('target IP', pkt.dst.ip, 4, ipToBytes(pkt.dst.ip));
    return { bytes, fields };
  }

  // ============ IPv4 — Layer 3 (checksum computed for real) ============
  const isTcp = pkt.proto === 'TCP';
  const isIcmp = pkt.proto === 'ICMP';
  const l4len = isTcp ? 20 : 8;
  const ipTotal = 20 + l4len + pkt.len;
  const ipId = pkt.id & 0xffff;
  const ipProto = isIcmp ? 1 : isTcp ? 6 : 17;
  const dstIpStr = pkt.dstIp || pkt.dst.ip;

  const ipHdr = [
    0x45, 0x00, ...u16(ipTotal), ...u16(ipId), 0x40, 0x00,
    pkt.ttl, ipProto, 0x00, 0x00,
    ...ipToBytes(pkt.src.ip), ...ipToBytes(dstIpStr),
  ];
  const ck = ipv4Checksum(ipHdr);
  ipHdr[10] = (ck >> 8) & 0xff;
  ipHdr[11] = ck & 0xff;

  const ipBase = bytes.length;
  section('IPV4 · LAYER 3');
  bytes.push(...ipHdr);
  const ipField = (name, value, off, len) => fields.push({ name, value, off: ipBase + off, len });
  ipField('version / IHL', '4 / 20 bytes', 0, 1);
  ipField('total length', ipTotal + ' B', 2, 2);
  ipField('identification', '0x' + ipId.toString(16).padStart(4, '0'), 4, 2);
  ipField('flags', 'DF (don’t fragment)', 6, 2);
  ipField('TTL', pkt.via
    ? `${pkt.ttl} → ${pkt.ttl - 1} <span class="dim">(decremented at ${esc(pkt.via.name)})</span>`
    : String(pkt.ttl), 8, 1);
  ipField('protocol', `${ipProto} (${pkt.proto})`, 9, 1);
  ipField('header checksum', '0x' + ck.toString(16).padStart(4, '0') + ' <span class="ok">✓ computed</span>', 10, 2);
  ipField('src address', pkt.src.ip, 12, 4);
  ipField('dst address', dstIpStr, 16, 4);

  // ============ Layer 4 / ICMP ============
  const l4Base = bytes.length;
  const lf = (name, value, off, len) => fields.push({ name, value, off: l4Base + off, len });

  if (isIcmp) {
    const icmpHdr = [pkt.icmpType, pkt.icmpCode, 0, 0, ...u16(pkt.icmpId), ...u16(pkt.icmpSeq & 0xffff)];
    const ick = ipv4Checksum(icmpHdr);
    icmpHdr[2] = (ick >> 8) & 0xff;
    icmpHdr[3] = ick & 0xff;
    section('ICMP · LAYER 3 CONTROL');
    bytes.push(...icmpHdr);
    lf('type', `${pkt.icmpType} (${icmpTypeName(pkt.icmpType)})`, 0, 1);
    lf('code', `${pkt.icmpCode}${pkt.icmpType === 3 ? ' (port unreachable)' : ''}`, 1, 1);
    lf('checksum', '0x' + ick.toString(16).padStart(4, '0') + ' <span class="ok">✓ computed</span>', 2, 2);
    lf('identifier', String(pkt.icmpId), 4, 2);
    lf('sequence', String(pkt.icmpSeq), 6, 2);
  } else if (isTcp) {
    const flagBits =
      (pkt.flags.FIN ? 0x01 : 0) | (pkt.flags.SYN ? 0x02 : 0) | (pkt.flags.RST ? 0x04 : 0) |
      (pkt.flags.PSH ? 0x08 : 0) | (pkt.flags.ACK ? 0x10 : 0);
    section('TCP · LAYER 4');
    bytes.push(
      ...u16(pkt.sport), ...u16(pkt.dport),
      ...u32(pkt.seq >>> 0), ...u32(pkt.ackNo >>> 0),
      0x50, flagBits, ...u16(pkt.win & 0xffff),
      0xbe, 0xef, 0x00, 0x00,
    );
    lf('src port', String(pkt.sport), 0, 2);
    lf('dst port', pkt.dport + portService(pkt.dport), 2, 2);
    lf('sequence number', String(pkt.seq >>> 0), 4, 4);
    lf('ack number', pkt.flags.ACK ? String(pkt.ackNo >>> 0) : '0 (ACK not set)', 8, 4);
    lf('data offset', '5 (20 B header)', 12, 1);
    lf('flags', `0x${flagBits.toString(16).padStart(2, '0')} [${pkt.flagStr}]`, 13, 1);
    lf('window', String(pkt.win & 0xffff), 14, 2);
    lf('TCP checksum', '0xbeef <span class="dim">(not modeled)</span>', 16, 2);
    lf('urgent pointer', '0', 18, 2);
  } else {
    const udpLen = 8 + pkt.len;
    section('UDP · LAYER 4');
    bytes.push(...u16(pkt.sport), ...u16(pkt.dport), ...u16(udpLen), 0xca, 0xfe);
    lf('src port', String(pkt.sport), 0, 2);
    lf('dst port', pkt.dport + portService(pkt.dport), 2, 2);
    lf('UDP length', udpLen + ' B', 4, 2);
    lf('UDP checksum', '0xcafe <span class="dim">(not modeled)</span>', 6, 2);
  }

  // payload preview (synthesized, ≤32 bytes)
  if (pkt.len > 0) {
    const text = payloadPreview(pkt);
    const payload = [...text].slice(0, 32).map(c => c.charCodeAt(0) & 0x7f);
    fields.push({ name: 'payload', off: bytes.length, len: payload.length, value: `${pkt.len} B — "${esc(text.slice(0, 36))}…"` });
    bytes.push(...payload);
  }

  return { bytes, fields };
}

function icmpTypeName(t) {
  return { 0: 'echo reply', 3: 'destination unreachable', 8: 'echo request', 11: 'time exceeded' }[t] || '?';
}

function payloadPreview(pkt) {
  switch (pkt.kind) {
    case 'REQUEST': return `GET / HTTP/1.1\r\nHost: ${pkt.dst.name}\r\n`;
    case 'DNS-QUERY': return (pkt.note.match(/A\? (\S+)/)?.[1] || 'query') + ' IN A?';
    case 'DNS-REPLY': return pkt.note;
    case 'STREAM': return pkt.note;
    case 'ECHO-REQ': case 'ECHO-REP': return 'abcdefghijklmnopqrstuvwabcdefghi';   // classic ping pattern
    case 'TTL-EXCEED': case 'UNREACHABLE': return '[IP header + 8 bytes of offending datagram]';
    case 'UDP-PROBE': return 'SUPERMAN traceroute probe';
    default: return 'a9 3f c4 segment payload (' + pkt.len + ' B)';
  }
}

function portService(p) {
  const m = { 80: ' (http)', 443: ' (https)', 53: ' (dns)', 8080: ' (http-alt)' };
  return m[p] || '';
}

function renderHex(bytes) {
  let out = '';
  for (let row = 0; row < bytes.length; row += 16) {
    const chunk = bytes.slice(row, row + 16);
    const hex = chunk.map((b, i) =>
      `<span class="b" data-i="${row + i}">${b.toString(16).padStart(2, '0')}</span>${(i === 7 ? ' ' : '')}`,
    ).join(' ');
    const ascii = chunk.map(b => (b >= 32 && b < 127 ? esc(String.fromCharCode(b)) : '·')).join('');
    out += `<span class="off">${row.toString(16).padStart(4, '0')}</span>  ${hex.padEnd(0)}  <span class="ascii">${ascii}</span>\n`;
  }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
