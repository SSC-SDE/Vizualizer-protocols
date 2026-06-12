// Instanced packet tracers: every in-flight datagram is a glowing comet on a
// bezier arc. Lost packets flare red and fall out of the sky. Arrivals flash.

import * as THREE from 'three';
import { KIND_COLOR, KIND } from '../sim/engine.js';

const MAX = 3000;
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export class PacketLayer {
  constructor(scene) {
    const geo = new THREE.SphereGeometry(0.30, 10, 8);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < MAX; i++) {
      this.mesh.setMatrixAt(i, HIDDEN);
      this.mesh.setColorAt(i, white);
    }
    scene.add(this.mesh);

    this.free = [];
    for (let i = MAX - 1; i >= 0; i--) this.free.push(i);
    this.slotPkt = new Array(MAX).fill(null);
    this.live = new Map();       // pkt.id -> {pkt, curve, slot, color, size}
    this.dying = [];             // {pos, vel, slot, life, color}

    // arrival flash sprites
    this.flashes = [];
    this.flashTex = makeGlowTexture();
    this.flashPool = [];
    this.scene = scene;
  }

  packetAt(instanceId) { return this.slotPkt[instanceId]; }

  curveFor(pkt) {
    const a = hostPoint(pkt.src);
    const b = hostPoint(pkt.dst);
    const mid = a.clone().lerp(b, 0.5);
    const dist = a.distanceTo(b);
    // lane separation: opposite directions arc on opposite sides + jitter
    const dir = b.clone().sub(a).normalize();
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const sideSign = pkt.src.id > pkt.dst.id ? 1 : -1;
    mid.addScaledVector(side, sideSign * (1.5 + Math.random() * 2.2));
    mid.y += 3.5 + dist * 0.22 + Math.random() * 1.5;
    return new THREE.QuadraticBezierCurve3(a, mid, b);
  }

  onSend(pkt) {
    if (this.free.length === 0) return;       // pool exhausted — sim still correct
    const slot = this.free.pop();
    const color = new THREE.Color(KIND_COLOR[pkt.kind] ?? 0xffffff);
    // size by payload: ACKs are darts, full segments are comets
    const size = pkt.len > 1000 ? 1.5 : pkt.len > 100 ? 1.1 : 0.7;
    this.live.set(pkt.id, { pkt, curve: this.curveFor(pkt), slot, color, size });
    this.slotPkt[slot] = pkt;
    this.mesh.setColorAt(slot, color);
    this.mesh.instanceColor.needsUpdate = true;
  }

  onDeliver(pkt) {
    const rec = this.live.get(pkt.id);
    if (!rec) return;
    this.live.delete(pkt.id);
    this._freeSlot(rec.slot);
    if (pkt.kind !== KIND.DATA && pkt.kind !== KIND.ACK && pkt.kind !== KIND.STREAM) {
      this.spawnFlash(rec.curve.getPoint(1), rec.color, 2.2);
    }
  }

  onDrop(pkt) {
    const rec = this.live.get(pkt.id);
    if (!rec) return;
    this.live.delete(pkt.id);
    this.slotPkt[rec.slot] = null;            // dying instances aren't pickable
    const u = pkt.lostAt;
    const pos = rec.curve.getPoint(u);
    const vel = rec.curve.getTangent(u).multiplyScalar(6);
    this.dying.push({ pos, vel, slot: rec.slot, life: 1.4, color: rec.color.clone() });
    this.mesh.setColorAt(rec.slot, new THREE.Color(0xff2244));
    this.mesh.instanceColor.needsUpdate = true;
    this.spawnFlash(pos, new THREE.Color(0xff2244), 1.6);
  }

  _freeSlot(slot) {
    this.mesh.setMatrixAt(slot, HIDDEN);
    this.slotPkt[slot] = null;
    this.free.push(slot);
  }

  spawnFlash(pos, color, scale) {
    let sp = this.flashPool.pop();
    if (!sp) {
      sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flashTex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false,
      }));
      this.scene.add(sp);
    }
    sp.material.color = color.clone();
    sp.material.opacity = 0.9;
    sp.position.copy(pos);
    sp.scale.setScalar(0.4);
    sp.visible = true;
    this.flashes.push({ sp, life: 0.5, max: 0.5, targetScale: scale });
  }

  update(simTime, dtReal) {
    // in-flight packets
    for (const rec of this.live.values()) {
      const { pkt, curve, slot, size } = rec;
      const u = Math.min(1, Math.max(0, (simTime - pkt.t0) / (pkt.t1 - pkt.t0)));
      curve.getPoint(u, _p);
      curve.getTangent(u, _tan).normalize();
      _q.setFromUnitVectors(_zAxis, _tan);
      // comet stretch along direction of travel
      _s.set(size * 0.55, size * 0.55, size * 2.6);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(slot, _m);
    }

    // falling corpses of lost packets
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i];
      d.life -= dtReal;
      if (d.life <= 0 || d.pos.y < -2) {
        this._freeSlot(d.slot);
        this.dying.splice(i, 1);
        continue;
      }
      d.vel.y -= 22 * dtReal;
      d.pos.addScaledVector(d.vel, dtReal);
      const sc = Math.max(0.05, d.life) * 0.9;
      _m.compose(d.pos, _q.identity(), _s.set(sc, sc, sc));
      this.mesh.setMatrixAt(d.slot, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;

    // flashes
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dtReal;
      if (f.life <= 0) {
        f.sp.visible = false;
        this.flashPool.push(f.sp);
        this.flashes.splice(i, 1);
        continue;
      }
      const t = 1 - f.life / f.max;
      f.sp.scale.setScalar(0.4 + t * f.targetScale);
      f.sp.material.opacity = 0.9 * (1 - t);
    }
  }
}

function hostPoint(host) {
  // servers store half-height in pos.y → emit from mid-rack; others from body
  return new THREE.Vector3(host.pos.x, host.kind === 'server' ? host.pos.y : host.pos.y, host.pos.z);
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
