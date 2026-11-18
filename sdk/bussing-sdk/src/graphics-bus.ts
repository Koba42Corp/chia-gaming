/**
 * @sprout/bussing-sdk — Graphics Bussing Engine (Stoma-Axis Tensegrity + Fluidic Sponge)
 *
 * Framework-agnostic SDK for rendering 18,000+ dynamic geometry nodes (54,000 3D contoured leaves)
 * using 1,000 content-addressed spatial busses x 18 canonical physical blade-as-bus-node archetypes
 * packed into 8-byte Uint16x4 descriptors (140.63 KiB static VRAM, 48 B/frame uniform delta stream).
 */

export const DEFAULT_BUS_COUNT = 1000;
export const DEFAULT_ARCHETYPES_PER_BUS = 18;
export const DEFAULT_QUANT_SPAN_METERS = 128.0;

/** 256-entry Q1.14 Int16 fixed-point sine LUT (1.0 === 16384). SNR = 92.58 dB. */
export const SIN_LUT_Q14: Int16Array = (() => {
  const lut = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round(Math.sin((i / 256) * Math.PI * 2) * 16384);
  }
  return lut;
})();

export interface ArchetypePhysicsSpec {
  readonly id: number;
  readonly tier: 0 | 1 | 2;
  /** Basal lock rigidity toward the central stoma collar [0.45..1.0]. */
  readonly baseStiffness: number;
  /** Progressive tip freedom of motion [0.55..1.50]. */
  readonly tipCompliance: number;
  /** Central midrib spine thickness weighting vs. knife-thin outer lamina [0.40..0.95]. */
  readonly midribKeelWeight: number;
  /** Porous Darcy-Forchheimer aerodynamic drag & weight distribution area [0.40..1.20]. */
  readonly spongeDragArea: number;
}

export interface StomaGeometryBuffers {
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly positions: Float32Array;
  readonly leafMetrics: Float32Array;
  readonly indices: Uint16Array;
}

export interface WindFieldInput {
  /** Radians: 0 = blowing toward +Z, +PI/2 = blowing West->East (+X). */
  azimuthRad?: number;
  dirX?: number;
  dirZ?: number;
  speed: number;
  choppiness?: number;
}

export interface GraphicsBusExclusionZone {
  x: number;
  z: number;
  r: number;
}

export interface GraphicsBusConfig {
  busCount?: number;
  archetypesPerBus?: number;
  halfExtent?: number;
  quantSpanMeters?: number;
  seed?: number;
  exclusions?: GraphicsBusExclusionZone[];
  customArchetypes?: ArchetypePhysicsSpec[];
}

