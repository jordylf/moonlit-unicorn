import * as THREE from 'three';
import { config } from '../config/sceneConfig';

// Sky dome + moon. The sky function is shared with the clouds so distant clouds
// fade into exactly the haze behind them, and the moon brightens that haze.

export const skyUniforms = {
  uSkyTop: { value: new THREE.Color() },
  uSkyMid: { value: new THREE.Color() },
  uSkyHorizon: { value: new THREE.Color() },
  uSkyViolet: { value: new THREE.Color() },
  uSkyBelow: { value: new THREE.Color() },
  uHalo: { value: new THREE.Color() },
  uHaloWarm: { value: new THREE.Color() },
  uMoonDir: { value: new THREE.Vector3(0, 0.3, -1).normalize() },
  uMoonAngle: { value: 0.06 },
  uHaloStrength: { value: 1 },
};

export function syncSkyColors() {
  const s = config.sky;
  skyUniforms.uSkyTop.value.set(s.top);
  skyUniforms.uSkyMid.value.set(s.mid);
  skyUniforms.uSkyHorizon.value.set(s.horizon);
  skyUniforms.uSkyViolet.value.set(s.violet);
  skyUniforms.uSkyBelow.value.set(s.below);
  skyUniforms.uHalo.value.set(s.halo);
  skyUniforms.uHaloWarm.value.set(s.haloWarm);
  skyUniforms.uHaloStrength.value = config.moon.haloStrength;
}

export const SKY_GLSL = /* glsl */ `
uniform vec3 uSkyTop, uSkyMid, uSkyHorizon, uSkyViolet, uSkyBelow, uHalo, uHaloWarm;
uniform vec3 uMoonDir;
uniform float uMoonAngle, uHaloStrength;

vec3 skyColor(vec3 d) {
  float h = d.y;
  vec3 c = mix(uSkyHorizon, uSkyMid, smoothstep(-0.02, 0.2, h));
  c = mix(c, uSkyTop, smoothstep(0.16, 0.7, h));
  // faint violet away from the moon, high in the sky
  float away = 1.0 - max(dot(normalize(vec3(d.x, 0.0, d.z) + 1e-4), normalize(vec3(uMoonDir.x, 0.0, uMoonDir.z) + 1e-4)), 0.0);
  c = mix(c, uSkyViolet, 0.5 * away * smoothstep(0.05, 0.35, h) * (1.0 - smoothstep(0.45, 0.95, h)));
  // below the horizon: dark haze over the cloud sea
  c = mix(c, uSkyBelow, smoothstep(0.0, -0.22, h));
  // moonlit haze
  float a = acos(clamp(dot(d, uMoonDir), -1.0, 1.0));
  float o = max(a - uMoonAngle, 0.0);
  float inner = exp(-o / (uMoonAngle * 0.55));
  float mid = exp(-o / (uMoonAngle * 3.2));
  float wide = exp(-a / 0.75);
  c += (uHaloWarm * inner * 0.1 + uHalo * (mid * 0.055 + wide * 0.02)) * uHaloStrength;
  return c;
}
`;

export const NOISE_GLSL = /* glsl */ `
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x),
                 mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x),
                 mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 1.7; a *= 0.5; }
  return s;
}
`;

export function createSkyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${SKY_GLSL}
      varying vec3 vDir;
      void main() {
        gl_FragColor = vec4(skyColor(normalize(vDir)), 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
}

export function createMoonMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uIntensity: { value: config.moon.intensity } },
    vertexShader: /* glsl */ `
      varying vec3 vObj;
      varying vec3 vViewN;
      void main() {
        vObj = position;
        vViewN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uIntensity;
      varying vec3 vObj;
      varying vec3 vViewN;
      void main() {
        vec3 p = normalize(vObj);
        float maria = smoothstep(0.44, 0.66, fbm(p * 1.7 + vec3(3.1, 0.4, 1.2)));
        float detail = fbm(p * 6.5 + 11.0) - 0.5;
        float spots = smoothstep(0.7, 0.86, vnoise(p * 13.0 + 4.0));
        float albedo = 1.0 - maria * 0.3 - detail * 0.16 - spots * 0.09;
        float mu = clamp(vViewN.z, 0.0, 1.0);
        float limb = mix(0.74, 1.0, sqrt(mu));
        vec3 core = vec3(1.0, 0.955, 0.87);
        vec3 edge = vec3(0.84, 0.88, 1.0);
        vec3 col = mix(edge, core, smoothstep(0.05, 0.85, mu)) * albedo * limb * uIntensity;
        // alpha = DOF far-blur limit: keep the moon's edge and surface readable
        gl_FragColor = vec4(col, 0.25);
      }`,
    fog: false,
  });
}

export class Moon {
  readonly sky: THREE.Mesh;
  readonly moon: THREE.Mesh;
  readonly moonMaterial: THREE.ShaderMaterial;
  private envTarget: THREE.WebGLRenderTarget | null = null;

  constructor(scene: THREE.Scene) {
    syncSkyColors();
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(520, 48, 24), createSkyMaterial());
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.moonMaterial = createMoonMaterial();
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.moonMaterial);
    this.moon.renderOrder = -9;
    scene.add(this.sky, this.moon);
  }

  /** Place the moon along the ray through `ndc` from the resting camera. */
  layout(camera: THREE.PerspectiveCamera, ndc: [number, number], angularRadiusDeg: number) {
    const dir = new THREE.Vector3(ndc[0], ndc[1], 0.5).unproject(camera).sub(camera.position).normalize();
    const d = config.moon.distance;
    const r = d * Math.tan(THREE.MathUtils.degToRad(angularRadiusDeg));
    this.moon.position.copy(camera.position).addScaledVector(dir, d);
    this.moon.scale.setScalar(r);
    this.moon.rotation.set(0.3, -0.6, 0.15);
    skyUniforms.uMoonDir.value.copy(dir);
    skyUniforms.uMoonAngle.value = Math.atan(r / d);
  }

  update(camera: THREE.Camera) {
    this.sky.position.copy(camera.position);
    this.moonMaterial.uniforms.uIntensity.value = config.moon.intensity;
    skyUniforms.uHaloStrength.value = config.moon.haloStrength;
  }

  /**
   * Dark sky + moon as an environment map, so gold and gloss reflect the moon.
   * `eyeLightDir` adds a small soft card toward the camera: the catchlight in the
   * eyes (a cinematographer's eye light; it's not visible anywhere else).
   */
  buildEnvironment(renderer: THREE.WebGLRenderer, eyeLightDir: THREE.Vector3): THREE.Texture {
    const envScene = new THREE.Scene();
    const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), this.sky.material);
    const moon = new THREE.Mesh(this.moon.geometry, this.moonMaterial);
    const angle = skyUniforms.uMoonAngle.value;
    moon.position.copy(skyUniforms.uMoonDir.value).multiplyScalar(40);
    moon.scale.setScalar(40 * Math.tan(angle) * 1.3);
    // eye/clearcoat F0 is ~4%, so the card must be very bright to register
    const cardMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(36, 38, 42), side: THREE.DoubleSide });
    const card = new THREE.Mesh(new THREE.CircleGeometry(1.8, 24), cardMat);
    card.position.copy(eyeLightDir).multiplyScalar(40);
    card.lookAt(0, 0, 0);
    envScene.add(sky, moon, card);
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envTarget?.dispose();
    this.envTarget = pmrem.fromScene(envScene, 0.02, 0.1, 120);
    pmrem.dispose();
    sky.geometry.dispose();
    card.geometry.dispose();
    cardMat.dispose();
    return this.envTarget.texture;
  }
}
