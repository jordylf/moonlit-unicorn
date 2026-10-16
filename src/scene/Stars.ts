import * as THREE from 'three';
import { config } from '../config/sceneConfig';
import { Beams } from './Beams';

// Stars at several depths:
//   far field   clustered points, never a uniform sphere; scene alpha is lowered under
//               them (min blend) so the DOF keeps them small instead of turning every
//               star into a bokeh disc
//   bokeh       a handful of luminous orbs at mid-far distance; the DOF makes the discs
//   charms      a few stylised 3D stars you can click

type Rng = () => number;

function rngFrom(seed: number): Rng {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function gauss(rng: Rng) {
  return Math.sqrt(-2 * Math.log(rng() + 1e-9)) * Math.cos(2 * Math.PI * rng());
}

function randomUpperDir(rng: Rng, out: THREE.Vector3) {
  // biased toward the upper sky; a few dip to the horizon
  const y = Math.pow(rng(), 0.8) * 1.05 - 0.05;
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  return out.set(Math.cos(a) * r, y, Math.sin(a) * r);
}

const farMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uBrightness: { value: 1 }, uTwinkle: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute vec3 aColor;
      attribute float aPhase;
      uniform float uTime, uPixelRatio, uBrightness, uTwinkle;
      varying vec3 vColor;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        float sp = 0.4 + fract(aPhase * 3.1) * 1.1;
        float tw = 1.0 + uTwinkle * 0.2 * sin(uTime * sp + aPhase * 6.28) * sin(uTime * sp * 0.37 + aPhase * 12.0);
        vColor = aColor * uBrightness * tw;
        gl_PointSize = aSize * uPixelRatio;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = exp(-d * d * 3.5) * (1.0 - smoothstep(0.75, 1.0, d));
        // rgb adds; alpha (DOF far-blur limit) is min-blended down to 0.1 under the star
        gl_FragColor = vec4(vColor * a, mix(1.0, 0.1, smoothstep(0.02, 0.2, a)));
      }`,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.MinEquation,
    transparent: true,
    depthWrite: false,
    fog: false,
  });

const bokehMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uProj: { value: 500 }, uBrightness: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec4 aLight; // size, intensity, phase, unused
      attribute vec3 aColor;
      uniform float uTime, uProj, uBrightness;
      varying vec3 vColor;
      void main() {
        vec3 p = position + vec3(0.0, sin(uTime * 0.21 + aLight.z * 6.28) * 0.4, 0.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = max(aLight.x * uProj / -mv.z, 2.0);
        vColor = aColor * aLight.y * uBrightness * (0.85 + 0.15 * sin(uTime * 0.5 + aLight.z * 9.0));
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        gl_FragColor = vec4(vColor * (1.0 - smoothstep(0.55, 1.0, d)), 1.0);
      }`,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    transparent: true,
    depthWrite: true,
    fog: false,
  });