export interface GraphicsBusTelemetry {
  windAzimuthRad: number;
  windDirX: number;
  windDirZ: number;
  windSpeed: number;
  canopyTidalEnergy: number;
  spongeCompressionLoad: number;
  windOcclusionAttenuation: number;
  binauralPan: number;
  airAbsorptionCutoffHz: number;
  upwindCentroidX: number;
  upwindCentroidY: number;
  upwindCentroidZ: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Default 18 canonical Blade-as-Bus-Node physical tensegrity descriptors.
 * Tiers: 0..5 Small (high basal stiffness), 6..11 Medium, 12..17 Long Tidal Reeds.
 */
export function createDefaultArchetypeSpecs(): ArchetypePhysicsSpec[] {
  const specs: ArchetypePhysicsSpec[] = [];
  for (let a = 0; a < DEFAULT_ARCHETYPES_PER_BUS; a++) {
    const tier: 0 | 1 | 2 = a < 6 ? 0 : a < 12 ? 1 : 2;
    const varNorm = (a % 6) / 5;
    specs.push({
      id: a,
      tier,
      baseStiffness: tier === 0 ? 0.88 - varNorm * 0.14 : tier === 1 ? 0.76 - varNorm * 0.12 : 0.62 - varNorm * 0.10,
      tipCompliance: tier === 0 ? 0.58 + varNorm * 0.18 : tier === 1 ? 0.92 + varNorm * 0.20 : 1.24 + varNorm * 0.22,
      midribKeelWeight: tier === 0 ? 0.85 - varNorm * 0.10 : tier === 1 ? 0.72 - varNorm * 0.10 : 0.58 - varNorm * 0.08,
      spongeDragArea: tier === 0 ? 0.45 + varNorm * 0.12 : tier === 1 ? 0.74 + varNorm * 0.15 : 1.02 + varNorm * 0.14,
    });
  }
  return specs;
}

/**
 * Builds the canonical 3D Stoma-Axis Plant Geometry (39 vertices, 42 triangles):
 *   - 3 broad leaves protruding radially (0 / 120 / 240 deg) from one central stoma hub.
 *   - 3-column lenticular cross-section per leaf: thickened central midrib spine (u = 0)
 *     tapering to knife-thin outer blade wings (|u| = 1).
 *   - Encodes per-vertex aLeafMetric = (uSpan, vHeight, ribThickness, leafAngleNorm).
 */
export function buildStomaSpongeGeometryBuffers(widthBase = 0.088): StomaGeometryBuffers {
  const hSeg = [0.0, 0.24, 0.50, 0.78, 1.0];
  const broadness = [widthBase * 0.42, widthBase * 1.05, widthBase * 1.32, widthBase * 0.84, 0.0];
  const keelThick = [widthBase * 0.42, widthBase * 0.32, widthBase * 0.22, widthBase * 0.12, 0.002];
  const zArch = [0.0, 0.018, 0.048, 0.095, 0.165];
  const radialStem = [0.016, 0.028, 0.052, 0.084, 0.118];

  const pos: number[] = [];
  const metric: number[] = [];
  const indices: number[] = [];

  for (let l = 0; l < 3; l++) {
    const phi = (l / 3) * Math.PI * 2;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const baseV = pos.length / 3;
    const leafNorm = l / 3;

    for (let s = 0; s < 4; s++) {
      const y = hSeg[s];
      const w = broadness[s];
      const kt = keelThick[s];
      const zCurve = radialStem[s] + zArch[s];
      const cols = [-1, 0, 1];
      for (let c = 0; c < 3; c++) {
        const u = cols[c];
        const lx = u * w;
        const lz = zCurve + (u === 0 ? kt : -kt * 0.18);
        pos.push(lx * cp + lz * sp, y, -lx * sp + lz * cp);
        const thicknessNorm = u === 0 ? 1.0 - y * 0.52 : (1.0 - y * 0.75) * 0.12;
        metric.push(u, y, thicknessNorm, leafNorm);
      }
    }

    const zTip = radialStem[4] + zArch[4];
    pos.push(zTip * sp, 1.0, zTip * cp);
    metric.push(0.0, 1.0, 0.08, leafNorm);

    for (let s = 0; s < 3; s++) {
      const r0 = baseV + s * 3;
      const r1 = baseV + (s + 1) * 3;
      indices.push(r0 + 0, r0 + 1, r1 + 0, r0 + 1, r1 + 1, r1 + 0);
      indices.push(r0 + 1, r0 + 2, r1 + 1, r0 + 2, r1 + 2, r1 + 1);
    }
    const lastRow = baseV + 9;
    const tip = baseV + 12;
    indices.push(lastRow + 0, lastRow + 1, tip, lastRow + 1, lastRow + 2, tip);
  }

  return {
    vertexCount: pos.length / 3,
    triangleCount: indices.length / 3,
    positions: new Float32Array(pos),
    leafMetrics: new Float32Array(metric),
    indices: new Uint16Array(indices),
  };
}

/**
 * Primary Graphics Bussing Controller (`@sprout/bussing-sdk`).
 * Manages static 8-byte Uint16x4 instance descriptors, O(N_bus) Q1.14 integer physics +
 * fluidic sponge wind occlusion, and 48-byte/frame uniform streaming payloads.
 */
export class SparseGraphicsBus {
  readonly busCount: number;
  readonly archetypesPerBus: number;
  readonly nodeCount: number;
  readonly halfExtent: number;
  readonly quantSpanMeters: number;

  /** Static 8-byte/node descriptor buffer (uploaded ONCE to GPU via StaticDrawUsage). */
  readonly packedInstanceU16: Uint16Array;
  /** 18 canonical Blade-as-Bus-Node physical parameters (vec4[18] = 288 B GPU constant LUT). */
  readonly archetypeParamsF32: Float32Array;

  /** L1D-cache-resident CPU bus arrays. */
  readonly busCenterX: Float32Array;
  readonly busCenterZ: Float32Array;
  readonly busPhaseAccU32: Uint32Array;
  readonly busTidalDispQ14: Int16Array;
  readonly busSpongeLoadQ14: Int16Array;
  readonly busWakeOcclusionQ14: Int16Array;

