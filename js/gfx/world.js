// Three.js scene: datacenter core, client ring, starfield, bloom, picking.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { flightCurve, LAYER_ALT } from './paths.js';
import { LAYER_META } from '../sim/engine.js';

export class World {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x04060d, 0.0035);

    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 800);
    this.camera.position.set(34, 26, 48);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxDistance = 180;
    this.controls.minDistance = 8;
    this.controls.target.set(0, 6, 0);
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.renderer.domElement.addEventListener('pointerdown', () => { this.controls.autoRotate = false; });

    // bloom
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.7, 0.5, 0.14);
    this.composer.addPass(this.bloom);

    this._lights();
    this._floor();
    this._stars();
    this._layerStrata();

    this.ripples = [];
    this.flowArcs = new Map();     // flow -> {line, lastSeen}
    this.bubbles = new Map();      // host.id -> activity speech bubble

    this.hostMeshes = new Map();   // host.id -> {group, mesh, baseEmissive, host}
    this.linkLines = new Map();    // flowKey -> line
    this.labelSprites = [];

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.onPickPacket = null;
    this.onPickHost = null;

    addEventListener('resize', () => this._resize());
    this.renderer.domElement.addEventListener('click', (e) => this._click(e));
  }

  _lights() {
    this.scene.add(new THREE.AmbientLight(0x223355, 1.4));
    const key = new THREE.DirectionalLight(0x88bbff, 1.2);
    key.position.set(20, 40, 10);
    this.scene.add(key);
    const rim = new THREE.PointLight(0x2244aa, 220, 120);
    rim.position.set(0, 22, 0);
    this.scene.add(rim);
  }

  _floor() {
    const grid = new THREE.GridHelper(220, 110, 0x1a3a66, 0x0c1f3d);
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    this.scene.add(grid);

    // soft radial glow under the core
    const glowTex = makeRadialTexture('#0a2a55', 0.55);
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(30, 48),
      new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.02;
    this.scene.add(glow);
  }

  _stars() {
    const n = 1400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 220 + Math.random() * 260;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = Math.abs(r * Math.cos(ph)) * 0.6 + 4;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: 0x335588, size: 0.7, sizeAttenuation: true, transparent: true, opacity: 0.8 });
    this.scene.add(new THREE.Points(g, m));
  }

  _layerStrata() {
    // The OSI airspace, made legible: each lane is a living stratum —
    // a rim-glow halo disc, a slowly counter-rotating dashed ring, and a
    // holographic name plate. Opacity tracks live traffic in the lane
    // (see setLayerActivity), so busy layers visibly light up.
    const R = 38;
    this.strata = {};
    const defs = [
      { key: 'L2', angle: 2.62 },
      { key: 'L3', angle: 2.62 },
      { key: 'L4_UDP', angle: 2.62 },
      { key: 'L4_TCP', angle: 2.62 },
    ];
    const haloTex = makeRimTexture();

    for (const d of defs) {
      const meta = LAYER_META[d.key];
      const alt = LAYER_ALT[d.key];
      const color = new THREE.Color(meta.color);
      const group = new THREE.Group();

      // rim halo disc — glow lives at the edge, center stays clear
      const halo = new THREE.Mesh(
        new THREE.CircleGeometry(R, 72),
        new THREE.MeshBasicMaterial({
          map: haloTex, color, transparent: true, opacity: 0.05,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = alt;
      group.add(halo);

      // solid hairline ring at the rim
      const rim = circleLine(R, alt, color, 0.16);
      group.add(rim);

      // dashed orbit ring just inside, counter-rotating — gives each lane motion
      const dash = circleLine(R - 1.6, alt, color, 0.22, true);
      group.add(dash);

      // holographic name plate at the rim
      const plate = makePlate(meta.name, meta.sub, color);
      plate.position.set(Math.cos(d.angle) * (R + 1), alt + 1.7, Math.sin(d.angle) * (R + 1));
      group.add(plate);

      this.scene.add(group);
      this.strata[d.key] = { halo, rim, dash, plate, activity: 0, shown: 0, dashDir: alt % 2 < 1 ? 1 : -1 };
    }

    // vertical OSI axis ruler stitching the strata together
    const ax = new THREE.Vector3(Math.cos(2.62) * R, 0, Math.sin(2.62) * R);
    const spine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(ax.x, 0, ax.z),
        new THREE.Vector3(ax.x, LAYER_ALT.L4_TCP + 3, ax.z),
      ]),
      new THREE.LineBasicMaterial({ color: 0x41a6ff, transparent: true, opacity: 0.28 }),
    );
    this.scene.add(spine);
    for (const key of Object.keys(LAYER_META)) {
      const node = new THREE.Mesh(
        new THREE.SphereGeometry(0.34, 12, 10),
        new THREE.MeshBasicMaterial({ color: LAYER_META[key].color, toneMapped: false }),
      );
      node.position.set(ax.x, LAYER_ALT[key], ax.z);
      this.scene.add(node);
      this.strata[key].node = node;
    }
  }

  /** Speech bubble over a host: what the "user" is doing in human terms. */
  showActivity(host, text, color = 0x41a6ff, duration = 5) {
    const old = this.bubbles.get(host.id);
    if (old) this._disposeBubble(old);
    const sprite = makeBubble(text, new THREE.Color(color));
    const baseY = host.pos.y + (host.kind === 'client' ? 4.6 : host.pos.y * 2 + 4.6);
    sprite.position.set(host.pos.x, baseY, host.pos.z);
    this.scene.add(sprite);
    this.bubbles.set(host.id, { sprite, life: duration, max: duration, baseY, t: Math.random() * 6 });
  }

  _disposeBubble(b) {
    this.scene.remove(b.sprite);
    b.sprite.material.map.dispose();
    b.sprite.material.dispose();
    for (const [id, rec] of this.bubbles) if (rec === b) this.bubbles.delete(id);
  }

  /** Remove everything spawned by traffic: bot meshes, flow ribbons, ripples (sim reset). */
  clearDynamic() {
    for (const [id, rec] of [...this.hostMeshes]) {
      if (rec.bot) {
        this.scene.remove(rec.group);
        rec.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
        this.hostMeshes.delete(id);
      }
    }
    for (const [, rec] of this.flowArcs) {
      this.scene.remove(rec.line);
      rec.line.geometry.dispose();
      rec.line.material.dispose();
    }
    this.flowArcs.clear();
    for (const r of this.ripples) {
      this.scene.remove(r.ring);
      r.ring.geometry.dispose();
      r.ring.material.dispose();
    }
    this.ripples = [];
    for (const b of [...this.bubbles.values()]) this._disposeBubble(b);
  }

  /** activity ∈ [0,1] per layer key — drives lane glow. */
  setLayerActivity(key, v) {
    if (this.strata[key]) this.strata[key].activity = v;
  }

  spawnRipple(pos, color = 0x9dff57) {
    // expanding floor ring — ARP broadcast hitting the segment
    const geo = new THREE.RingGeometry(0.9, 1.05, 48);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, 0.12, pos.z);
    this.scene.add(ring);
    this.ripples.push({ ring, life: 1.5, max: 1.5 });
  }

  /** Faint persistent ribbons under active transport flows — structure instead of chaos. */
  syncFlowArcs(flows, router) {
    const seen = new Set();
    for (const f of flows) {
      if (f.proto !== 'TCP' && f.proto !== 'UDP') continue;
      if (!f.client || !f.server || f.dead) continue;
      seen.add(f);
      if (this.flowArcs.has(f)) continue;
      const alt = f.proto === 'TCP' ? LAYER_ALT.L4_TCP : LAYER_ALT.L4_UDP;
      const curve = flightCurve(f.client, f.server, router, alt, 0);
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(40));
      const color = f.proto === 'TCP' ? 0x00ccff : (f.rate ? 0xff66cc : 0xcc66ff);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.scene.add(line);
      this.flowArcs.set(f, { line, target: 0.10 });
    }
    for (const [f, rec] of this.flowArcs) {
      if (!seen.has(f)) rec.target = 0;       // fade out, removed in update()
    }
  }

  // ---------------- hosts ----------------

  addRouter(host, accent = 0xffd24d) {
    const group = new THREE.Group();
    group.position.set(host.pos.x, host.pos.y, host.pos.z);

    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(2.1, 0),
      new THREE.MeshStandardMaterial({
        color: 0x1a1408, roughness: 0.25, metalness: 0.8,
        emissive: accent, emissiveIntensity: 0.5,
      }),
    );
    core.userData.host = host;
    group.add(core);

    const ringMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.5 });
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.06, 8, 64), ringMat);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(4.3, 0.04, 8, 64), ringMat.clone());
    r2.material.opacity = 0.3;
    group.add(r1, r2);

    // light beam down to the grid — the router is the spine of the topology
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.5, host.pos.y, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: accent, transparent: true, opacity: 0.18,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    beam.position.y = -host.pos.y / 2;
    group.add(beam);

    group.add(this._label(`${host.name}\n${host.ip} · ${host.mac}`, accent, 4.4));
    this.scene.add(group);
    this.hostMeshes.set(host.id, {
      group, mesh: core, baseEmissive: 0.5, host, accent, spin: true, rings: [r1, r2],
    });
    return group;
  }

  addServer(host, accent) {
    const group = new THREE.Group();
    group.position.set(host.pos.x, 0, host.pos.z);

    const rackMat = new THREE.MeshStandardMaterial({
      color: 0x0a1428, roughness: 0.35, metalness: 0.7,
      emissive: accent, emissiveIntensity: 0.16,
    });
    const rack = new THREE.Mesh(new THREE.BoxGeometry(4.4, host.pos.y * 2, 4.4), rackMat);
    rack.position.y = host.pos.y;
    rack.userData.host = host;
    group.add(rack);

    // glowing slat lines (server LEDs)
    const slatMat = new THREE.MeshBasicMaterial({ color: accent });
    for (let i = 0; i < 6; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(4.55, 0.1, 4.55), slatMat);
      slat.position.y = 1.2 + i * (host.pos.y * 2 - 2) / 5.2;
      group.add(slat);
    }

    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(rack.geometry),
      new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.85 }),
    );
    edge.position.copy(rack.position);
    group.add(edge);

    group.add(this._label(`${host.name}\n${host.ip}`, accent, host.pos.y * 2 + 2.2));
    this.scene.add(group);
    this.hostMeshes.set(host.id, { group, mesh: rack, baseEmissive: 0.16, host, accent });
    return group;
  }

  addClient(host, accent = 0x41a6ff) {
    const group = new THREE.Group();
    group.position.set(host.pos.x, host.pos.y, host.pos.z);

    const mat = new THREE.MeshStandardMaterial({
      color: 0x0e1f3a, roughness: 0.3, metalness: 0.6,
      emissive: accent, emissiveIntensity: 0.35,
    });
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15, 0), mat);
    mesh.userData.host = host;
    group.add(mesh);

    const ringMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.7, 1.85, 32), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -host.pos.y + 0.05;
    group.add(ring);

    group.add(this._label(`${host.name}\n${host.ip}`, accent, 2.4));
    this.scene.add(group);
    this.hostMeshes.set(host.id, { group, mesh, baseEmissive: 0.35, host, accent, spin: true });
    return group;
  }

  addBot(host) {
    const accent = 0xff2244;
    const group = new THREE.Group();
    group.position.set(host.pos.x, host.pos.y, host.pos.z);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x220a12, roughness: 0.4, metalness: 0.5,
      emissive: accent, emissiveIntensity: 0.6,
    });
    const mesh = new THREE.Mesh(new THREE.TetrahedronGeometry(0.9), mat);
    mesh.userData.host = host;
    group.add(mesh);
    this.scene.add(group);
    this.hostMeshes.set(host.id, { group, mesh, baseEmissive: 0.6, host, accent, spin: true, bot: true, bornAt: performance.now() });
    return group;
  }

  removeHost(host) {
    const rec = this.hostMeshes.get(host.id);
    if (!rec) return;
    this.scene.remove(rec.group);
    rec.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
    this.hostMeshes.delete(host.id);
  }

  pulseHost(host, strength = 1.2) {
    const rec = this.hostMeshes.get(host.id);
    if (rec) rec.mesh.material.emissiveIntensity = Math.min(2.2, rec.baseEmissive + strength);
  }

  _label(text, color, y) {
    const lines = text.split('\n');
    const cnv = document.createElement('canvas');
    cnv.width = 512; cnv.height = 128;
    const ctx = cnv.getContext('2d');
    ctx.font = 'bold 42px Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#' + new THREE.Color(color).getHexString();
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 12;
    ctx.fillText(lines[0], 256, 50);
    ctx.font = '30px Menlo, monospace';
    ctx.fillStyle = 'rgba(160,200,255,0.75)';
    ctx.fillText(lines[1] || '', 256, 96);
    const tex = new THREE.CanvasTexture(cnv);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sprite.scale.set(9, 2.25, 1);
    sprite.position.y = y;
    return sprite;
  }

  // ---------------- picking ----------------

  setPacketLayer(layer) { this.packetLayer = layer; }

  _click(e) {
    this.pointer.x = (e.clientX / innerWidth) * 2 - 1;
    this.pointer.y = -(e.clientY / innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.raycaster.params.Mesh = { threshold: 0.5 };

    // packets first
    if (this.packetLayer) {
      const hit = this.raycaster.intersectObject(this.packetLayer.mesh, false)[0];
      if (hit && hit.instanceId !== undefined) {
        const pkt = this.packetLayer.packetAt(hit.instanceId);
        if (pkt && this.onPickPacket) { this.onPickPacket(pkt); return; }
      }
    }
    // then hosts
    const meshes = [...this.hostMeshes.values()].map(r => r.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (hit && this.onPickHost) this.onPickHost(hit.object.userData.host);
  }

  // ---------------- frame ----------------

  update(dtReal) {
    this.controls.update();
    for (const rec of this.hostMeshes.values()) {
      if (rec.spin) {
        rec.mesh.rotation.y += dtReal * 0.6;
        rec.mesh.rotation.x += dtReal * 0.2;
      }
      if (rec.rings) {
        rec.rings[0].rotation.x += dtReal * 0.5;
        rec.rings[1].rotation.y += dtReal * 0.32;
      }
      // decay pulse glow back to baseline
      const m = rec.mesh.material;
      if (m.emissiveIntensity > rec.baseEmissive) {
        m.emissiveIntensity = Math.max(rec.baseEmissive, m.emissiveIntensity - dtReal * 2.5);
      }
    }

    // layer strata: dashed rings drift, lanes glow with live traffic
    for (const s of Object.values(this.strata)) {
      s.dash.rotation.y += dtReal * 0.12 * s.dashDir;
      s.shown += (s.activity - s.shown) * Math.min(1, dtReal * 3);
      const a = s.shown;
      s.halo.material.opacity = 0.04 + a * 0.16;
      s.rim.material.opacity = 0.14 + a * 0.5;
      s.dash.material.opacity = 0.18 + a * 0.6;
      s.plate.material.opacity = 0.55 + a * 0.45;
      s.node.scale.setScalar(1 + a * 1.3);
    }

    // ARP ripples
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.life -= dtReal;
      if (r.life <= 0) {
        this.scene.remove(r.ring);
        r.ring.geometry.dispose();
        r.ring.material.dispose();
        this.ripples.splice(i, 1);
        continue;
      }
      const t = 1 - r.life / r.max;
      r.ring.scale.setScalar(1 + t * 16);
      r.ring.material.opacity = 0.85 * (1 - t);
    }

    // activity speech bubbles: bob gently, fade in/out
    for (const b of [...this.bubbles.values()]) {
      b.life -= dtReal;
      if (b.life <= 0) { this._disposeBubble(b); continue; }
      b.t += dtReal;
      b.sprite.position.y = b.baseY + Math.sin(b.t * 2.2) * 0.18;
      const elapsed = b.max - b.life;
      const fadeIn = Math.min(1, elapsed / 0.35);
      const fadeOut = Math.min(1, b.life / 0.9);
      b.sprite.material.opacity = 0.95 * Math.min(fadeIn, fadeOut);
    }

    // flow ribbons fade toward target opacity
    for (const [f, rec] of this.flowArcs) {
      const m = rec.line.material;
      m.opacity += (rec.target - m.opacity) * Math.min(1, dtReal * 2.5);
      if (rec.target === 0 && m.opacity < 0.01) {
        this.scene.remove(rec.line);
        rec.line.geometry.dispose();
        m.dispose();
        this.flowArcs.delete(f);
      }
    }
  }

  render() { this.composer.render(); }

  _resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
  }
}

