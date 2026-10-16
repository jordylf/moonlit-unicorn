import * as THREE from 'three';
import { config } from '../config/sceneConfig';
import { SKY_GLSL, skyUniforms } from './Moon';

// Volumetric clouds, raymarched per instance inside a box proxy:
//   shape    ellipsoid coverage with a flat-ish base, carved by low-frequency
//            Perlin-Worley noise (Horizon-style remap), eroded by Worley detail
//   light    Beer-Lambert transmittance marched toward the moon, a multiple-scattering
//            lift, the "powder" darkening, Henyey-Greenstein phase (silver lining when
//            looking toward the moon), height-graded sky ambient
//   output   rendered at half resolution into its own target (PostProcessing composites
//            it): premultiplied colour + opacity, and opacity-weighted view depth in a
//            second attachment so the depth of field treats clouds as real objects.
//            Marching stops at the scene depth, so the hero and particles occlude it.
// Instances are placed in screen space + distance from the resting camera, sorted
// back-to-front once (the camera barely moves), and drift/wrap in the vertex shader.

export const CLOUD_LAYER = 1;

type Rng = () => number;

function mulberry32(seed: number): Rng {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable 3D noise: R = Perlin-Worley (shape lumps), G = Worley fBm (erosion detail). */
function buildNoiseTexture(size: number): THREE.Data3DTexture {
  const rng = mulberry32(42);
  const lattice = new Float32Array(32 * 32 * 32).map(() => rng());
  const wrap = (i: number, p: number) => ((i % p) + p) % p;
  const valueNoise = (x: number, y: number, z: number, period: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = x - xi, fy = y - yi, fz = z - zi;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
    const h = (i: number, j: number, k: number) => lattice[wrap(i, period) + (wrap(j, period) << 5) + (wrap(k, period) << 10)];
    const l = THREE.MathUtils.lerp;
    return l(
      l(l(h(xi, yi, zi), h(xi + 1, yi, zi), ux), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), ux), uy),
      l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), ux), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), ux), uy),
      uz,
    );
  };
  const octaves = [4, 8, 16].map((c) => ({ c, pts: new Float32Array(c * c * c * 3).map(() => rng()) }));
  const worley = (x: number, y: number, z: number, oct: { c: number; pts: Float32Array }) => {
    const c = oct.c;
    const px = x * c, py = y * c, pz = z * c;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx, cy = iy + dy, cz = iz + dz;
          const k = (wrap(cx, c) + wrap(cy, c) * c + wrap(cz, c) * c * c) * 3;
          const ex = cx + oct.pts[k] - px, ey = cy + oct.pts[k + 1] - py, ez = cz + oct.pts[k + 2] - pz;
          const d = ex * ex + ey * ey + ez * ez;
          if (d < best) best = d;
        }
    return 1 - Math.min(Math.sqrt(best), 1);
  };
  const data = new Uint8Array(size * size * size * 2);
  const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
  let i = 0;
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++, i += 2) {
        const u = x / size, v = y / size, w = z / size;
        const w1 = worley(u, v, w, octaves[0]), w2 = worley(u, v, w, octaves[1]), w3 = worley(u, v, w, octaves[2]);
        const wfbm = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
        const n16 = valueNoise(u * 16, v * 16, w * 16, 16);
        const perlin = valueNoise(u * 4, v * 4, w * 4, 4) * 0.5 + valueNoise(u * 8, v * 8, w * 8, 8) * 0.3 + n16 * 0.2;
        // Perlin-Worley: billowy lumps that keep soft value-noise variation
        const pw = clamp01(((perlin - (wfbm - 1)) / (2 - wfbm)) * 1.15 - 0.2);
        data[i] = Math.round(pw * 255);
        data[i + 1] = Math.round(clamp01(w2 * 0.6 + w3 * 0.3 + n16 * 0.1) * 255);
      }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

