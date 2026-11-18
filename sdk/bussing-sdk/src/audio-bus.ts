/**
 * @sprout/bussing-sdk — Spatial Audio Mixdown & Acoustic Bussing Engine
 *
 * Implements SPROUT's Feedforward Direct + Haas-Separated Early Reflection + Porous Wind Occlusion
 * mixdown pipeline for high emitter counts (e.g., Unity scenes with hundreds of AudioSources):
 *   - Groups raw 3D emitters into Content-Addressed Acoustic Busses (spatial azimuth/distance buckets).
 *   - Enforces the 12.5 ms Haas precedence hold window separating Direct (Engine A) from Spatial
 *     reflections (Engine C), coalescing near-ground floor bounces (< 2.5 ms) into direct path.
 *   - Couples directly to SparseGraphicsBus telemetry so Fluidic Sponge wind absorption & directionality
 *     automatically modulate binaural stereo panning and air absorption lowpass cutoff.
 */

import type { GraphicsBusTelemetry } from "./graphics-bus";

export interface RawAudioEmitterSpec {
  id: string;
  x: number;
  y: number;
  z: number;
  gain: number;
  baseFreqHz?: number;
  kind?: "foliage" | "water" | "footstep" | "sfx" | "ambient" | "combat";
  spatialBlend?: number;
}

export interface AcousticBusChannel {
  busIndex: number;
  azimuthBin: number;
  sourceCount: number;
  gainAccum: number;
  centroidX: number;
  centroidY: number;
  centroidZ: number;
  directDelaySamples: number;
  haasReflectionDelaySamples: number;
  airCutoffHz: number;
  stereoPan: number;
  leftGain: number;
  rightGain: number;
}

export const HAAS_HOLD_MS = 12.5;
export const GROUND_COALESCE_MS = 2.5;
export const SPEED_OF_SOUND_MPS = 343.2;

export class SparseAudioMixerBus {
  readonly maxBusses: number;
  readonly sampleRate: number;
  readonly busses: AcousticBusChannel[];
  private activeBusCount = 0;
  private phaseAccum = 0;
  private lpLeftState = 0;
  private lpRightState = 0;

  constructor(maxBusses = 16, sampleRate = 48000) {
    this.maxBusses = Math.max(4, Math.min(64, maxBusses));
    this.sampleRate = sampleRate;
    this.busses = Array.from({ length: this.maxBusses }, (_, i) => ({
      busIndex: i,
      azimuthBin: i,
      sourceCount: 0,
      gainAccum: 0,
      centroidX: 0,
      centroidY: 0,
      centroidZ: 0,
      directDelaySamples: 0,
      haasReflectionDelaySamples: Math.round((HAAS_HOLD_MS * 0.001) * sampleRate),
      airCutoffHz: 4000,
      stereoPan: 0,
      leftGain: 0,
      rightGain: 0,
    }));
  }

  /**
   * Clusters N raw 3D game emitters (e.g. 500 Unity AudioSources) into <= K spatial busses
   * with Haas reflection separation & Fluidic Sponge wind absorption in O(N + K) with 0 GC.
   */
  routeAndMixdownEmitters(
    emitters: readonly RawAudioEmitterSpec[],
    listener: { x: number; y?: number; z: number; yaw?: number },
    windTelemetry?: GraphicsBusTelemetry
  ): number {
    for (let i = 0; i < this.maxBusses; i++) {
      const b = this.busses[i];
      b.sourceCount = 0;
      b.gainAccum = 0;
      b.centroidX = 0;
      b.centroidY = 0;
      b.centroidZ = 0;
    }

    const ly = listener.y ?? 1.6;
    const yaw = listener.yaw ?? 0;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);

    for (let i = 0; i < emitters.length; i++) {
      const e = emitters[i];
      const dx = e.x - listener.x;
      const dy = e.y - ly;
      const dz = e.z - listener.z;
      const dist = Math.hypot(dx, dy, dz);
      const atten = 1.0 / (1.0 + dist * 0.085);
      const effGain = e.gain * atten;
      if (effGain < 0.002) continue;

      // Rotate into listener local space to pick deterministic azimuth bus
      const rx = dx * cy + dz * sy;
      const rz = -dx * sy + dz * cy;
      const relAngle = Math.atan2(rx, -rz); // -PI..PI, 0 = straight ahead
      const normAz = (relAngle + Math.PI) / (Math.PI * 2);
      const bin = Math.min(this.maxBusses - 1, Math.max(0, Math.floor(normAz * this.maxBusses)));

      const bus = this.busses[bin];
      bus.sourceCount++;
      bus.gainAccum += effGain;
      bus.centroidX += e.x * effGain;
      bus.centroidY += e.y * effGain;
      bus.centroidZ += e.z * effGain;
    }

    const haasMinSamples = Math.round((HAAS_HOLD_MS * 0.001) * this.sampleRate);
    const coalesceThresholdM = (GROUND_COALESCE_MS * 0.001) * SPEED_OF_SOUND_MPS;
    const windOcc = windTelemetry?.windOcclusionAttenuation ?? 0.25;
    const windCutoff = windTelemetry?.airAbsorptionCutoffHz ?? 1400;

