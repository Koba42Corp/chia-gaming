import { expect, test } from "bun:test";
import {
  DEFAULT_BUS_COUNT,
  DEFAULT_ARCHETYPES_PER_BUS,
  SIN_LUT_Q14,
  SparseGraphicsBus,
  SparseAudioMixerBus,
  buildStomaSpongeGeometryBuffers,
  generateUnityURPBussingHLSL,
  transposeUnityProjectSummary,
  runLegacyUnbussedAudioReference,
} from "../src/index";

test("Stoma-Axis 3D geometry produces 39 vertices and 42 triangles with thickened midrib vs thin edges", () => {
  const geo = buildStomaSpongeGeometryBuffers();
  expect(geo.vertexCount).toBe(39);
  expect(geo.triangleCount).toBe(42);
  expect(geo.positions.length).toBe(39 * 3);
  expect(geo.leafMetrics.length).toBe(39 * 4);

  // Verify central midrib vertices (uSpan == 0) have strictly higher thicknessNorm than outer margins (|uSpan| == 1)
  let ribThickSum = 0;
  let ribCount = 0;
  let edgeThickSum = 0;
  let edgeCount = 0;
  for (let v = 0; v < geo.vertexCount; v++) {
    const u = geo.leafMetrics[v * 4 + 0];
    const thick = geo.leafMetrics[v * 4 + 2];
    if (Math.abs(u) < 0.01) {
      ribThickSum += thick;
      ribCount++;
    } else {
      edgeThickSum += thick;
      edgeCount++;
    }
  }
  expect(ribThickSum / ribCount).toBeGreaterThan((edgeThickSum / edgeCount) * 4);
});

test("SparseGraphicsBus packs 1,000x18 nodes into 140.63 KiB and computes Fluidic Sponge occlusion with 0 GC", () => {
  const bus = new SparseGraphicsBus({ busCount: DEFAULT_BUS_COUNT, archetypesPerBus: DEFAULT_ARCHETYPES_PER_BUS });
  expect(bus.nodeCount).toBe(18000);
  expect(bus.packedInstanceU16.byteLength).toBe(144000);

  // Verify Q1.14 LUT precision (>= 90 dB)
  let errSq = 0;
  let sigSq = 0;
  for (let i = 0; i < 256; i++) {
    const th = (i / 256) * Math.PI * 2;
    const ex = Math.sin(th);
    const q = SIN_LUT_Q14[i] / 16384;
    errSq += (ex - q) ** 2;
    sigSq += ex ** 2;
  }
  const snrDb = 10 * Math.log10(sigSq / errSq);
  expect(snrDb).toBeGreaterThan(90);

  // Capture scalar snapshot after West step because `step()` reuses `this.telemetry` for 0-GC efficiency
  const telW = bus.step(1 / 60, 1.0, { azimuthRad: -Math.PI * 0.5, speed: 1.4, choppiness: 0.75 }, { x: 0, z: 0 }, 0);
  const wSpongeLoad = telW.spongeCompressionLoad;
  const wOcclusion = telW.windOcclusionAttenuation;
  const wPan = telW.binauralPan;

  const telE = bus.step(1 / 60, 1.5, { azimuthRad: Math.PI * 0.5, speed: 1.4, choppiness: 0.75 }, { x: 0, z: 0 }, 0);
  const ePan = telE.binauralPan;

  expect(wSpongeLoad).toBeGreaterThan(0);
  expect(wOcclusion).toBeGreaterThan(0);
  expect(wPan).toBeGreaterThan(0.5); // Wind blowing toward West (-X) -> upwind source in East (+X)
  expect(ePan).toBeLessThan(-0.5);

  // Verify deterministic externality wind lock
  bus.setWindExternalityLock(true, { azimuthRad: -Math.PI * 0.5, speed: 1.2, choppiness: 0.5 });
  const lockedTel = bus.step(1 / 60, 2.0, { azimuthRad: Math.PI * 0.5, speed: 2.0, choppiness: 1.0 }, { x: 0, z: 0 }, 0);
  expect(lockedTel.binauralPan).toBeGreaterThan(0.5);
  bus.setWindExternalityLock(false);

  const prof = bus.getResourceProfile();
  expect(prof.liveStreamBytesPerFrame).toBe(48);
  expect(prof.compressionRatio).toBe(24000);
});

test("SparseAudioMixerBus collapses 256 raw 3D emitters into <=16 Haas-separated busses", () => {
  const graphics = new SparseGraphicsBus();
  const mixer = new SparseAudioMixerBus(16, 48000);
  const bundle = transposeUnityProjectSummary("UnitTestProject", [
    { relativePath: "Assets/Shaders/FoliageWind.shader", extension: ".shader", sizeBytes: 4096, contentSample: "DrawMeshInstanced Gerstner Foliage Universal" },
    { relativePath: "Assets/Scripts/SoundManager.cs", extension: ".cs", sizeBytes: 8192, contentSample: "AudioSource spatialBlend AudioMixer" },
    { relativePath: "Assets/Audio/wind_gust.wav", extension: ".wav", sizeBytes: 24000 },
  ]);

  const tel = graphics.step(1 / 60, 2.0, { azimuthRad: 0.8, speed: 1.25 }, { x: 0, z: 0 }, 0);
  const active = mixer.routeAndMixdownEmitters(bundle.audioMixerConfig.sampleEmitters, { x: 0, z: 0, yaw: 0 }, tel);
  expect(active).toBeGreaterThan(0);
  expect(active).toBeLessThanOrEqual(16);

  const outL = new Float32Array(512);
  const outR = new Float32Array(512);
  mixer.renderStereoBlock(outL, outR, tel);
  let energy = 0;
  for (let i = 0; i < 512; i++) energy += outL[i] * outL[i] + outR[i] * outR[i];
  expect(energy).toBeGreaterThan(0);
  expect(generateUnityURPBussingHLSL()).toContain("_SproutBusPacked");
  expect(runLegacyUnbussedAudioReference(4, 16)).not.toBeNaN();
});
