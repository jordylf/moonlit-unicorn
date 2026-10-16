import * as THREE from 'three';
import { SAFE_NORMALIZE_GLSL, TOON_GLSL, rimUniforms, toonUniforms } from './HeroShading';

// Strand hair for the mane and tail: shell layers of fibres grown from the sculpted
// locks, skinned to the same bones so they move with them.
//   fibres    run along each lock (uv.v is root -> tip, uv.u wraps around it); every
//             strand has its own length, thickness and slight wave, and is combed toward
//             the tip so the hair lies down and flows instead of standing up like fur
//   shading   Kajiya-Kay with two shifted highlights (a white primary, a tinted
//             secondary), self-shadowed roots, moonlight shining through backlit hair,
//             root-to-tip and per-lock colour variation
// Alpha-to-coverage on the MSAA target gives soft fibre edges with correct depth.

const VERT = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  attribute vec4 tangent;
  uniform float uH, uLen, uComb;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vT;
  varying vec3 vView;
  varying vec3 vBind;
  void main() {
    vUv = uv;
    vBind = position;
    vec3 strandDir = cross(normal, tangent.xyz) * tangent.w; // along the lock, toward the tip
    vec3 objectNormal = normal;
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    vec3 skinnedStrand = strandDir;
    #ifdef USE_SKINNING
      skinnedStrand = (skinMatrix * vec4(strandDir, 0.0)).xyz;
    #endif
    // grow outward, comb toward the tip, droop a little with length
    vec3 transformed = position + (normal + strandDir * uComb) * (uH * uLen) - vec3(0.0, uH * uH * uLen * 0.5, 0.0);
    #include <skinning_vertex>
    vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
    vView = -mv.xyz;
    vN = normalMatrix * objectNormal;
    vT = normalMatrix * skinnedStrand;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  ${SAFE_NORMALIZE_GLSL}
  uniform float uH, uStrands, uSeed, uToon;
  uniform vec3 uColor, uKeyDir, uKeyColor, uFillDir, uFillColor, uAmbient;
  uniform vec3 uRimDir, uRimColor;
  uniform float uRimStrength;
  ${TOON_GLSL}
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vT;
  varying vec3 vView;
  varying vec3 vBind;

  float hash(float n) { return fract(sin(n) * 43758.5453); }

  float strandSpec(vec3 t, vec3 h, float e) {
    float th = dot(t, h);
    return pow(sqrt(max(1.0 - th * th, 0.0)), e) * smoothstep(-1.0, 0.0, th);
  }

  vec3 base;
  float ao;
  float specScale;
  vec3 N;
  vec3 T1;
  vec3 T2;
  vec3 V;

  vec3 lightHair(vec3 L, vec3 C) {
    vec3 T = safeNormalize(vT, vec3(1.0, 0.0, 0.0));
    vec3 H = safeNormalize(L + V, N);
    float tl = dot(T, L);
    float diff = sqrt(max(1.0 - tl * tl, 0.0)) * clamp(dot(N, L) * 0.5 + 0.55, 0.0, 1.0);
    float facing = smoothstep(-0.25, 0.35, dot(N, L));
    float spec = strandSpec(T1, H, 90.0) * 0.3; // whitish primary highlight
    vec3 tinted = mix(base, vec3(1.0), 0.2) * strandSpec(T2, H, 22.0) * 0.45; // tinted secondary
    return C * (base * diff * ao + (vec3(spec) + tinted) * facing * ao * specScale);
  }

  void main() {
    float u = vUv.x * uStrands;
    float id = floor(u + 0.5 * sin(vUv.y * 3.0 + uSeed));
    float r1 = hash(id * 1.37 + uSeed);
    float r2 = hash(id * 7.13 + 3.1 + uSeed);
    float wave = 0.22 * sin(vUv.y * 21.0 + r2 * 6.2831);
    float fx = abs(fract(u + wave + 0.5 * sin(vUv.y * 3.0 + uSeed)) - 0.5) * 2.0; // 0 = strand centre
    float strandLen = mix(0.45, 1.0, r1);
    float width = mix(1.05, 0.32, uH) * mix(0.75, 1.0, r2);
    float cover = (1.0 - smoothstep(width * mix(0.7, 0.9, uToon), width, fx)) * (1.0 - smoothstep(strandLen - 0.08, strandLen, uH));
    // hair LOD: once strands are thinner than a pixel, use their average coverage instead
    // (alpha-to-coverage renders it smoothly) so distant hair doesn't sparkle and alias
    float lod = smoothstep(0.35, 1.1, fwidth(u));
    float average = width * 0.8 * clamp((1.0 - uH) / 0.55, 0.0, 1.0);
    cover = mix(cover, average, lod);
    cover *= 1.0 - smoothstep(0.86, 1.0, vUv.y) * uH; // thinner toward the lock's tip
    if (cover < 0.02) discard;

    N = safeNormalize(vN, vec3(0.0, 0.0, 1.0));
    V = safeNormalize(vView, vec3(0.0, 0.0, 1.0));
    vec3 T = safeNormalize(vT, vec3(1.0, 0.0, 0.0));
    // highlight bands wander along the length and differ per strand, like real hair
    float shift = (r2 - 0.5) * 0.3 + 0.08 * sin(vUv.y * 9.0 + r1 * 6.2831);
    T1 = safeNormalize(T + N * (0.1 + shift), T);
    T2 = safeNormalize(T + N * (-0.2 + shift), T);
    specScale = mix(0.4 + 0.9 * r1, 0.55, lod);

    // colour: per-lock variation, lighter tips, darker deep layers (self-shadowing)
    float lockTint = hash(dot(floor(vBind * 7.0), vec3(12.9898, 78.233, 37.719)));
    base = uColor * mix(0.78, 1.18, lockTint) * mix(0.72, 1.12, vUv.y) * mix(0.92, 1.08, r1);
    ao = mix(0.5, 1.0, uH);

    vec3 col = base * uAmbient * ao;
    col += lightHair(uKeyDir, uKeyColor);
    col += lightHair(uFillDir, uFillColor);
    // moonlight scattering through backlit strands: only where the hair is thin (edges)
    float edge = pow(1.0 - abs(dot(N, V)), 2.5);
    float through = pow(clamp(dot(-V, uKeyDir), 0.0, 1.0), 4.0) * (0.08 + 0.92 * edge);
    col += uKeyColor * base * through * (0.35 - uH * 0.12);
    if (uToon > 0.5) {
      // toon hair: cel bands per clump, an anime 'angel ring' highlight band, crisp rim
      vec3 c = toonShade(base, N, V, 0.0) * mix(0.82, 1.0, uH);
      vec3 Hh = safeNormalize(uToonLight + V, N);
      float ring = smoothstep(0.5, 0.56, strandSpec(T1, Hh, 26.0)) * smoothstep(-0.1, 0.1, dot(N, uToonLight));
      c += mix(base, vec3(1.0), 0.55) * ring * 0.5 * uToonBoost;
      col = c;
    }
    gl_FragColor = vec4(col, cover);
  }
`;

// Flyaways: a few loose strands rooted on the locks that break the hair's outline.
// Camera-facing ribbons, skinned rigidly with their root vertex's bone weights.
const FLY_VERT = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  ${SAFE_NORMALIZE_GLSL}
  attribute vec3 aDir;
  attribute float aSide;
  attribute float aT;
  uniform float uWidth;
  varying float vT;
  varying float vSide;
  varying vec3 vDirV;
  varying vec3 vView;
  void main() {
    vec3 objectNormal = aDir; // skin the strand direction like a normal
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    vec3 transformed = position;
    #include <skinning_vertex>
    vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
    vDirV = safeNormalize(normalMatrix * objectNormal, vec3(0.0, 1.0, 0.0));
    vec3 side = safeNormalize(cross(vDirV, -mv.xyz), vec3(1.0, 0.0, 0.0));
    mv.xyz += side * aSide * uWidth * (1.0 - aT * 0.85);
    vT = aT;
    vSide = aSide;
    vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const FLY_FRAG = /* glsl */ `
  ${SAFE_NORMALIZE_GLSL}
  uniform vec3 uColor, uKeyDir, uKeyColor, uFillDir, uFillColor, uAmbient, uLitTint;
  uniform float uToon, uToonBoost;
  varying float vT;
  varying float vSide;
  varying vec3 vDirV;
  varying vec3 vView;
  float spec(vec3 t, vec3 l, vec3 v) {
    vec3 h = safeNormalize(l + v, t);
    float th = dot(t, h);
    return pow(sqrt(max(1.0 - th * th, 0.0)), 70.0);
  }
  void main() {
    vec3 T = safeNormalize(vDirV, vec3(0.0, 1.0, 0.0));
    vec3 V = safeNormalize(vView, vec3(0.0, 0.0, 1.0));
    vec3 base = uColor * mix(0.85, 1.15, vT);
    vec3 col = base * uAmbient * 0.8;
    col += uKeyColor * (base * 0.35 + spec(T, uKeyDir, V) * 0.25);
    col += uFillColor * (base * 0.55 + spec(T, uFillDir, V) * 0.25);
    col += uKeyColor * base * pow(clamp(dot(-V, uKeyDir), 0.0, 1.0), 4.0) * 0.5; // backlit strands glow
    col = mix(col, base * uLitTint * uToonBoost, uToon);
    float alpha = (1.0 - abs(vSide)) * (1.0 - vT * 0.55) * mix(0.9, 0.55, uToon);
    gl_FragColor = vec4(col, alpha);
  }
`;

function buildFlyaways(geo: THREE.BufferGeometry, count: number, minLen: number, maxLen: number, seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const tan = geo.getAttribute('tangent') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv');
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  const index = geo.index!;
  const POINTS = 7;
  const P = new Float32Array(count * POINTS * 2 * 3);
  const D = new Float32Array(count * POINTS * 2 * 3);
  const side = new Float32Array(count * POINTS * 2);
  const at = new Float32Array(count * POINTS * 2);
  const SI = new Float32Array(count * POINTS * 2 * 4);
  const SW = new Float32Array(count * POINTS * 2 * 4);
  const idx: number[] = [];
  const p0 = new THREE.Vector3(), n = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), t4 = new THREE.Vector4();
  const pt = new THREE.Vector3(), prev = new THREE.Vector3(), dir = new THREE.Vector3();
  let made = 0;
  for (let tries = 0; made < count && tries < count * 20; tries++) {
    const vi = index.getX(Math.floor(rnd() * index.count));
    const v = uv.getY(vi);
    if (v < 0.2 || v > 0.92) continue; // not at the scalp, not at the very tip
    p0.fromBufferAttribute(pos, vi);
    n.fromBufferAttribute(nor, vi).normalize();
    t4.fromBufferAttribute(tan, vi);
    b.set(t4.x, t4.y, t4.z).cross(n).negate().multiplyScalar(t4.w).normalize(); // cross(n, t) * w
    c.copy(b).cross(n).normalize();
    const len = minLen + rnd() * (maxLen - minLen);
    const lift = 0.2 + rnd() * 0.7;
    const curl = (rnd() - 0.5) * 0.8;
    const phase = rnd() * Math.PI * 2;
    for (let k = 0; k < POINTS; k++) {
      const q = k / (POINTS - 1);
      pt.copy(p0).addScaledVector(n, 0.004 + len * lift * q * q).addScaledVector(b, len * q).addScaledVector(c, len * curl * Math.sin(q * Math.PI * 1.5 + phase) * q);
      pt.y -= len * 0.25 * q * q;
      if (k > 0) dir.subVectors(pt, prev).normalize();
      else dir.copy(b);
      prev.copy(pt);
      for (let e = 0; e < 2; e++) {
        const o = (made * POINTS + k) * 2 + e;
        pt.toArray(P, o * 3);
        dir.toArray(D, o * 3);
        side[o] = e === 0 ? -1 : 1;
        at[o] = q;
        for (let j = 0; j < 4; j++) {
          SI[o * 4 + j] = si.getComponent(vi, j);
          SW[o * 4 + j] = sw.getComponent(vi, j);
        }
      }
      if (k < POINTS - 1) {
        const a0 = (made * POINTS + k) * 2;
        idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
      }
    }
    made++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('aDir', new THREE.BufferAttribute(D, 3));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  g.setAttribute('aT', new THREE.BufferAttribute(at, 1));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(SI, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(SW, 4));
  g.setIndex(idx);
  g.setDrawRange(0, made * (POINTS - 1) * 6);
  return g;
}

export class HeroHair {
  private readonly shared = {
    uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
    uKeyColor: { value: new THREE.Color() },
    uFillDir: { value: new THREE.Vector3(0, 0, 1) },
    uFillColor: { value: new THREE.Color() },
    uAmbient: { value: new THREE.Color() },
    uToon: { value: 0 },
    ...rimUniforms,
    ...toonUniforms,
  };
  private readonly strandMats: THREE.ShaderMaterial[] = [];

  constructor(root: THREE.Object3D, shells: number, flyaways: number) {
    const hair: THREE.SkinnedMesh[] = [];
    root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh && (m.material as THREE.Material).name.startsWith('Hair_')) hair.push(m);
    });
    const base = new THREE.ShaderMaterial({
      uniforms: {
        ...this.shared,
        uH: { value: 0 },
        uLen: { value: 0.026 },
        uComb: { value: 1.6 },
        uStrands: { value: 64 },
        uSeed: { value: 0 },
        uColor: { value: new THREE.Color() },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      alphaToCoverage: true,
    });
    hair.forEach((mesh, mi) => {
      const src = mesh.material as THREE.MeshPhysicalMaterial;
      for (let k = 1; k <= shells; k++) {
        const mat = base.clone();
        this.strandMats.push(mat);
        // clones share the program; their uniform objects are their own
        Object.assign(mat.uniforms, this.shared);
        mat.uniforms.uH.value = k / shells;
        mat.uniforms.uSeed.value = mi * 13.7;
        mat.uniforms.uColor.value.copy(src.color);
        mat.uniforms.uLen.value = mesh.name === 'Tail' ? 0.03 : 0.026;
        const shell = new THREE.SkinnedMesh(mesh.geometry, mat);
        shell.bind(mesh.skeleton, mesh.bindMatrix);
        shell.position.copy(mesh.position);
        shell.quaternion.copy(mesh.quaternion);
        shell.scale.copy(mesh.scale);
        shell.frustumCulled = false;
        shell.renderOrder = k; // inner layers first
        mesh.parent!.add(shell);
      }
      // flyaways on the main colour only (the mane's two primitives share vertices)
      if (src.name !== 'Hair_Rose' || flyaways <= 0) return;
      const isTail = mesh.name === 'Tail';
      const geo = buildFlyaways(mesh.geometry, Math.round(flyaways * (isTail ? 0.4 : 1)), isTail ? 0.1 : 0.07, isTail ? 0.24 : 0.18, 97 + mi * 31);
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...this.shared, uColor: { value: src.color.clone() }, uWidth: { value: 0.0045 } },
        vertexShader: FLY_VERT,
        fragmentShader: FLY_FRAG,
        side: THREE.DoubleSide,
        alphaToCoverage: true,
      });
      const strands = new THREE.SkinnedMesh(geo, mat);
      strands.bind(mesh.skeleton, mesh.bindMatrix);
      strands.position.copy(mesh.position);
      strands.quaternion.copy(mesh.quaternion);
      strands.scale.copy(mesh.scale);
      strands.frustumCulled = false;
      mesh.parent!.add(strands);
    });
  }

  /** Light directions in view space; colours are radiance-scaled like three's lights. */
  /** Toon hair: chunky clumps instead of fine fibres, cel-shaded. */
  setToon(on: boolean) {
    this.shared.uToon.value = on ? 1 : 0;
    for (const m of this.strandMats) m.uniforms.uStrands.value = on ? 20 : 64;
  }

  setLights(keyDir: THREE.Vector3, keyColor: THREE.Color, fillDir: THREE.Vector3, fillColor: THREE.Color, ambient: THREE.Color) {
    this.shared.uKeyDir.value.copy(keyDir);
    this.shared.uKeyColor.value.copy(keyColor);
    this.shared.uFillDir.value.copy(fillDir);
    this.shared.uFillColor.value.copy(fillColor);
    this.shared.uAmbient.value.copy(ambient);
  }
}