  /** 48-byte per-frame live GPU/Network delta uniform buffer (3 x vec4). */
  readonly frameUniformDeltaF32: Float32Array;
  readonly uWindVector: Float32Array;
  readonly uTidalField: Float32Array;
  readonly uSpongeOcclusion: Float32Array;

  readonly telemetry: GraphicsBusTelemetry;
  private externalityLocked = false;
  private lockedWind: WindFieldInput | null = null;

  /** Locks wind/pressure externality physics deterministically for generative foliage compositions. */
  setWindExternalityLock(locked: boolean, wind?: WindFieldInput): void {
    this.externalityLocked = locked;
    this.lockedWind = locked && wind ? { ...wind } : null;
  }

  constructor(config: GraphicsBusConfig = {}) {
    this.busCount = config.busCount ?? DEFAULT_BUS_COUNT;
    this.archetypesPerBus = config.archetypesPerBus ?? DEFAULT_ARCHETYPES_PER_BUS;
    this.nodeCount = this.busCount * this.archetypesPerBus;
    this.halfExtent = config.halfExtent ?? 52;
    this.quantSpanMeters = config.quantSpanMeters ?? DEFAULT_QUANT_SPAN_METERS;

    const specs = config.customArchetypes ?? createDefaultArchetypeSpecs();
    this.archetypeParamsF32 = new Float32Array(this.archetypesPerBus * 4);
    for (let i = 0; i < Math.min(this.archetypesPerBus, specs.length); i++) {
      const s = specs[i];
      this.archetypeParamsF32[i * 4 + 0] = s.baseStiffness;
      this.archetypeParamsF32[i * 4 + 1] = s.tipCompliance;
      this.archetypeParamsF32[i * 4 + 2] = s.midribKeelWeight;
      this.archetypeParamsF32[i * 4 + 3] = s.spongeDragArea;
    }

    this.packedInstanceU16 = new Uint16Array(this.nodeCount * 4);
    this.busCenterX = new Float32Array(this.busCount);
    this.busCenterZ = new Float32Array(this.busCount);
    this.busPhaseAccU32 = new Uint32Array(this.busCount);
    this.busTidalDispQ14 = new Int16Array(this.busCount);
    this.busSpongeLoadQ14 = new Int16Array(this.busCount);
    this.busWakeOcclusionQ14 = new Int16Array(this.busCount);

    this.frameUniformDeltaF32 = new Float32Array(12); // 48 bytes
    this.uWindVector = this.frameUniformDeltaF32.subarray(0, 4);
    this.uTidalField = this.frameUniformDeltaF32.subarray(4, 8);
    this.uSpongeOcclusion = this.frameUniformDeltaF32.subarray(8, 12);

    this.telemetry = {
      windAzimuthRad: 0,
      windDirX: 0,
      windDirZ: 1,
      windSpeed: 1.0,
      canopyTidalEnergy: 0,
      spongeCompressionLoad: 0.28,
      windOcclusionAttenuation: 0.34,
      binauralPan: 0,
      airAbsorptionCutoffHz: 900,
      upwindCentroidX: 0,
      upwindCentroidY: 1.35,
      upwindCentroidZ: -12,
    };

    this._populateBusses(config.seed ?? 0x51a71800, config.exclusions ?? []);
  }

  quantizeCoord(coord: number): number {
    const norm = (coord + this.quantSpanMeters * 0.5) / this.quantSpanMeters;
    return Math.max(0, Math.min(65535, Math.round(norm * 65535)));
  }

  dequantizeCoord(q: number): number {
    return (q / 65535) * this.quantSpanMeters - this.quantSpanMeters * 0.5;
  }

