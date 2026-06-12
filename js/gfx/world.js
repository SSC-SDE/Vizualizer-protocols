// Three.js scene: datacenter core, client ring, starfield, bloom, picking.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { flightCurve, LAYER_ALT } from './paths.js';

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
    this._layerRings();

    this.ripples = [];
    this.flowArcs = new Map();     // flow -> {line, lastSeen}

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

  _layerRings() {
    // faint altitude rings labelling the OSI airspace lanes
    const layers = [
      { alt: LAYER_ALT.L2, color: 0x9dff57, label: 'L2 · LINK / ARP' },
      { alt: LAYER_ALT.L3, color: 0xff8866, label: 'L3 · NETWORK / ICMP' },
      { alt: LAYER_ALT.L4_UDP, color: 0xcc66ff, label: 'L4 · UDP' },
      { alt: LAYER_ALT.L4_TCP, color: 0x00ccff, label: 'L4 · TCP' },
    ];
    const R = 36;
    for (const l of layers) {
      const pts = [];
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * R, l.alt, Math.sin(a) * R));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: l.color, transparent: true, opacity: 0.10,
      }));
      this.scene.add(line);

      const sprite = this._label(l.label + '\n', l.color, 0);
      sprite.position.set(R * 0.78, l.alt + 0.9, -R * 0.62);
      sprite.scale.set(7, 1.75, 1);
      sprite.material.opacity = 0.5;
      this.scene.add(sprite);
    }
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
