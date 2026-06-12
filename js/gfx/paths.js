// Shared flight-path geometry. The airspace is layered by OSI level:
// L2 (ARP) skims the floor, L3 (ICMP) flies low, L4 transport arcs high
// through the core router apex. One source of truth for packets + flow ribbons.

import * as THREE from 'three';
import { KIND } from '../sim/engine.js';

export const LAYER_ALT = {
  L2: 1.3,      // ARP — link layer, hugs the grid
  L3: 7.5,      // ICMP — network layer control
  L4_UDP: 12.5, // datagrams
  L4_TCP: 17.5, // connection-oriented streams, top lane
};

export function layerOf(pkt) {
  if (pkt.proto === 'ARP') return 'L2';
  if (pkt.proto === 'ICMP') return 'L3';
  if (pkt.kind === KIND.PROBE) return 'L3';   // traceroute probes live with their replies
  return pkt.proto === 'TCP' ? 'L4_TCP' : 'L4_UDP';
}

export function altitudeOf(pkt) { return LAYER_ALT[layerOf(pkt)]; }

export function hostPoint(host) {
  return new THREE.Vector3(host.pos.x, host.kind === 'server' ? host.pos.y : host.pos.y, host.pos.z);
}

/**
 * Build the arc for a packet or flow ribbon.
 * via: router host (or null for direct/link-local), alt: apex altitude,
 * lane: signed lateral offset to separate request/response lanes.
 */
export function flightCurve(srcHost, dstHost, via, alt, lane = 0) {
  const a = hostPoint(srcHost);
  const b = hostPoint(dstHost);
  const dir = b.clone().sub(a).setY(0).normalize();
  const side = new THREE.Vector3(-dir.z, 0, dir.x);

  if (via) {
    // arc over the router apex
    const apex = new THREE.Vector3(via.pos.x, alt * 1.18, via.pos.z);
    apex.addScaledVector(side, lane);
    return new THREE.QuadraticBezierCurve3(a, apex, b);
  }
  // direct hop: simple arc at the layer's altitude
  const mid = a.clone().lerp(b, 0.5);
  mid.addScaledVector(side, lane);
  mid.y = Math.max(mid.y, alt + a.distanceTo(b) * 0.06);
  return new THREE.QuadraticBezierCurve3(a, mid, b);
}

/** Lane offset: opposite directions keep to opposite sides; small jitter, tight. */
export function laneFor(pkt) {
  const sign = pkt.src.id > pkt.dst.id ? 1 : -1;
  return sign * (1.0 + Math.random() * 1.2);
}