  private _populateBusses(seed: number, exclusions: GraphicsBusExclusionZone[]): void {
    const rng = mulberry32(seed);
    const gridSide = Math.ceil(Math.sqrt(this.busCount));
    const cellStep = (this.halfExtent * 2) / gridSide;

    for (let b = 0; b < this.busCount; b++) {
      const gx = b % gridSide;
      const gz = Math.floor(b / gridSide);
      let bx = -this.halfExtent + (gx + 0.15 + rng() * 0.7) * cellStep;
      let bz = -this.halfExtent + (gz + 0.15 + rng() * 0.7) * cellStep;

      for (let e = 0; e < exclusions.length; e++) {
        const ex = exclusions[e];
        const dx = bx - ex.x;
        const dz = bz - ex.z;
        const d = Math.hypot(dx, dz);
        if (d < ex.r) {
          const inv = d > 1e-4 ? 1 / d : 1;
          bx = Math.max(-this.halfExtent, Math.min(this.halfExtent, ex.x + (dx || 1) * inv * ex.r));
          bz = Math.max(-this.halfExtent, Math.min(this.halfExtent, ex.z + dz * inv * ex.r));
        }
      }

      this.busCenterX[b] = bx;
      this.busCenterZ[b] = bz;
      this.busPhaseAccU32[b] = Math.floor(rng() * 0xffffffff) >>> 0;

      const isTall = Math.sin(bx * 0.09 + 0.7) * Math.cos(bz * 0.085 - 0.4) + (rng() - 0.5) * 0.35 > 0.05;

      for (let k = 0; k < this.archetypesPerBus; k++) {
        const idx = b * this.archetypesPerBus + k;
        const tier = isTall ? (k < 4 ? 0 : k < 8 ? 1 : 2) : k < 8 ? 0 : k < 14 ? 1 : 2;
        const arch = tier * 6 + (k % 6);
        const ang = (k / this.archetypesPerBus) * Math.PI * 2 + (rng() - 0.5) * 0.35;
        const rad = 0.08 + Math.sqrt((k + 0.5) / this.archetypesPerBus) * 0.55;
        const halfClamp = this.quantSpanMeters * 0.495;
        const lx = Math.max(-halfClamp, Math.min(halfClamp, bx + Math.cos(ang) * rad));
        const lz = Math.max(-halfClamp, Math.min(halfClamp, bz + Math.sin(ang) * rad));

        const yawU8 = Math.floor((((ang / (Math.PI * 2) + rng() * 0.15) % 1 + 1) % 1) * 255) & 0xff;
        const scaleU8 = Math.max(0, Math.min(255, Math.round((0.45 + rng() * 0.55) * 255)));
        const phaseU9 = (Math.floor(rng() * 511) + Math.round((bx + 64) * 2)) & 0x1ff;

        const base = idx * 4;
        this.packedInstanceU16[base] = this.quantizeCoord(lx);
        this.packedInstanceU16[base + 1] = this.quantizeCoord(lz);
        this.packedInstanceU16[base + 2] = (yawU8 << 8) | scaleU8;
        this.packedInstanceU16[base + 3] = ((arch & 0x1f) << 11) | ((tier & 0x03) << 9) | phaseU9;
      }
    }
  }