function circleLine(radius, alt, color, opacity, dashed = false) {
  const pts = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 1.6, gapSize: 2.4 })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const line = new THREE.Line(geo, mat);
  if (dashed) line.computeLineDistances();
  line.position.y = alt;
  return line;
}

function makeRimTexture() {
  // transparent center, glow band at the rim
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0.0, 'rgba(255,255,255,0)');
  g.addColorStop(0.72, 'rgba(255,255,255,0)');
  g.addColorStop(0.88, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.97, 'rgba(255,255,255,0.25)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

function makePlate(title, sub, color) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 224;
  const ctx = c.getContext('2d');
  const hex = '#' + color.getHexString();
  // plate background
  ctx.fillStyle = 'rgba(4, 10, 24, 0.78)';
  roundRect(ctx, 8, 8, 1008, 208, 26);
  ctx.fill();
  ctx.strokeStyle = hex;
  ctx.lineWidth = 5;
  roundRect(ctx, 8, 8, 1008, 208, 26);
  ctx.stroke();
  // accent bar
  ctx.fillStyle = hex;
  ctx.fillRect(8, 8, 14, 208);
  // text
  ctx.font = 'bold 64px Menlo, monospace';
  ctx.fillStyle = hex;
  ctx.shadowColor = hex;
  ctx.shadowBlur = 16;
  ctx.fillText(title, 56, 92);
  ctx.shadowBlur = 0;
  ctx.font = '46px Menlo, monospace';
  ctx.fillStyle = 'rgba(170, 205, 240, 0.85)';
  ctx.fillText(sub, 56, 168);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, opacity: 0.85,
  }));
  sprite.scale.set(13, 2.85, 1);
  return sprite;
}