// Clickable stars: faceted glow; alpha 0.3 limits their far blur so they stay crisp.
const charmMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { uIntensity: { value: 1 }, uColor: { value: new THREE.Color(1, 0.88, 0.68) } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec3 N = normalize(vN);
        float edge = 1.0 - abs(dot(N, vV));
        float facet = 0.55 + 0.45 * abs(N.y * 0.7 + N.x * 0.3);
        gl_FragColor = vec4(uColor * uIntensity * (facet + edge * 0.8), 0.3);
      }`,
  });

function starShape(points = 5, outer = 1, inner = 0.48) {
  const s = new THREE.Shape();
  for (let i = 0; i <= points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  return s;
}

type Charm = {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  base: THREE.Vector3;
  phase: number;
  pulse: number; // 0..1 decaying glow
  scaleVel: number;
  scale: number;
  size: number;
  lit: boolean; // part of the constellation being drawn
  glow: number; // eased lit state
};

// screen-space anchors for the clickable stars: ndc x, ndc y, distance, size
const CHARMS: [number, number, number, number][] = [
  [-0.66, 0.52, 24, 0.22],
  [-0.22, 0.8, 34, 0.27],
  [0.8, -0.02, 21, 0.19],
  [0.06, 0.6, 46, 0.32],
  [0.66, 0.8, 38, 0.24],
];

const LINE_COLOR = new THREE.Color(1, 0.86, 0.62);

export class Stars {
  private readonly scene: THREE.Scene;
  private far: THREE.Points | null = null;
  private bokeh: THREE.Points | null = null;
  private readonly farMat = farMaterial();
  private readonly bokehMat = bokehMaterial();
  private readonly charmGeo: THREE.ExtrudeGeometry;
  readonly charms: Charm[] = [];
  private readonly lines: Beams;
  private order: number[] = []; // struck order: lines join consecutive stars
  private celebrate = 0;
  private linesFade = 0;
  private readonly count: number;
  private readonly tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene, lowQuality: boolean) {
    this.scene = scene;
    this.count = Math.round(config.stars.count * (lowQuality ? 0.5 : 1));
    this.charmGeo = new THREE.ExtrudeGeometry(starShape(), {
      depth: 0.22,
      bevelEnabled: true,
      bevelThickness: 0.12,
      bevelSize: 0.1,
      bevelSegments: 3,
      curveSegments: 1,
    });
    this.charmGeo.center();
    for (let i = 0; i < CHARMS.length; i++) {
      const material = charmMaterial();
      const mesh = new THREE.Mesh(this.charmGeo, material);
      scene.add(mesh);
      this.charms.push({ mesh, material, base: new THREE.Vector3(), phase: i * 1.7, pulse: 0, scaleVel: 0, scale: 1, size: CHARMS[i][3], lit: false, glow: 0 });
    }
    this.lines = new Beams(scene, CHARMS.length);
    for (let i = 0; i < CHARMS.length; i++) this.lines.hide(i);
    this.lines.commit();
  }

  get litCount() {
    return this.order.length;
  }

  get total() {
    return this.charms.length;
  }

  /** Index of the next star still dark (for keyboard/guide access), or -1. */
  nextUnlit() {
    return this.charms.findIndex((c) => !c.lit);
  }

  /** All stars lit: the constellation flares, then quietly resets. */
  completeConstellation() {
    this.celebrate = 1;
  }

  layout(camera: THREE.PerspectiveCamera, moonDir: THREE.Vector3, moonAngle: number, pixelRatio: number, viewportHeight: number) {
    const rng = rngFrom(1234);
    const origin = camera.position;

    // far field
    if (this.far) {
      this.scene.remove(this.far);
      this.far.geometry.dispose();
    }
    const n = this.count;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    const clusters = Array.from({ length: 24 }, () => ({ dir: randomUpperDir(rng, new THREE.Vector3()), spread: 0.04 + rng() * 0.16 }));
    const dir = this.tmp;
    for (let i = 0; i < n; i++) {
      for (let tries = 0; tries < 20; tries++) {
        if (rng() < 0.55) {
          const c = clusters[Math.floor(rng() * clusters.length)];
          dir.copy(c.dir);
          dir.x += gauss(rng) * c.spread;
          dir.y += gauss(rng) * c.spread;
          dir.z += gauss(rng) * c.spread;
          dir.normalize();
        } else randomUpperDir(rng, dir);
        if (dir.y > -0.05 && dir.angleTo(moonDir) > moonAngle * 1.4) break;
      }
      const r = 160 + 230 * Math.pow(rng(), 0.6);
      pos[i * 3] = origin.x + dir.x * r;
      pos[i * 3 + 1] = origin.y + dir.y * r;
      pos[i * 3 + 2] = origin.z + dir.z * r;
      const big = rng() < 0.035;
      size[i] = big ? 2.4 + rng() * 1.8 : 1.1 + Math.pow(rng(), 3) * 1.4;
      // the moon washes out nearby stars; stars thin out toward the horizon
      const wash = THREE.MathUtils.smoothstep(dir.angleTo(moonDir), moonAngle * 1.3, moonAngle * 7);
      const horizon = THREE.MathUtils.smoothstep(dir.y, -0.05, 0.25) * 0.7 + 0.3;
      const b = (big ? 4 + rng() * 4 : 1.2 + Math.pow(rng(), 3) * 3.5) * wash * horizon;
      const t = rng();
      const c = t < 0.12 ? [1, 0.82, 0.6] : t < 0.22 ? [0.75, 0.83, 1] : [0.95, 0.96, 1];
      col[i * 3] = c[0] * b;
      col[i * 3 + 1] = c[1] * b;
      col[i * 3 + 2] = c[2] * b;
      phase[i] = rng();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.far = new THREE.Points(g, this.farMat);
    this.far.frustumCulled = false;
    this.far.renderOrder = -5;
    this.scene.add(this.far);

    // bokeh lights: near the horizon band and a few higher, mid-far distance
    if (this.bokeh) {
      this.scene.remove(this.bokeh);
      this.bokeh.geometry.dispose();
    }
    const lights: [number, number, number][] = [
      [-0.92, -0.62, 70], [-0.6, -0.7, 110], [-0.34, -0.6, 150], [0.2, -0.68, 95], [0.52, -0.6, 125],
      [0.74, -0.74, 62], [0.96, -0.52, 140], [-0.84, 0.28, 85], [0.12, -0.2, 165],
    ];
    const bp = new Float32Array(lights.length * 3);
    const bl = new Float32Array(lights.length * 4);
    const bc = new Float32Array(lights.length * 3);
    const palette = [[1, 0.74, 0.42], [0.78, 0.72, 1], [1, 0.62, 0.82], [1, 0.86, 0.6]];
    lights.forEach(([x, y, d], i) => {
      dir.set(x, y, 0.5).unproject(camera).sub(origin).normalize();
      bp.set([origin.x + dir.x * d, origin.y + dir.y * d, origin.z + dir.z * d], i * 3);
      bl.set([0.45 + rng() * 0.5, 3 + rng() * 4, rng(), 0], i * 4);
      bc.set(palette[i % palette.length], i * 3);
    });
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(bp, 3));
    bg.setAttribute('aLight', new THREE.BufferAttribute(bl, 4));
    bg.setAttribute('aColor', new THREE.BufferAttribute(bc, 3));
    this.bokeh = new THREE.Points(bg, this.bokehMat);
    this.bokeh.frustumCulled = false;
    this.scene.add(this.bokeh);

    // clickable charms
    this.charms.forEach((c, i) => {
      const [x, y, d] = CHARMS[i];
      dir.set(x, y, 0.5).unproject(camera).sub(origin).normalize();
      c.base.copy(origin).addScaledVector(dir, d);
    });

    this.setViewport(camera, pixelRatio, viewportHeight);
  }

  setViewport(camera: THREE.PerspectiveCamera, pixelRatio: number, viewportHeight: number) {
    this.farMat.uniforms.uPixelRatio.value = pixelRatio;
    this.bokehMat.uniforms.uProj.value = (viewportHeight * pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  }

  /** Index of the charm under the pointer (screen-space test), or -1. */
  pick(camera: THREE.Camera, ndcX: number, ndcY: number, width: number, height: number) {
    let best = -1;
    let bestD = Infinity;
    this.charms.forEach((c, i) => {
      const p = this.tmp.copy(c.mesh.position).project(camera);
      if (p.z > 1) return;
      const dx = ((p.x - ndcX) * width) / 2;
      const dy = ((p.y - ndcY) * height) / 2;
      const dist = Math.hypot(dx, dy);
      if (dist < 34 && dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    return best;
  }

  /** Chime a star; the first strike also lights it and links it into the constellation. */
  strike(i: number) {
    const c = this.charms[i];
    c.pulse = 1;
    c.scaleVel += 5;
    const newlyLit = !c.lit;
    if (newlyLit) {
      c.lit = true;
      this.order.push(i);
    }
    return { position: c.mesh.position, newlyLit, complete: newlyLit && this.order.length === this.charms.length };
  }

  update(dt: number, time: number, motion: number, wish = 0) {
    const bright = config.stars.brightness * (1 + wish * 1.2);
    this.farMat.uniforms.uTime.value = time;
    this.farMat.uniforms.uBrightness.value = bright;
    this.farMat.uniforms.uTwinkle.value = config.stars.twinkle * (0.4 + 0.6 * motion) * (1 + wish * 1.5);
    this.bokehMat.uniforms.uTime.value = time * motion;
    this.bokehMat.uniforms.uBrightness.value = config.stars.brightness * (1 + wish * 0.5);
    // after the flare, fade the drawing out and start over
    if (this.celebrate > 0) {
      this.celebrate = Math.max(0, this.celebrate - dt / 7);
      if (this.celebrate === 0) {
        for (const c of this.charms) c.lit = false;
        this.order = [];
      }
    }
    for (const c of this.charms) {
      // spring the scale back to 1 after a strike
      c.scaleVel += (-(c.scale - 1) * 60 - c.scaleVel * 7) * dt;
      c.scale += c.scaleVel * dt;
      c.pulse = Math.max(0, c.pulse - dt * 0.7);
      const t = time * motion;
      c.mesh.position.copy(c.base);
      c.mesh.position.y += Math.sin(t * 0.3 + c.phase) * 0.25;
      // wobble, never spin edge-on to the camera
      c.mesh.rotation.set(Math.sin(t * 0.2 + c.phase) * 0.2, Math.sin(t * 0.23 + c.phase) * 0.55, Math.sin(t * 0.17 + c.phase) * 0.2);
      c.mesh.scale.setScalar(c.size * c.scale);
      c.glow += ((c.lit ? 1 : 0) - c.glow) * (1 - Math.exp(-dt * 3));
      const twinkle = 0.9 + 0.1 * Math.sin(time * 1.3 + c.phase * 3);
      const flare = this.celebrate > 0.85 ? (this.celebrate - 0.85) * 12 : 0;
      c.material.uniforms.uIntensity.value = (1.15 * twinkle + c.glow * 1.3 + c.pulse * c.pulse * 5 + flare) * bright;
    }

    // constellation lines between consecutively struck stars
    const target = this.order.length > 1 ? 1 : 0;
    this.linesFade += (target - this.linesFade) * (1 - Math.exp(-dt * 2.5));
    const fade = this.linesFade * (this.celebrate > 0 ? Math.min(1, this.celebrate * 3) : 1);
    for (let k = 0; k < this.charms.length; k++) {
      if (k + 1 >= this.order.length) {
        this.lines.hide(k);
        continue;
      }
      const a = this.charms[this.order[k]].mesh.position;
      const b = this.charms[this.order[k + 1]].mesh.position;
      const shimmer = 0.8 + 0.2 * Math.sin(time * 2.1 + k * 1.3);
      this.lines.set(k, a, b, 0.045, LINE_COLOR, 1.15 * shimmer * fade * (1 + this.celebrate * 1.5), 0);
    }
    this.lines.commit();
  }
}