    let active = 0;
    for (let i = 0; i < this.maxBusses; i++) {
      const bus = this.busses[i];
      if (bus.sourceCount === 0 || bus.gainAccum <= 1e-6) {
        bus.leftGain = 0;
        bus.rightGain = 0;
        continue;
      }
      active++;
      const invW = 1.0 / bus.gainAccum;
      const cx = bus.centroidX * invW;
      const cyPos = bus.centroidY * invW;
      const cz = bus.centroidZ * invW;
      const dx = cx - listener.x;
      const dz = cz - listener.z;
      const dist = Math.hypot(dx, cyPos - ly, dz);

      const directSmp = Math.round((dist / SPEED_OF_SOUND_MPS) * this.sampleRate);
      // Coalesce near-ground bounce (< 2.5 ms extra path) vs Haas-separated canopy/wall reflection (>= 12.5 ms)
      const isGroundClose = cyPos < ly && dist < coalesceThresholdM * 3;
      const refSmp = isGroundClose ? directSmp : directSmp + haasMinSamples + Math.round((dist * 0.15 / SPEED_OF_SOUND_MPS) * this.sampleRate);

      const localRight = dx * cy + dz * sy;
      const pan = Math.max(-0.92, Math.min(0.92, localRight / Math.max(1.5, dist)));
      const clampedGain = Math.min(1.0, bus.gainAccum);
      const anglePan = (pan * 0.5 + 0.5) * (Math.PI * 0.5);

      bus.centroidX = cx;
      bus.centroidY = cyPos;
      bus.centroidZ = cz;
      bus.directDelaySamples = directSmp;
      bus.haasReflectionDelaySamples = refSmp;
      // Blend Fluidic Sponge porous absorption with distance air roll-off
      bus.airCutoffHz = Math.max(380, Math.min(18000, windCutoff * (1.8 - windOcc * 0.7) / (1.0 + dist * 0.03)));
      bus.stereoPan = pan;
      bus.leftGain = clampedGain * Math.cos(anglePan);
      bus.rightGain = clampedGain * Math.sin(anglePan);
    }

    this.activeBusCount = active;
    return active;
  }

  /**
   * Zero-allocation 512-sample real-time DSP mixdown over active spatial busses.
   */
  renderStereoBlock(outLeft: Float32Array, outRight: Float32Array, windTelemetry?: GraphicsBusTelemetry): void {
    const n = Math.min(outLeft.length, outRight.length);
    outLeft.fill(0, 0, n);
    outRight.fill(0, 0, n);

    const twoPiOverSr = (Math.PI * 2) / this.sampleRate;
    const baseFreq = 110 + (windTelemetry?.canopyTidalEnergy ?? 0.3) * 140;
    const phaseStep = baseFreq * twoPiOverSr;

    let lpCoefSum = 0;
    let totalL = 0;
    let totalR = 0;
    let count = 0;
    for (let b = 0; b < this.maxBusses; b++) {
      const bus = this.busses[b];
      if (bus.sourceCount === 0) continue;
      totalL += bus.leftGain;
      totalR += bus.rightGain;
      lpCoefSum += Math.min(0.95, (bus.airCutoffHz * twoPiOverSr));
      count++;
    }

    if (count === 0) return;
    const alpha = Math.max(0.05, Math.min(0.92, lpCoefSum / count));
    const normScale = 1.0 / Math.max(1.0, Math.sqrt(count));

    for (let s = 0; s < n; s++) {
      this.phaseAccum = (this.phaseAccum + phaseStep) % (Math.PI * 2);
      const excitation = Math.sin(this.phaseAccum) * 0.65 + Math.sin(this.phaseAccum * 1.498) * 0.35;
      const inL = excitation * totalL * normScale;
      const inR = excitation * totalR * normScale;
      this.lpLeftState += alpha * (inL - this.lpLeftState);
      this.lpRightState += alpha * (inR - this.lpRightState);
      outLeft[s] = this.lpLeftState;
      outRight[s] = this.lpRightState;
    }
  }

  getActiveBusCount(): number {
    return this.activeBusCount;
  }
}

/** Measures legacy unbussed N-voice DSP cost vs. O(K_bus) bussed CGSAE mixdown. */
export function runLegacyUnbussedAudioReference(emitterCount: number, samples: number): number {
  let acc = 0;
  let s0 = 0;
  let s1 = 0;
  for (let v = 0; v < emitterCount; v++) {
    const pan = ((v % 32) / 31) * 2 - 1;
    const gL = Math.cos((pan * 0.5 + 0.5) * 1.5707);
    const gR = Math.sin((pan * 0.5 + 0.5) * 1.5707);
    const cutoff = 0.12 + (v % 10) * 0.04;
    for (let i = 0; i < samples; i++) {
      const x = Math.sin((i + v) * 0.031);
      s0 += cutoff * (x * gL - s0);
      s1 += cutoff * (x * gR - s1);
      acc += s0 + s1;
    }
  }
  return acc;
}
