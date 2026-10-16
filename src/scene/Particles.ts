import * as THREE from 'three';
import { config } from '../config/sceneConfig';

// Floating dust between camera and hero (writes depth, so the DOF turns the close
// ones into foreground bokeh), plus pooled sparkle bursts and ripple rings for clicks.

const BOX_MIN = new THREE.Vector3(-10, -4.5, -10);
const BOX_SIZE = new THREE.Vector3(20, 11, 25);
const BURSTS = 240;
const RINGS = 9;

export class Particles {
  private readonly dustMat: THREE.ShaderMaterial;
  private readonly burstGeo = new THREE.BufferGeometry();
  private readonly burstMat: THREE.ShaderMaterial;
  private readonly bPos = new Float32Array(BURSTS * 3);
  private readonly bVel = new Float32Array(BURSTS * 3);
  private readonly bCol = new Float32Array(BURSTS * 3);
  private readonly bLife = new Float32Array(BURSTS * 2); // age, lifetime
  private readonly bAttr = new Float32Array(BURSTS * 2); // size, alpha (for the shader)
  private next = 0;
  private active = 0;
  private readonly rings: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; age: number; delay: number; life: number; size: number }[] = [];
  private flow = 0;

  constructor(scene: THREE.Scene, lowQuality: boolean) {
    // dust
    const n = Math.round(config.particles.dust * (lowQuality ? 0.5 : 1));
    const pos = new Float32Array(n * 3);
    const data = new Float32Array(n * 4);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = BOX_MIN.x + Math.random() * BOX_SIZE.x;
      pos[i * 3 + 1] = BOX_MIN.y + Math.random() * BOX_SIZE.y;
      pos[i * 3 + 2] = BOX_MIN.z + Math.random() * BOX_SIZE.z;
      const bright = Math.random() < 0.06;
      data[i * 4] = bright ? 0.05 + Math.random() * 0.03 : 0.014 + Math.random() * 0.03; // world size
      data[i * 4 + 1] = bright ? 3.5 + Math.random() * 3 : 1 + Math.random() * 2; // intensity
      data[i * 4 + 2] = Math.random(); // phase
      data[i * 4 + 3] = 0.5 + Math.random(); // drift speed
      const t = Math.random();
      const c = t < 0.25 ? [1, 0.84, 0.62] : t < 0.4 ? [1, 0.72, 0.9] : [0.82, 0.84, 1];
      col.set(c, i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aDust', new THREE.BufferAttribute(data, 4));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: {
        uFlow: { value: 0 },
        uTime: { value: 0 },
        uProj: { value: 500 },
        uBrightness: { value: 1 },
        uBoxMin: { value: BOX_MIN },
        uBoxSize: { value: BOX_SIZE },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aDust;
        attribute vec3 aColor;
        uniform float uFlow, uTime, uProj, uBrightness;
        uniform vec3 uBoxMin, uBoxSize;
        varying vec3 vColor;
        void main() {
          float ph = aDust.z * 6.2831;
          vec3 drift = vec3(0.11, 0.035, 0.05) * aDust.w * uFlow
                     + vec3(sin(uFlow * 0.31 + ph), sin(uFlow * 0.23 + ph * 1.7), cos(uFlow * 0.19 + ph)) * 0.35;
          vec3 local = mod(position - uBoxMin + drift, uBoxSize);
          vec3 edge = min(local, uBoxSize - local) / uBoxSize;
          float fade = smoothstep(0.0, 0.06, min(edge.x, min(edge.y, edge.z)));
          vec4 mv = viewMatrix * vec4(uBoxMin + local, 1.0);
          float dist = -mv.z;
          fade *= smoothstep(0.8, 2.2, dist); // never smear right over the lens
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aDust.x * uProj / max(dist, 0.1), 1.5, 90.0);
          float tw = 0.75 + 0.25 * sin(uTime * (0.7 + aDust.w) + ph * 3.0);
          vColor = aColor * aDust.y * uBrightness * fade * tw;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = 1.0 - smoothstep(0.35, 1.0, d);
          if (a < 0.04 || dot(vColor, vColor) < 1e-6) discard;
          gl_FragColor = vec4(vColor, a);
        }`,
      transparent: true,
      depthWrite: true,
      fog: false,
    });
    const dust = new THREE.Points(g, this.dustMat);
    dust.frustumCulled = false;
    scene.add(dust);

    // bursts
    this.burstGeo.setAttribute('position', new THREE.BufferAttribute(this.bPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.burstGeo.setAttribute('aColor', new THREE.BufferAttribute(this.bCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.burstGeo.setAttribute('aAttr', new THREE.BufferAttribute(this.bAttr, 2).setUsage(THREE.DynamicDrawUsage));
    this.burstMat = new THREE.ShaderMaterial({
      uniforms: { uProj: { value: 500 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute vec2 aAttr;
        uniform float uProj;
        varying vec3 vColor;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aAttr.y > 0.0 ? clamp(aAttr.x * uProj / -mv.z, 1.5, 40.0) : 0.0;
          vColor = aColor * aAttr.y;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float core = exp(-d * d * 6.0);
          gl_FragColor = vec4(vColor * core, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const bursts = new THREE.Points(this.burstGeo, this.burstMat);
    bursts.frustumCulled = false;
    bursts.renderOrder = 5;
    scene.add(bursts);

    // ripple rings
    const ringGeo = new THREE.PlaneGeometry(2, 2);
    for (let i = 0; i < RINGS; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uProgress: { value: 0 }, uColor: { value: new THREE.Color() } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uProgress;
          uniform vec3 uColor;
          varying vec2 vUv;
          void main() {
            float r = length(vUv);
            float w = mix(0.06, 0.02, uProgress);
            float ring = exp(-pow((r - 0.92) / w, 2.0));
            float a = ring * (1.0 - uProgress) * (1.0 - uProgress) * 0.45;
            gl_FragColor = vec4(uColor * a, 1.0);
          }`,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 6;
      scene.add(mesh);
      this.rings.push({ mesh, mat, age: 0, delay: 0, life: 1, size: 1 });
    }
  }

  setViewport(fovDeg: number, pixelRatio: number, viewportHeight: number) {
    const proj = (viewportHeight * pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg / 2)));
    this.dustMat.uniforms.uProj.value = proj;
    this.burstMat.uniforms.uProj.value = proj;
  }

  /** Sparkles from a point. color is HDR-scaled. */
  burst(origin: THREE.Vector3, count: number, color: THREE.Color, speed: number, size = 0.05) {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % BURSTS;
      const th = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const r = Math.sqrt(1 - u * u);
      const v = speed * (0.35 + Math.random() * 0.65);
      this.bPos.set([origin.x, origin.y, origin.z], i * 3);
      this.bVel.set([Math.cos(th) * r * v, u * v * 0.8 + speed * 0.25, Math.sin(th) * r * v], i * 3);
      const tint = 0.75 + Math.random() * 0.5;
      this.bCol.set([color.r * tint, color.g * tint, color.b * tint], i * 3);
      this.bLife[i * 2] = 0;
      this.bLife[i * 2 + 1] = 1.1 + Math.random() * 1.3;
      this.bAttr[i * 2] = size * (0.5 + Math.random());
    }
    this.active = BURSTS;
  }

  /** Staggered expanding rings, like a struck chime. */
  ripple(origin: THREE.Vector3, color: THREE.Color, size: number) {
    let delay = 0;
    for (const ring of this.rings) {
      if (ring.mesh.visible) continue;
      ring.mesh.visible = true;
      ring.mesh.position.copy(origin);
      ring.age = 0;
      ring.delay = delay;
      ring.life = 1.6 + delay;
      ring.size = size * (1 + delay * 1.2);
      ring.mat.uniforms.uColor.value.copy(color);
      delay += 0.22;
      if (delay > 0.5) break;
    }
  }

  update(dt: number, time: number, motion: number, camera: THREE.Camera, wind = 0) {
    this.flow += dt * (0.3 + 0.7 * motion) * (1 + wind * 9);
    this.dustMat.uniforms.uFlow.value = this.flow;
    this.dustMat.uniforms.uTime.value = time;
    this.dustMat.uniforms.uBrightness.value = config.particles.dustBrightness;

    if (this.active > 0) {
      let alive = 0;
      const drag = Math.exp(-dt * 1.6);
      for (let i = 0; i < BURSTS; i++) {
        const life = this.bLife[i * 2 + 1];
        if (life <= 0) continue;
        const age = (this.bLife[i * 2] += dt);
        if (age >= life) {
          this.bLife[i * 2 + 1] = 0;
          this.bAttr[i * 2 + 1] = 0;
          continue;
        }
        alive++;
        const j = i * 3;
        this.bVel[j] *= drag;
        this.bVel[j + 1] = this.bVel[j + 1] * drag + dt * 0.25; // drift upward, weightless
        this.bVel[j + 2] *= drag;
        this.bPos[j] += this.bVel[j] * dt;
        this.bPos[j + 1] += this.bVel[j + 1] * dt;
        this.bPos[j + 2] += this.bVel[j + 2] * dt;
        const t = age / life;
        this.bAttr[i * 2 + 1] = Math.min(1, t * 12) * (1 - t) * (1 - t) * (0.8 + 0.2 * Math.sin(age * 20 + i));
      }
      this.burstGeo.attributes.position.needsUpdate = true;
      this.burstGeo.attributes.aColor.needsUpdate = true;
      this.burstGeo.attributes.aAttr.needsUpdate = true;
      this.active = alive;
    }

    for (const ring of this.rings) {
      if (!ring.mesh.visible) continue;
      ring.age += dt;
      const t = (ring.age - ring.delay) / (ring.life - ring.delay);
      if (t >= 1) {
        ring.mesh.visible = false;
        continue;
      }
      const p = Math.max(t, 0);
      ring.mat.uniforms.uProgress.value = t < 0 ? 1 : p;
      ring.mesh.quaternion.copy(camera.quaternion);
      ring.mesh.scale.setScalar(ring.size * (0.2 + (1 - Math.pow(1 - p, 3)) * 1.0));
    }
  }
}