const VERT = /* glsl */ `
  attribute vec4 aCloud; // drift speed, wrap width, wrap centre x, seed
  uniform float uFlow;
  varying vec3 vWorld;
  varying vec4 vInv0;
  varying vec4 vInv1;
  varying vec4 vInv2;
  varying vec3 vScale;
  varying float vSeed;
  void main() {
    mat4 m = instanceMatrix;
    float w = aCloud.y;
    float x = m[3].x - aCloud.z + uFlow * aCloud.x;
    m[3].x = mod(x + 0.5 * w, w) - 0.5 * w + aCloud.z;
    // world -> box space as three rows (constant per instance, so interpolation is exact)
    mat4 inv = inverse(m);
    vInv0 = vec4(inv[0][0], inv[1][0], inv[2][0], inv[3][0]);
    vInv1 = vec4(inv[0][1], inv[1][1], inv[2][1], inv[3][1]);
    vInv2 = vec4(inv[0][2], inv[1][2], inv[2][2], inv[3][2]);
    vScale = vec3(length(m[0].xyz), length(m[1].xyz), length(m[2].xyz));
    vSeed = aCloud.w;
    vec4 world = m * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAG = /* glsl */ `
  #include <packing>
  ${SKY_GLSL}
  uniform highp sampler3D uNoise;
  uniform float uFlow, uExtinction, uDetail, uForward, uFogDensity;
  uniform vec3 uLight, uAmbientTop, uAmbientBottom;
  uniform int uSteps, uLightSteps;
  uniform sampler2D tSceneDepth;
  uniform vec2 uInvResolution;
  uniform float uNear, uFar;
  layout(location = 0) out highp vec4 outColor;
  layout(location = 1) out highp vec4 outDepth; // r: view depth * alpha, a: alpha
  varying vec3 vWorld;
  varying vec4 vInv0;
  varying vec4 vInv1;
  varying vec4 vInv2;
  varying vec3 vScale;
  varying float vSeed;

  vec3 toBox(vec3 p) { vec4 q = vec4(p, 1.0); return vec3(dot(vInv0, q), dot(vInv1, q), dot(vInv2, q)); }
  vec3 dirToBox(vec3 d) { return vec3(dot(vInv0.xyz, d), dot(vInv1.xyz, d), dot(vInv2.xyz, d)); }

  float shapeAt(vec3 p) {
    vec3 q = p * vec3(1.0, 1.12, 1.0);
    float base = (1.0 - dot(q, q)) * smoothstep(-1.0, -0.42, p.y); // ellipsoid, flattened base
    if (base <= 0.0) return 0.0;
    // isotropic in world space, sized by the cloud's height: flat banks get many puffs, not a disc
    float lumps = textureLod(uNoise, p * vScale * (0.36 / vScale.y) + vSeed * 7.13 + vec3(uFlow * 0.002, 0.0, 0.0), 0.0).r;
    return clamp((lumps - (1.0 - base)) / max(base, 0.05), 0.0, 1.0);
  }

  float erode(vec3 p, float shape) {
    float detail = textureLod(uNoise, p * vScale * 0.17 + vSeed * 3.1 + vec3(0.0, uFlow * 0.006, 0.0), 0.0).g * uDetail;
    return clamp((shape - detail) / (1.0 - detail), 0.0, 1.0);
  }

  float hg(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (12.5663706 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
  }

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - ro);
    vec3 bro = toBox(ro);
    vec3 brd = dirToBox(rd);
    vec3 safeD = vec3(abs(brd.x) > 1e-6 ? brd.x : 1e-6, abs(brd.y) > 1e-6 ? brd.y : 1e-6, abs(brd.z) > 1e-6 ? brd.z : 1e-6);
    vec3 ta = (-1.0 - bro) / safeD;
    vec3 tb = (1.0 - bro) / safeD;
    vec3 tmin = min(ta, tb);
    vec3 tmax = max(ta, tb);
    float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
    float tf = min(min(tmax.x, tmax.y), tmax.z);
    // stop at opaque scene geometry (hero, moon, particles that write depth)
    vec3 fwd = -vec3(viewMatrix[0].z, viewMatrix[1].z, viewMatrix[2].z);
    float along = max(dot(rd, fwd), 1e-3);
    float sceneZ = -perspectiveDepthToViewZ(texture(tSceneDepth, gl_FragCoord.xy * uInvResolution).x, uNear, uFar);
    tf = min(tf, sceneZ / along);
    if (tf <= tn) discard;

    // LOD: distant clouds sit in fog and blur, so they get fewer samples
    float lod = clamp((tn - 25.0) / 120.0, 0.0, 1.0);
    int steps = int(mix(float(uSteps), float(uSteps) * 0.35, lod));
    int lightSteps = lod > 0.6 ? 2 : uLightSteps;
    float dt = (tf - tn) / float(steps);
    float t = tn + dt * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    vec3 bL = dirToBox(uMoonDir);
    float cosT = dot(rd, uMoonDir);
    float phase = mix(hg(cosT, uForward), hg(cosT, -0.2), 0.3);
    float lightStep = 0.28 * min(vScale.x, min(vScale.y, vScale.z));

    vec3 col = vec3(0.0);
    float T = 1.0;
    float tHit = -1.0;
    for (int i = 0; i < 96; i++) {
      if (i >= steps || T < 0.015 || t > tf) break;
      vec3 p = bro + brd * t;
      float s = shapeAt(p);
      if (s > 0.0) {
        float d = erode(p, s);
        if (d > 0.0) {
          float st = uExtinction * d;
          // optical depth toward the moon (shape only: cheap, and enough for self-shadowing)
          float od = 0.0;
          float ls = lightStep;
          vec3 lp = p;
          for (int j = 0; j < 8; j++) {
            if (j >= lightSteps) break;
            lp += bL * ls;
            od += shapeAt(lp) * ls;
            ls *= 1.7;
          }
          float beer = exp(-uExtinction * od);
          float scatter = max(beer, 0.7 * exp(-uExtinction * od * 0.25)); // multiple-scattering lift
          float powder = mix(1.0 - exp(-st * 3.0), 1.0, 0.55 + 0.45 * cosT);
          vec3 amb = mix(uAmbientBottom, uAmbientTop, clamp(p.y * 0.5 + 0.5, 0.0, 1.0));
          vec3 S = uLight * phase * scatter * powder + amb;
          float a = 1.0 - exp(-st * dt);
          col += T * S * a;
          T *= 1.0 - a;
          if (tHit < 0.0 && T < 0.55) tHit = t;
        }
        t += dt;
      } else {
        t += dt * 1.6; // empty space: stride further
      }
    }
    float alpha = 1.0 - T;
    if (alpha < 0.004) discard;
    if (tHit < 0.0) tHit = mix(tn, tf, 0.5);
    // atmospheric perspective toward the moonlit haze behind
    float fogF = 1.0 - exp(-tHit * uFogDensity);
    col = mix(col, skyColor(rd) * alpha, fogF);
    outColor = vec4(col, alpha);
    outDepth = vec4(tHit * along * alpha, 0.0, 0.0, alpha);
  }