function makeBubble(text, color) {
  const font = '600 44px Menlo, "Apple Color Emoji", monospace';
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = font;
  const textW = Math.ceil(meas.measureText(text).width);
  const padX = 36, h = 96, tail = 18;
  const w = textW + padX * 2;

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h + tail;
  const ctx = c.getContext('2d');
  const hex = '#' + color.getHexString();

  ctx.fillStyle = 'rgba(6, 13, 28, 0.88)';
  roundRect(ctx, 3, 3, w - 6, h - 6, 22);
  ctx.fill();
  ctx.strokeStyle = hex;
  ctx.lineWidth = 3;
  roundRect(ctx, 3, 3, w - 6, h - 6, 22);
  ctx.stroke();
  // tail pointing down at the host
  ctx.beginPath();
  ctx.moveTo(w / 2 - 12, h - 4);
  ctx.lineTo(w / 2, h + tail - 2);
  ctx.lineTo(w / 2 + 12, h - 4);
  ctx.closePath();
  ctx.fillStyle = hex;
  ctx.fill();

  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#dcecff';
  ctx.fillText(text, w / 2, h / 2 - 2);

  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, opacity: 0,
  }));
  const scale = 0.034;                     // world units per canvas px
  sprite.scale.set(w * scale, (h + tail) * scale, 1);
  sprite.center.set(0.5, 0.18);            // anchor near the tail tip
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeRadialTexture(color, alpha) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
