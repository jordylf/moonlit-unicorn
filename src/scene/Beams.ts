import * as THREE from 'three';

// Camera-facing glowing ribbons between two points, instanced. Used for shooting stars
// (head-biased comet: hot head, tapering tail) and constellation lines (even glow).

export class Beams {
  private readonly geo = new THREE.InstancedBufferGeometry();
  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly p: Float32Array; // width, intensity, comet (0..1), visible
  private readonly c: Float32Array;
  readonly capacity: number;

  constructor(scene: THREE.Scene, capacity: number) {
    this.capacity = capacity;
    const strip = new THREE.PlaneGeometry(1, 2, 24, 1).translate(0.5, 0, 0); // x: 0 tail .. 1 head
    this.geo.index = strip.index;
    this.geo.setAttribute('position', strip.getAttribute('position'));
    this.a = new Float32Array(capacity * 3);
    this.b = new Float32Array(capacity * 3);
    this.p = new Float32Array(capacity * 4);
    this.c = new Float32Array(capacity * 3);
    const dyn = (arr: Float32Array, n: number) => new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aA', dyn(this.a, 3));
    this.geo.setAttribute('aB', dyn(this.b, 3));
    this.geo.setAttribute('aP', dyn(this.p, 4));
    this.geo.setAttribute('aColor', dyn(this.c, 3));
    this.geo.instanceCount = capacity;
    const mat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec3 aA;
        attribute vec3 aB;
        attribute vec4 aP;
        attribute vec3 aColor;
        varying vec2 vQ;
        varying vec3 vCol;
        varying float vComet;
        void main() {
          vec3 dir = aB - aA + vec3(1e-6);
          vec3 at = aA + dir * position.x;
          vec3 side = normalize(cross(normalize(dir), normalize(cameraPosition - at)) + vec3(1e-6));
          float taper = mix(1.0, position.x * position.x, aP.z);
          vQ = position.xy;
          vCol = aColor * aP.y * aP.w;
          vComet = aP.z;
          vec3 p = at + side * position.y * aP.x * (0.25 + 0.75 * taper);
          gl_Position = aP.w > 0.0 ? projectionMatrix * viewMatrix * vec4(p, 1.0) : vec4(0.0, 0.0, -2.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vQ;
        varying vec3 vCol;
        varying float vComet;
        void main() {
          float across = 1.0 - abs(vQ.y);
          across *= across;
          float along = mix(1.0, pow(vQ.x, 3.0), vComet);
          float head = vComet * exp(-pow((1.0 - vQ.x) * 22.0, 2.0)) * 4.0;
          vec3 col = vCol * across * (along + head);
          // alpha (min-blended) = DOF far-blur limit, so thin beams stay crisp against the sky
          gl_FragColor = vec4(col, mix(1.0, 0.3, smoothstep(0.02, 0.25, max(col.r, max(col.g, col.b)))));
        }`,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MinEquation,
      side: THREE.DoubleSide, // the ribbon is oriented in the shader; its winding faces away
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    scene.add(mesh);
  }

  set(i: number, a: THREE.Vector3, b: THREE.Vector3, width: number, color: THREE.Color, intensity: number, comet: number) {
    a.toArray(this.a, i * 3);
    b.toArray(this.b, i * 3);
    this.p[i * 4] = width;
    this.p[i * 4 + 1] = intensity;
    this.p[i * 4 + 2] = comet;
    this.p[i * 4 + 3] = 1;
    color.toArray(this.c, i * 3);
  }

  hide(i: number) {
    this.p[i * 4 + 3] = 0;
  }

  commit() {
    for (const k of ['aA', 'aB', 'aP', 'aColor']) (this.geo.getAttribute(k) as THREE.InstancedBufferAttribute).needsUpdate = true;
  }
}

type Meteor = { from: THREE.Vector3; vel: THREE.Vector3; age: number; life: number; len: number; color: THREE.Color };

const METEOR_COLORS = [new THREE.Color(1, 0.95, 0.85), new THREE.Color(0.8, 0.88, 1), new THREE.Color(1, 0.85, 0.95)];

/** Shooting stars far beyond the hero (behind the clouds, as real meteors would be). */
export class ShootingStars {
  private readonly beams: Beams;
  private readonly meteors: (Meteor | null)[];
  private readonly head = new THREE.Vector3();
  private readonly tail = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  constructor(scene: THREE.Scene, capacity = 10) {
    this.beams = new Beams(scene, capacity);
    this.meteors = new Array(capacity).fill(null);
    for (let i = 0; i < capacity; i++) this.beams.hide(i);
    this.beams.commit();
  }

  /** Launch from a screen point; `heading` biases the screen direction (+1 right, -1 left). */
  spawn(camera: THREE.Camera, ndcX: number, ndcY: number, heading = Math.sign(Math.random() - 0.5) || 1, distance = 80) {
    const slot = this.meteors.findIndex((m) => m === null);
    if (slot < 0) return;
    this.dir.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
    const from = camera.position.clone().addScaledVector(this.dir, distance);
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const angle = THREE.MathUtils.degToRad(18 + Math.random() * 22);
    const speed = 42 + Math.random() * 26;
    const vel = this.right.multiplyScalar(Math.cos(angle) * heading).addScaledVector(this.up, -Math.sin(angle)).multiplyScalar(speed).clone();
    this.meteors[slot] = { from, vel, age: 0, life: 1.1 + Math.random() * 0.6, len: 9 + Math.random() * 7, color: METEOR_COLORS[slot % METEOR_COLORS.length] };
  }

  update(dt: number) {
    let any = false;
    for (let i = 0; i < this.meteors.length; i++) {
      const m = this.meteors[i];
      if (!m) continue;
      any = true;
      m.age += dt;
      const t = m.age / m.life;
      if (t >= 1) {
        this.meteors[i] = null;
        this.beams.hide(i);
        continue;
      }
      this.head.copy(m.from).addScaledVector(m.vel, m.age);
      // the trail grows in, then the whole streak burns out
      const len = m.len * Math.min(1, t * 4);
      this.tail.copy(this.head).addScaledVector(this.dir.copy(m.vel).normalize(), -len);
      const fade = Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.7;
      this.beams.set(i, this.tail, this.head, 0.22, m.color, 7 * fade, 1);
    }
    if (any) this.beams.commit();
  }
}
