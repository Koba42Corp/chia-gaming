# `@sprout/bussing-sdk` — Dual-Path Graphics & Spatial Audio Bussing SDK

A reusable, zero-dependency developer SDK for building scenes and external experiences in the SPROUT **Content-Addressed Sparse Bussing** style—handling tens of thousands of contoured 3D animated foliage/mesh nodes and hundreds of spatial audio emitters in tiny fixed memory budgets with **24,000×** live streaming bandwidth compression.

## Architecture Overview

1. **`SparseGraphicsBus` (`src/graphics-bus.ts`)**
   - **Content-Addressed Storage (`1,000 × 18`):** Allocates `1,000` spatial busses referencing `18` physical **Blade-as-a-Bus-Node** archetypes (`[baseStiffness, tipCompliance, midribKeelWeight, spongeDragArea]`).
   - **8-Byte Static Descriptor (`Uint16x4`):** Packs `18,000` stoma hubs (`54,000` 3D contoured leaves via `buildStomaSpongeGeometryBuffers`) into `144,000 B` (`140.63 KiB`), uploaded once (`StaticDrawUsage`).
   - **Q1.14 Integer Path + Fluidic Sponge Wind Occlusion:** Advances wave phases and Darcy–Forchheimer porous wind drag (`busSpongeLoadQ14`, `busWakeOcclusionQ14`) in `O(N_bus = 1,000)`, emitting only `48 B/frame` (`uWindVector`, `uTidalField`, `uSpongeOcclusion`).
   - **Externality Wind Locking:** Supports deterministic locked wind vectors so generative grass compositions hold exact force fields across frames and network clients.

2. **`SparseAudioMixerBus` (`src/audio-bus.ts`)**
   - Clusters `N` 3D emitters (`AudioSource` voices, footsteps, water waves, canopy rustle) into `K <= 16` directional acoustic busses (`O(N + K)`).
   - Preserves SPROUT's **Feedforward Direct + 12.5 ms Haas Reflection Separation + < 2.5 ms Ground Bounce Coalescing** and automatically modulates stereo panning + air absorption lowpass cutoff from `SparseGraphicsBus.telemetry`.

3. **`UnityProjectTransposer` (`src/unity-transposer.ts`)**
   - Parses Unity `.shader`, `.hlsl`, `.shadergraph`, `.cs`, `.prefab`, `.mat`, and audio assets, generating SPROUT `Uint16x4` descriptors, transposed Unity URP HLSL (`generateUnityURPBussingHLSL`), and Haas-separated `SparseAudioMixerBus` configurations.

## Quickstart for External Developers

```ts
import {
  SparseGraphicsBus,
  SparseAudioMixerBus,
  buildStomaSpongeGeometryBuffers,
} from "@sprout/bussing-sdk"; // or "@sprout/experience-sdk"

// 1. Initialize static 1,000 x 18 Stoma-Axis bus topology (140.63 KiB VRAM)
const gfx = new SparseGraphicsBus({ busCount: 1000, archetypesPerBus: 18, halfExtent: 52 });
const audio = new SparseAudioMixerBus(16, 48000);
const stomaGeo = buildStomaSpongeGeometryBuffers(); // 39-vert, 3-leaf lenticular midrib mesh

// 2. Inside render/simulation tick (48 B/frame delta stream, 0 B GC)
const windTel = gfx.step(dt, elapsed, { azimuthRad: 0.785, speed: 1.35, choppiness: 0.75 }, playerPos);
audio.routeAndMixdownEmitters(emitters, playerPos, windTel);
audio.renderStereoBlock(outLeft, outRight, windTel);
```