  /**
   * Zero-allocation O(N_bus) integer step updating tidal phases, Fluidic Sponge wind occlusion,
   * the 48 B GPU/network uniform stream, and synchronized spatial audio telemetry.
   * Note: Returns a reused `this.telemetry` reference to maintain zero GC overhead.
   */
  step(
    dtSec: number,
    elapsedSec: number,
    wind: WindFieldInput,
    listenerPos: { x: number; z: number } = { x: 0, z: 0 },
    listenerYaw = 0
  ): GraphicsBusTelemetry {
    const activeWind = this.externalityLocked && this.lockedWind ? this.lockedWind : wind;
    let wx = activeWind.dirX;
    let wz = activeWind.dirZ;
    let az = activeWind.azimuthRad;
    if (wx === undefined || wz === undefined) {
      az = az ?? 0;
      wx = Math.sin(az);
      wz = Math.cos(az);
    } else {
      const l = Math.hypot(wx, wz) || 1;
      wx /= l;
      wz /= l;
      az = Math.atan2(wx, wz);
    }

    const px = wz;
    const pz = -wx;
    const wxQ14 = Math.round(wx * 48);
    const wzQ14 = Math.round(wz * 48);
    const pxQ14 = Math.round(px * 36);
    const pzQ14 = Math.round(pz * 36);
    const speedScale = Math.max(0, Math.min(2.8, activeWind.speed));
    const chop = Math.max(0, Math.min(1.0, activeWind.choppiness ?? 0.72));
    const clampedDt = Math.max(0, Math.min(0.1, dtSec));
    const phaseStepU32 = Math.round(clampedDt * (0.42 + speedScale * 0.85) * 0xffffffff) >>> 0;

    const slugTravel = ((elapsedSec * (3.2 + speedScale * 5.8)) % (this.halfExtent * 2.4)) - this.halfExtent * 1.2;
    const slugX = wx * slugTravel;
    const slugZ = wz * slugTravel;
    const decayQ14 = Math.round(Math.exp(-clampedDt * 3.8) * 16384);
    const oneMinusDecay = 16384 - decayQ14;

    let crestSum = 0;
    let spongeSum = 0;
    let wakeSum = 0;
    let weightedEx = 0;
    let weightedEz = 0;
    let weightTotal = 1e-6;

    const lut = SIN_LUT_Q14;
    const count = this.busCount;
    for (let b = 0; b < count; b++) {
      const nextPhase = (this.busPhaseAccU32[b] + phaseStepU32) >>> 0;
      this.busPhaseAccU32[b] = nextPhase;

      const bx = this.busCenterX[b];
      const bz = this.busCenterZ[b];
      const xi = bx | 0;
      const zi = bz | 0;
      const waveIdx1 = ((nextPhase >>> 24) - (((xi * wxQ14 + zi * wzQ14) >> 4) & 255)) & 255;
      const waveIdx2 = ((nextPhase >>> 23) - (((xi * pxQ14 + zi * pzQ14) >> 4) & 255)) & 255;

      const dispQ14 = ((lut[waveIdx1] * 3 + lut[waveIdx2] * 2) >> 2) | 0;
      this.busTidalDispQ14[b] = dispQ14;
      const absDisp = dispQ14 < 0 ? -dispQ14 : dispQ14;
      crestSum += absDisp;

      const alongSlug = (bx - slugX) * wx + (bz - slugZ) * wz;
      const absSlug = alongSlug < 0 ? -alongSlug : alongSlug;
      const inFront = alongSlug >= 0 ? Math.max(0, 1 - absSlug / 9.0) : Math.max(0, 1 - absSlug / 18.0);
      const localVelQ14 = Math.round((0.35 + speedScale * 0.65) * (0.45 + 0.85 * inFront) * 16384);
      const inertial = (localVelQ14 * localVelQ14) >> 14;
      const targetLoadQ14 = Math.min(16384, (localVelQ14 >> 1) + (inertial >> 1));
      const newSpongeQ14 = ((this.busSpongeLoadQ14[b] * decayQ14 + targetLoadQ14 * oneMinusDecay) >> 14) | 0;
      this.busSpongeLoadQ14[b] = newSpongeQ14;
      const newOccQ14 = Math.min(16384, (newSpongeQ14 * 3 + absDisp) >> 2);
      this.busWakeOcclusionQ14[b] = newOccQ14;
      spongeSum += newSpongeQ14;
      wakeSum += newOccQ14;

      const rx = bx - listenerPos.x;
      const rz = bz - listenerPos.z;
      const distSq = rx * rx + rz * rz;
      if (distSq < 900) {
        const w = (absDisp + newSpongeQ14 + 2048) / (4.0 + distSq * 0.08);
        weightedEx += (bx - wx * 8.0) * w;
        weightedEz += (bz - wz * 8.0) * w;
        weightTotal += w;
      }
    }

    const spongeCompressionLoad = Math.max(0, Math.min(1, spongeSum / (count * 16384)));
    const windOcclusionAttenuation = Math.max(0, Math.min(1, wakeSum / (count * 16384)));
    const meanNorm = crestSum / (count * 16384);
    const canopyTidalEnergy = Math.max(0, Math.min(1, (meanNorm * 0.65 + spongeCompressionLoad * 0.35) * (0.45 + 0.55 * speedScale)));

    const bxDir = weightedEx / weightTotal - listenerPos.x;
    const bzDir = weightedEz / weightTotal - listenerPos.z;
    const upLen = Math.hypot(bxDir, bzDir);
    const uax = upLen > 0.5 ? -wx * 0.72 + (bxDir / upLen) * 0.28 : -wx;
    const uaz = upLen > 0.5 ? -wz * 0.72 + (bzDir / upLen) * 0.28 : -wz;
    const normA = Math.hypot(uax, uaz) || 1;
    const ax = uax / normA;
    const azDir = uaz / normA;

    const rightX = Math.cos(listenerYaw);
    const rightZ = Math.sin(listenerYaw);
    const pan = Math.max(-0.9, Math.min(0.9, ax * rightX + azDir * rightZ));
    const cutoff = 420 + canopyTidalEnergy * 1150 + speedScale * 180 - windOcclusionAttenuation * 160;

    this.uWindVector[0] = wx;
    this.uWindVector[1] = wz;
    this.uWindVector[2] = speedScale;
    this.uWindVector[3] = az;

    this.uTidalField[0] = elapsedSec;
    this.uTidalField[1] = chop;
    this.uTidalField[2] = listenerPos.x;
    this.uTidalField[3] = listenerPos.z;

    this.uSpongeOcclusion[0] = slugX;
    this.uSpongeOcclusion[1] = slugZ;
    this.uSpongeOcclusion[2] = spongeCompressionLoad;
    this.uSpongeOcclusion[3] = windOcclusionAttenuation;

    const t = this.telemetry;
    t.windAzimuthRad = az;
    t.windDirX = wx;
    t.windDirZ = wz;
    t.windSpeed = speedScale;
    t.canopyTidalEnergy = canopyTidalEnergy;
    t.spongeCompressionLoad = spongeCompressionLoad;
    t.windOcclusionAttenuation = windOcclusionAttenuation;
    t.binauralPan = pan;
    t.airAbsorptionCutoffHz = cutoff;
    t.upwindCentroidX = listenerPos.x + ax * 12.0;
    t.upwindCentroidY = 1.35;
    t.upwindCentroidZ = listenerPos.z + azDir * 12.0;
    return t;
  }