`;

// y: fixed world height (cloud sea) instead of ndc.y
type Placement = { ndc: [number, number]; d: number; scale: [number, number, number]; speed: number; wrap: number; y?: number };

export class Clouds {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  private mesh: THREE.InstancedMesh | null = null;
  private readonly box = new THREE.BoxGeometry(2, 2, 2);
  private flow = 0;
  private readonly lowQuality: boolean;
  private readonly baseLight = new THREE.Color();

  constructor(scene: THREE.Scene, lowQuality: boolean) {
    this.lowQuality = lowQuality;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...skyUniforms,
        uNoise: { value: buildNoiseTexture(lowQuality ? 48 : 64) },
        uFlow: { value: 0 },
        uExtinction: { value: 1 },
        uDetail: { value: 0.4 },
        uForward: { value: 0.6 },
        uFogDensity: { value: config.fog.density },
        uLight: { value: new THREE.Color() },
        uAmbientTop: { value: new THREE.Color() },
        uAmbientBottom: { value: new THREE.Color() },
        tSceneDepth: { value: null },
        uInvResolution: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uSteps: { value: lowQuality ? 22 : 44 },
        uLightSteps: { value: lowQuality ? 3 : 5 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      glslVersion: THREE.GLSL3, // two outputs
      side: THREE.BackSide, // also works with the camera inside a box
      transparent: true,
      premultipliedAlpha: true,
      depthTest: false, // occlusion comes from the scene depth texture
      depthWrite: false,
    });
    this.applyConfig();
    scene.add(this.group);
  }

  applyConfig() {
    const c = config.clouds;
    const u = this.material.uniforms;
    this.baseLight.set(config.lighting.moonLightColor).multiplyScalar(c.moonlight);
    u.uLight.value.copy(this.baseLight);
    u.uAmbientTop.value.set(c.ambientTop);
    u.uAmbientBottom.value.set(c.ambientBottom);
    u.uExtinction.value = c.extinction;
    u.uDetail.value = c.detail;
    u.uForward.value = c.forwardScatter;
    u.uFogDensity.value = config.fog.density;
  }

  /** (Re)place all instances relative to the resting camera. */
  layout(camera: THREE.PerspectiveCamera, moonNdc: [number, number]) {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.dispose();
    }
    const rng = mulberry32(11);
    const density = config.clouds.density * (this.lowQuality ? 0.7 : 1);
    const count = (n: number) => Math.max(1, Math.round(n * density));
    const list: Placement[] = [];
    const halfW = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
    const wrapAt = (d: number, s: number) => 2 * d * halfW * 1.4 + 2 * s;

    // foreground: close, partly out of frame at the corners, thin and heavily defocused
    const fg: [number, number, number][] = [
      [-0.92, -1.12, 4.2], [0.95, -1.08, 3.8], [0.1, -1.3, 5.4],
    ];
    for (const [x, y, d] of fg) {
      const s = d * (0.32 + rng() * 0.08);
      list.push({ ndc: [x, y], d, scale: [s, s * 0.55, s * 0.7], speed: 0.04 + rng() * 0.02, wrap: wrapAt(d, s) });
    }
    // midground: framing the hero at the sides and well below it
    for (let i = 0; i < count(9); i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const d = 18 + rng() * 18;
      const s = 2 + rng() * 2.6;
      const x = side * (0.5 + rng() * 0.6);
      const y = -0.62 - rng() * 0.42;
      list.push({ ndc: [x, y], d, scale: [s, s * (0.6 + rng() * 0.15), s * 0.75], speed: 0.035 + rng() * 0.02, wrap: wrapAt(d, s) });
    }
    // cloud sea far below, fading into the horizon haze
    const seaY = -6;
    for (let i = 0; i < count(this.lowQuality ? 18 : 30); i++) {
      const d = 45 + 240 * Math.pow(rng(), 0.7);
      const s = 5 + d * (0.07 + rng() * 0.05);
      list.push({ ndc: [(rng() * 2 - 1) * 1.25, 0], d, y: seaY + (rng() - 0.5) * 1.4, scale: [s, s * (0.3 + rng() * 0.1), s * 0.75], speed: 0.05 + d * 0.0006, wrap: wrapAt(d, s) });
    }
    // a few distant banks under the moon, low contrast
    for (let i = 0; i < count(4); i++) {
      const d = 230 + rng() * 90;
      const s = 12 + rng() * 14;
      const ndc: [number, number] = [moonNdc[0] + (rng() - 0.5) * 0.9, moonNdc[1] - 0.42 - rng() * 0.3];
      list.push({ ndc, d, scale: [s, s * 0.25, s * 0.5], speed: 0.07, wrap: wrapAt(d, s) });
    }

    const pos = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const sc = new THREE.Vector3();
    const items = list.map((p) => {
      dir.set(p.ndc[0], p.ndc[1], 0.5).unproject(camera).sub(camera.position).normalize();
      pos.copy(camera.position).addScaledVector(dir, p.d);
      if (p.y !== undefined) pos.y = p.y;
      q.setFromEuler(e.set(0, (rng() - 0.5) * 0.8, 0));
      sc.set(p.scale[0], p.scale[1], p.scale[2]);
      return { m: new THREE.Matrix4().compose(pos, q, sc), a: [p.speed, p.wrap, camera.position.x, rng()], dist: pos.distanceTo(camera.position) };
    });
    // blended: draw back to front
    items.sort((a, b) => b.dist - a.dist);

    const geo = new THREE.BufferGeometry();
    geo.index = this.box.index;
    geo.setAttribute('position', this.box.getAttribute('position'));
    const attr = new Float32Array(items.length * 4);
    const mesh = new THREE.InstancedMesh(geo, this.material, items.length);
    items.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      attr.set(it.a, i * 4);
    });
    geo.setAttribute('aCloud', new THREE.InstancedBufferAttribute(attr, 4));
    mesh.frustumCulled = false; // instances drift in the shader
    mesh.layers.set(CLOUD_LAYER); // drawn by PostProcessing's half-resolution pass
    this.group.add(mesh);
    this.mesh = mesh;
  }

  /** gust: signed wind (clouds rush that way); moonBoost: extra moonlight while wishing. */
  update(dt: number, motion: number, gust = 0, moonBoost = 0) {
    this.flow += dt * config.clouds.speed * (0.25 + 0.75 * motion) * (1 + gust * 7);
    this.material.uniforms.uFlow.value = this.flow;
    this.material.uniforms.uLight.value.copy(this.baseLight).multiplyScalar(1 + moonBoost * 0.7);
  }
}