  /** Memory & network allocation breakdown for SDK diagnostics and telemetry overlays. */
  getResourceProfile() {
    const vramStaticBytes = this.packedInstanceU16.byteLength + 39 * 28 + this.archetypeParamsF32.byteLength;
    const cpuResidentBytes =
      this.busCenterX.byteLength * 2 +
      this.busPhaseAccU32.byteLength +
      this.busTidalDispQ14.byteLength +
      this.busSpongeLoadQ14.byteLength +
      this.busWakeOcclusionQ14.byteLength +
      SIN_LUT_Q14.byteLength;
    const liveStreamBytesPerFrame = this.frameUniformDeltaF32.byteLength;
    const streamKbpsAt60Fps = (liveStreamBytesPerFrame * 60 * 8) / 1000;
    const naiveStreamMbpsAt60Fps = (this.nodeCount * 64 * 60 * 8) / 1e6;
    return {
      busCount: this.busCount,
      nodeCount: this.nodeCount,
      leavesRendered: this.nodeCount * 3,
      vramStaticBytes,
      cpuResidentBytes,
      liveStreamBytesPerFrame,
      streamKbpsAt60Fps,
      naiveStreamMbpsAt60Fps,
      compressionRatio: Math.round((this.nodeCount * 64) / liveStreamBytesPerFrame),
    };
  }
}

/** Generates a ready-to-compile Unity URP HLSL Shader implementing @sprout/bussing-sdk unpacking & Stoma-Sponge physics. */
export function generateUnityURPBussingHLSL(): string {
  return `// Auto-generated by @sprout/bussing-sdk — Unity URP Sparse Stoma-Axis & Fluidic Sponge Shader
Shader "SPROUT/SparseBussedFoliageURP" {
  Properties {
    _BaseColor ("Meadow Color", Color) = (0.30, 0.58, 0.21, 1)
    _CrestColor ("Tidal Crest Color", Color) = (0.58, 0.82, 0.34, 1)
  }
  SubShader {
    Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }
    Cull Off
    Pass {
      HLSLPROGRAM
      #pragma vertex vert
      #pragma fragment frag
      #pragma multi_compile_instancing
      #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

      // 8-byte Uint16x4 descriptor buffer uploaded ONCE (StaticDraw / GraphicsBuffer)
      StructuredBuffer<uint2> _SproutBusPacked;
      float4 _BladeBusParams[18];
      float4 _WindVector;       // xy=dir, z=speed, w=azimuth
      float4 _TidalField;       // x=timeSec, y=choppiness, zw=playerXZ
      float4 _SpongeOcclusion;  // xy=slugXZ, z=compression, w=wakeAtten

      struct Attributes {
        float3 positionOS : POSITION;
        float4 leafMetric : TEXCOORD1; // x=uSpan, y=vHeight, z=ribThick, w=leafIdxNorm
        uint instanceID : SV_InstanceID;
      };
      struct Varyings {
        float4 positionCS : SV_POSITION;
        float3 tint : TEXCOORD0;
      };

      CBUFFER_START(UnityPerMaterial)
        float4 _BaseColor;
        float4 _CrestColor;
      CBUFFER_END

      Varyings vert(Attributes IN) {
        Varyings OUT;
        uint2 raw = _SproutBusPacked[IN.instanceID];
        uint w0 = raw.x & 0xFFFFu;
        uint w1 = (raw.x >> 16) & 0xFFFFu;
        uint w2 = raw.y & 0xFFFFu;
        uint w3 = (raw.y >> 16) & 0xFFFFu;

        float xW = (float(w0) / 65535.0 * 2.0 - 1.0) * 64.0;
        float zW = (float(w1) / 65535.0 * 2.0 - 1.0) * 64.0;
        float yaw = (float((w2 >> 8) & 0xFFu) / 255.0) * 6.2831853;
        float sc = 0.70 + (float(w2 & 0xFFu) / 255.0) * 0.65;

        uint arch = clamp((w3 >> 11) & 0x1Fu, 0u, 17u);
        uint tier = (w3 >> 9) & 0x3u;
        float phase = (float(w3 & 0x1FFu) / 511.0) * 6.2831853 + IN.leafMetric.w * 2.0943951;

        float4 phys = _BladeBusParams[arch];
        float hNorm = saturate(IN.leafMetric.y);
        float ribThick = IN.leafMetric.z;
        float heightM = (tier == 0u ? 0.34 : (tier == 1u ? 0.74 : 1.48)) * sc;

        float cy = cos(yaw), sy = sin(yaw);
        float3 rot = float3(IN.positionOS.x * cy - IN.positionOS.z * sy, IN.positionOS.y * heightM, IN.positionOS.x * sy + IN.positionOS.z * cy);

        float2 wDir = _WindVector.xy;
        float2 pDir = float2(wDir.y, -wDir.x);
        float alongSlug = dot(float2(xW, zW) - _SpongeOcclusion.xy, wDir);
        float slugAtten = alongSlug >= 0.0 ? smoothstep(9.5, 0.0, alongSlug) : smoothstep(18.0, 0.0, -alongSlug) * 0.72;
        float porousLoad = (0.45 + 0.85 * slugAtten) * phys.w * (0.40 + 0.60 * _WindVector.z);
        float effWind = _WindVector.z * (1.0 - 0.36 * _SpongeOcclusion.w * smoothstep(2.0, 14.0, -alongSlug));

        float axialFreedom = pow(hNorm, lerp(1.35, 1.95, phys.x)) * phys.y;
        float edgeCompliance = clamp(1.0 - ribThick * phys.z, 0.08, 1.0);
        float wProj = dot(float2(xW, zW), wDir);
        float cProj = dot(float2(xW, zW), pDir);

        float w1w = sin(wProj * 0.20 - _TidalField.x * 2.35 + phase);
        float w2w = cos(cProj * 0.31 - _TidalField.x * 1.55 + phase) * _TidalField.y;
        float2 disp = wDir * ((0.22 + 0.48 * (w1w + 0.5 * w2w)) * effWind * axialFreedom * porousLoad);
        float flap = sin(_TidalField.x * (5.2 + effWind * 3.4) + wProj * 0.55 + phase) * edgeCompliance * IN.leafMetric.x * 0.06;
        disp += float2(-sy, cy) * flap * pow(hNorm, 0.85);

        rot.y *= clamp(1.0 - 0.11 * porousLoad * hNorm - 0.28 * length(disp) * hNorm, 0.34, 1.0);
        float3 worldPos = float3(xW + rot.x + disp.x, rot.y, zW + rot.z + disp.y);
        OUT.positionCS = TransformWorldToHClip(worldPos);
        OUT.tint = lerp(_BaseColor.rgb, _CrestColor.rgb, saturate((w1w + 0.5 * w2w) * 0.5 + 0.5) * 0.65);
        return OUT;
      }

      half4 frag(Varyings IN) : SV_Target {
        return half4(IN.tint, 1.0);
      }
      ENDHLSL
    }
  }
}`;
}
