import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { config } from '../config/sceneConfig';
import { HeroEyes } from './HeroEyes';
import { HeroHair } from './HeroHair';
import { makeOutlineMaterial, makeToonMaterial, patchHeroMaterial, toonUniforms } from './HeroShading';

// The hero. Hierarchy (unicorn-handoff.md): UnicornRoot → BodyPivot → Head / legs,
// with ManeRoot and TailRoot as siblings of BodyPivot. Because the mane is not under
// BodyPivot, whole-body motion goes on app-owned parents (rig → pose), never on the
// model's own bones. Bones only get small additive local-Z rotations on top of rest.

const BONES = ['BodyPivot', 'Head', 'FrontLeg_L', 'FrontLeg_R', 'BackLeg_L', 'BackLeg_R', 'ManeRoot', 'ManeSegment_01', 'ManeSegment_02', 'TailRoot', 'TailTip', 'Horn'] as const;
type BoneName = (typeof BONES)[number];

export class UnicornLoadError extends Error {}

export async function loadUnicorn(url: string, onProgress: (p: number) => void): Promise<GLTF> {
  const loader = new GLTFLoader();
  try {
    return await loader.loadAsync(url, (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UnicornLoadError(`Failed to load ${url}\n${detail}\n\nExpected the model at public/models/unicorn.glb (see unicorn-handoff.md).`);
  }
}

// layered sines with incommensurate periods: organic, no obvious loop
function wave(t: number, a: [number, number, number][]) {
  let s = 0;
  for (const [amp, period, phase] of a) s += amp * Math.sin((t * Math.PI * 2) / period + phase);
  return s;
}

const FLOAT_Y: [number, number, number][] = [[0.62, 6.4, 0], [0.27, 3.9, 1.3], [0.11, 11.3, 2.2]];
const DRIFT_X: [number, number, number][] = [[0.7, 27, 0.3], [0.3, 15.1, 2.0]];
const DRIFT_Z: [number, number, number][] = [[0.45, 33, 1.1], [0.25, 19.3, 0.2]];
const YAW: [number, number, number][] = [[0.07, 19, 0.5], [0.03, 8.3, 1.7]];
const ROLL: [number, number, number][] = [[0.025, 10.7, 0.9], [0.012, 5.3, 2.4]];
const PITCH: [number, number, number][] = [[0.018, 7.1, 0.2], [0.01, 4.3, 1.1]];

type Spring = { x: number; v: number };

const LEGS: [BoneName, number][] = [['FrontLeg_L', 0], ['FrontLeg_R', 2.7], ['BackLeg_L', 3.5], ['BackLeg_R', 0.8]];
const MANE: BoneName[] = ['ManeRoot', 'ManeSegment_01', 'ManeSegment_02'];

type Mood = 'neutral' | 'happy' | 'surprised';
type Ear = { node: THREE.Object3D; side: 1 | -1; z: Spring; x: Spring; y: Spring };

const SLEEPY_AFTER = 28; // seconds without interaction

export class UnicornController {
  readonly rig = new THREE.Group(); // position: base + float + drag
  readonly pose = new THREE.Group(); // rotation: heading + organic sway
  readonly root: THREE.Object3D;
  readonly headWorld = new THREE.Vector3();
  readonly hornTipWorld = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly eyes: HeroEyes;
  readonly hair: HeroHair;

  private readonly bones = {} as Record<BoneName, THREE.Object3D>;
  private readonly rest = {} as Record<BoneName, THREE.Euler>;
  private readonly hornMats: { emissiveIntensity: number }[] = [];
  private readonly styled: { mesh: THREE.Mesh; realistic: THREE.Material; toon: THREE.Material }[] = [];
  private readonly outlines: THREE.Mesh[] = [];
  private readonly hornLight = new THREE.PointLight('#ffcf8a', 0, 3.2, 2);

  private clock = 0;
  private life = 0; // real time, for breathing / blinks (not slowed by reduced motion)
  private readonly natural = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  private readonly drag = new THREE.Vector3();
  private readonly dragVel = new THREE.Vector3();
  private dragTarget: THREE.Vector3 | null = null;
  private readonly bounce: Spring = { x: 0, v: 0 };
  private readonly mane: Spring[] = [{ x: 0, v: 0 }, { x: 0, v: 0 }, { x: 0, v: 0 }];
  private readonly maneSide: Spring[] = [{ x: 0, v: 0 }, { x: 0, v: 0 }, { x: 0, v: 0 }];
  private readonly tail: Spring[] = [{ x: 0, v: 0 }, { x: 0, v: 0 }];
  private excite = 0;
  private twirlT = 1; // 1 = idle; 0..1 while spinning
  private windDrive = 0;
  private readonly nudge = new THREE.Vector3(); // keyboard displacement (same soft limits as drag)
  private glow = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly hit = new THREE.Sphere();

  // --- being alive -------------------------------------------------------------------
  private mood: Mood = 'neutral';
  private moodUntil = 0;
  private idle = 0;
  private brightness = 0; // 0..1 how bright the night is right now (wish)
  private readonly gaze = new THREE.Vector3(); // where the eyes look (world)
  private readonly attention = new THREE.Vector3();
  private attentionUntil = -1;
  private attentionPriority = 0;
  private readonly hover = new THREE.Vector3();
  private hoverAt = -10;
  private readonly wander = new THREE.Vector3();
  private wanderUntil = 0;
  private wanderAtCamera = true;
  private readonly micro = new THREE.Vector3();
  private nextMicro = 0;
  private readonly moonPoint = new THREE.Vector3(30, 60, -300);
  private lookYaw = 0;
  private lookPitch = 0;
  private readonly ears: Ear[] = [];
  private nextTwitch = 3;
  private swishT = 1;
  private nextSwish = 6;
  private swishDir = 1;

  constructor(gltf: GLTF, scene: THREE.Scene, shadows: boolean, hairShells: number) {
    const root = gltf.scene.getObjectByName('UnicornRoot');
    if (!root) throw new UnicornLoadError('unicorn.glb loaded, but it has no "UnicornRoot" node. Check the export against unicorn-handoff.md.');
    const missing = BONES.filter((n) => !root.getObjectByName(n));
    if (missing.length) throw new UnicornLoadError(`unicorn.glb is missing required pivots: ${missing.join(', ')}`);
    this.root = root;
    for (const n of BONES) {
      const b = root.getObjectByName(n)!;
      this.bones[n] = b;
      this.rest[n] = b.rotation.clone();
    }

    let skin: THREE.Material | null = null;
    let lash: THREE.Material | null = null;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      mesh.frustumCulled = false; // skinned bounds don't follow the bones
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats as THREE.MeshStandardMaterial[]) {
        patchHeroMaterial(m);
        if (m.name === 'Body_Porcelain' && !(mesh as THREE.SkinnedMesh).isSkinnedMesh) skin = m;
        if (m.name === 'Eye_Rims') lash = m;
        if (m.name.startsWith('Horn_') && !this.hornMats.includes(m)) {
          m.emissive.set('#ffb45e');
          this.hornMats.push(m);
        }
      }
    });

    // added parts (lids, hair shells) are tagged so the far silhouettes can skip them
    const before = new Set<THREE.Object3D>();
    root.traverse((o) => before.add(o));
    this.eyes = new HeroEyes(this.bones.Head, skin ?? new THREE.MeshStandardMaterial({ color: '#eee6dc' }), lash ?? new THREE.MeshBasicMaterial({ color: '#120a0d' }));
    this.hair = new HeroHair(root, hairShells, hairShells > 8 ? 240 : 110);
    this.buildStyles(root);
    root.traverse((o) => {
      if (!before.has(o)) {
        o.userData.heroExtra = true;
        o.castShadow = false;
      }
    });

    for (const [name, side] of [['Ear_L', 1], ['Ear_R', -1]] as const) {
      const node = this.bones.Head.getObjectByName(name);
      if (node) this.ears.push({ node, side, z: { x: 0, v: 0 }, x: { x: 0, v: 0 }, y: { x: 0, v: 0 } });
    }

    // horn glow as a tiny practical light (the reference's lantern): kept a little in
    // front of the forehead, away from any surface, so it washes the face softly
    this.hornLight.position.set(-0.85, 0.8, 0);
    this.bones.Head.add(this.hornLight);

    this.pose.rotation.order = 'YXZ';
    this.pose.add(root);
    this.rig.add(this.pose);
    scene.add(this.rig);
    this.rig.position.fromArray(config.hero.position);
    this.prevPos.copy(this.rig.position);
    this.setStyle(config.hero.style);
  }

  /** Toon twins of every hero material, and ink outlines (inverted hulls) for the toon style. */
  private buildStyles(root: THREE.Object3D) {
    const twins = new Map<THREE.Material, THREE.Material>();
    const ink = makeOutlineMaterial(1);
    const hairInk = makeOutlineMaterial(2.2); // wide enough to enclose the strand layers
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
    for (const mesh of meshes) {
      const mat = mesh.material as THREE.Material;
      if (Array.isArray(mesh.material) || mesh.userData.styledByEyes || (mat as THREE.ShaderMaterial).isShaderMaterial) continue;
      let toon = twins.get(mat);
      if (!toon) {
        const t = makeToonMaterial(mat as THREE.MeshStandardMaterial);
        if (mat.name.startsWith('Horn_')) this.hornMats.push(t);
        twins.set(mat, (toon = t));
      }
      this.styled.push({ mesh, realistic: mat, toon });
      if (mesh.userData.noOutline || !/^(Body_Porcelain|Hooves_Charcoal|Hair_|Horn_Gold)/.test(mat.name)) continue;
      const material = mat.name.startsWith('Hair_') ? hairInk : ink;
      let line: THREE.Mesh;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
        const src = mesh as THREE.SkinnedMesh;
        const skinnedLine = new THREE.SkinnedMesh(src.geometry, material);
        skinnedLine.bind(src.skeleton, src.bindMatrix);
        line = skinnedLine;
      } else line = new THREE.Mesh(mesh.geometry, material);
      line.position.copy(mesh.position);
      line.quaternion.copy(mesh.quaternion);
      line.scale.copy(mesh.scale);
      line.frustumCulled = false;
      line.visible = false;
      mesh.parent!.add(line);
      this.outlines.push(line);
    }
  }

  setStyle(style: 'toon' | 'realistic') {
    const toon = style === 'toon';
    for (const s of this.styled) s.mesh.material = toon ? s.toon : s.realistic;
    for (const o of this.outlines) o.visible = toon;
    this.eyes.setStyle(toon);
    this.hair.setToon(toon);
  }

  /** Two far, dark copies that only add depth: one crossing the moon, one in its halo. */
  createSilhouettes(scene: THREE.Scene) {
    // opaque colour, but alpha 0.25 = DOF far-blur limit (like the moon) so they stay legible
    const material = new THREE.MeshBasicMaterial({
      color: '#060818',
      fog: false,
      transparent: true,
      opacity: 0.25,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.ZeroFactor,
    });
    // offset from the moon on screen (ndc), distance, heading
    const spots: [number, number, number, number][] = [
      [-0.06, -0.075, 150, 1],
      [0.3, -0.3, 230, -1],
    ];
    const out: { obj: THREE.Object3D; base: THREE.Vector3; phase: number; dir: number }[] = [];
    for (const [, , , dir] of spots) {
      const clone = SkeletonUtils.clone(this.root);
      const extras: THREE.Object3D[] = [];
      clone.traverse((o) => {
        if (o.userData.heroExtra) return void extras.push(o);
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.material = material;
        mesh.castShadow = mesh.receiveShadow = false;
      });
      for (const o of extras) o.removeFromParent();
      const holder = new THREE.Group();
      holder.add(clone);
      holder.rotation.y = dir > 0 ? 0.1 : Math.PI - 0.15; // near-profile reads best as a silhouette
      holder.scale.setScalar(2.4);
      scene.add(holder);
      out.push({ obj: holder, base: new THREE.Vector3(), phase: out.length * 2.1, dir });
    }
    return {
      layout(camera: THREE.PerspectiveCamera, moonNdc: [number, number]) {
        const v = new THREE.Vector3();
        out.forEach((s, i) => {
          const [x, y, d] = spots[i];
          v.set(moonNdc[0] + x, moonNdc[1] + y, 0.5).unproject(camera).sub(camera.position).normalize();
          s.base.copy(camera.position).addScaledVector(v, d);
        });
      },
      update(time: number) {
        for (const s of out) {
          s.obj.position.copy(s.base);
          s.obj.position.x -= s.dir * Math.sin(time / 40 + s.phase) * 2.5;
          s.obj.position.y += Math.sin(time * 0.4 + s.phase) * 0.6;
          s.obj.rotation.z = Math.sin(time * 0.4 + s.phase + 1) * 0.06;
        }
      },
    };
  }

  // --- attention & mood ----------------------------------------------------------------

  /** Look at a world point for a while; higher priority wins while it lasts. */
  attend(point: THREE.Vector3, seconds: number, priority = 1) {
    if (this.life < this.attentionUntil && priority < this.attentionPriority) return;
    const fresh = this.life >= this.attentionUntil || this.attention.distanceToSquared(point) > 4;
    this.attention.copy(point);
    this.attentionUntil = this.life + seconds;
    this.attentionPriority = priority;
    this.wake();
    if (fresh) for (const e of this.ears) e.z.v += 3.5; // something new: ears prick up
  }

  /** The pointer's position in the world (low-priority curiosity). */
  setHover(point: THREE.Vector3) {
    this.hover.copy(point);
    this.hoverAt = this.life;
  }

  setMoonPoint(point: THREE.Vector3) {
    this.moonPoint.copy(point);
  }

  /** 0..1: how bright the night is (pupils narrow). */
  setBrightness(b: number) {
    this.brightness = b;
  }

  react(mood: Mood, seconds = 1.6) {
    this.mood = mood;
    this.moodUntil = this.life + seconds;
    this.wake();
    if (mood === 'happy') {
      this.eyes.blink();
      this.swish(Math.random() < 0.5 ? 1 : -1);
    }
    if (mood === 'surprised') for (const e of this.ears) e.z.v -= 5;
  }

  /** Any interaction: no longer drowsy. */
  wake() {
    if (this.idle > SLEEPY_AFTER) this.eyes.blink();
    this.idle = 0;
  }

  private swish(dir: number) {
    this.swishT = 0;
    this.swishDir = dir;
  }

  // --- input --------------------------------------------------------------------------

  /** World-space point the drag wants the hero at, or null to release. */
  setDragTarget(p: THREE.Vector3 | null) {
    if (!p) {
      if (this.dragTarget) this.mood = 'neutral';
      this.dragTarget = null;
      return;
    }
    if (!this.dragTarget) this.react('surprised', 99);
    this.dragTarget ??= new THREE.Vector3();
    const e = config.interaction.dragExtent;
    const s = config.interaction.strength;
    // soft limits: displacement saturates instead of hitting a wall
    this.tmp.copy(p).sub(this.natural);
    this.dragTarget.set(e[0] * s * Math.tanh(this.tmp.x / (e[0] * s)), e[1] * s * Math.tanh(this.tmp.y / (e[1] * s)), e[2] * s * Math.tanh(this.tmp.z / (e[2] * s)));
  }

  get naturalPosition() {
    return this.natural;
  }

  /** A happy full turn with a little hop (the constellation reward). */
  twirl() {
    this.twirlT = 0;
    this.react('happy', 3);
  }

  /** A gust from a swipe: pushes the body a little and blows the mane and tail. */
  wind(signedStrength: number) {
    this.windDrive = THREE.MathUtils.clamp(this.windDrive + signedStrength, -1.5, 1.5);
    this.dragVel.x += signedStrength * 1.4;
    this.eyes.blink();
    this.wake();
  }

  /** Keyboard nudge in screen-ish axes, -1..1. */
  setNudge(x: number, y: number) {
    const e = config.interaction.dragExtent;
    this.nudge.set(x * e[0] * 0.7, y * e[1] * 0.7, 0);
    if (x || y) this.wake();
  }

  /** Click/tap reaction: a bounce, a mane flick, a glow pulse, a happy squint. */
  poke() {
    this.bounce.v += 2.4;
    this.excite = 1;
    this.glow = 1;
    this.react('happy');
  }

  hitSphere() {
    this.hit.center.copy(this.rig.position).y += 0.15;
    this.hit.radius = 1.25 * config.hero.scale;
    return this.hit;
  }

  // --- per frame ----------------------------------------------------------------------

  update(dt: number, motion: number, camera: THREE.Camera) {
    const h = config.hero;
    this.clock += dt * h.floatSpeed * (0.35 + 0.65 * motion);
    this.life += dt;
    this.idle += dt;
    const t = this.clock;
    const m = 0.3 + 0.7 * motion; // reduced motion keeps a gentle float
    if (this.mood !== 'neutral' && this.life > this.moodUntil) this.mood = 'neutral';
    const sleepy = this.idle > SLEEPY_AFTER && this.mood === 'neutral';
    const happy = this.mood === 'happy';
    const surprised = this.mood === 'surprised';

    // natural floating trajectory
    this.natural.set(
      h.position[0] + wave(t, DRIFT_X) * h.driftAmplitude * m,
      h.position[1] + wave(t, FLOAT_Y) * h.floatAmplitude * (sleepy ? 0.6 : 1),
      h.position[2] + wave(t, DRIFT_Z) * h.driftAmplitude * m,
    );

    // drag spring (semi-implicit Euler)
    const k = config.interaction.springStiffness;
    const c = config.interaction.springDamping;
    const tx = this.dragTarget?.x ?? this.nudge.x;
    const ty = this.dragTarget?.y ?? this.nudge.y;
    const tz = this.dragTarget?.z ?? this.nudge.z;
    this.dragVel.x += (k * (tx - this.drag.x) - c * this.dragVel.x) * dt;
    this.dragVel.y += (k * (ty - this.drag.y) - c * this.dragVel.y) * dt;
    this.dragVel.z += (k * (tz - this.drag.z) - c * this.dragVel.z) * dt;
    this.drag.addScaledVector(this.dragVel, dt);

    this.bounce.v += (-40 * this.bounce.x - 5.5 * this.bounce.v) * dt;
    this.bounce.x += this.bounce.v * dt;

    this.rig.position.copy(this.natural).add(this.drag);
    this.rig.position.y += this.bounce.x * 0.35;
    let spin = 0;
    if (this.twirlT < 1) {
      this.twirlT = Math.min(1, this.twirlT + dt / 1.9);
      const s = this.twirlT;
      spin = Math.PI * 2 * s * s * (3 - 2 * s);
      this.rig.position.y += Math.sin(Math.PI * s) * 0.55;
    }
    // breathing: slow, a little deeper when drowsy
    const breath = Math.sin((this.life * Math.PI * 2) / (sleepy ? 4.6 : 3.4));
    const sc = h.scale * (1 + this.bounce.x * 0.025);
    const b = sleepy ? 1.5 : 1;
    this.rig.scale.set(sc * (1 + 0.006 * breath * b), sc * (1 + 0.004 * breath * b), sc * (1 + 0.009 * breath * b));

    // velocity (smoothed) drives lean, pitch and the mane lag
    const inv = dt > 0 ? 1 / dt : 0;
    this.tmp.copy(this.rig.position).sub(this.prevPos).multiplyScalar(inv);
    this.velocity.lerp(this.tmp, 1 - Math.exp(-dt * 10));
    this.prevPos.copy(this.rig.position);
    const vx = this.velocity.x;
    const vy = this.velocity.y;

    const ra = h.rotationAmplitude;
    this.pose.rotation.y = h.yaw + spin + (wave(t, YAW) * m + vx * 0.08) * ra;
    // in the unicorn's frame: +z rotation dips the nose, x rotation rolls
    this.pose.rotation.z = (wave(t, PITCH) - vy * 0.1) * ra;
    this.pose.rotation.x = (wave(t, ROLL) * m - vx * 0.05) * ra;

    // --- what to look at: events > pointer > idle wandering (mostly eye contact) ---
    if (this.life < this.attentionUntil) this.gaze.copy(this.attention);
    else if (this.life - this.hoverAt < 1.6) this.gaze.copy(this.hover);
    else {
      if (this.life > this.wanderUntil) {
        const r = Math.random();
        this.wanderAtCamera = sleepy ? r < 0.3 : r < 0.62;
        if (!this.wanderAtCamera) {
          if (r < 0.82) this.wander.copy(this.moonPoint);
          else this.wander.set((Math.random() - 0.5) * 24, 2 + Math.random() * 8, -6 - Math.random() * 10).add(this.rig.position);
        }
        this.wanderUntil = this.life + 1.8 + Math.random() * 3.5;
      }
      this.gaze.copy(this.wanderAtCamera ? camera.position : this.wander);
      if (sleepy) this.gaze.y -= 4; // drowsy eyes drift down
    }
    // micro-saccades: tiny darts that keep the eyes from looking painted on
    if (this.life > this.nextMicro) {
      this.micro.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.6);
      this.nextMicro = this.life + 0.5 + Math.random() * 1.4;
    }
    this.gaze.add(this.micro);

    // head follows the eyes a little (eyes lead, head lags)
    const head = this.bones.Head;
    const hr = this.rest.Head;
    this.bones.BodyPivot.worldToLocal(this.tmp.copy(this.gaze)).sub(head.position);
    const yawTo = THREE.MathUtils.clamp(Math.atan2(this.tmp.z, -this.tmp.x) * 0.35, -0.13, 0.13);
    const pitchTo = THREE.MathUtils.clamp(-Math.atan2(this.tmp.y, Math.hypot(this.tmp.x, this.tmp.z)) * 0.3, -0.09, 0.09);
    const hk = 1 - Math.exp(-dt * 2.6);
    this.lookYaw += (yawTo - this.lookYaw) * hk;
    this.lookPitch += (pitchTo + (sleepy ? 0.05 : 0) - this.lookPitch) * hk;
    head.rotation.z = hr.z + (0.028 * Math.sin(t * 1.1 + 0.4) + 0.014 * Math.sin(t * 2.03) + vy * 0.03) * ra + this.lookPitch;
    head.rotation.y = hr.y + 0.03 * Math.sin(t * 0.47 + 1) * ra + this.lookYaw;
    head.rotation.x = hr.x + 0.02 * Math.sin(t * 0.61 + 2) * ra + (happy ? 0.04 * Math.sin(this.life * 5) : 0);

    // lazy paddling: tiny, slow, out of phase, legs trail a little when rising
    const la = h.legAmplitude * (0.5 + 0.5 * m) * (sleepy ? 0.5 : 1);
    const lw = (Math.PI * 2) / 2.9;
    for (const [name, ph] of LEGS) {
      const bone = this.bones[name];
      bone.rotation.z = this.rest[name].z + la * Math.sin(t * lw + ph) + la * 0.4 * Math.sin(t * lw * 0.53 + ph * 1.3) + vy * 0.04;
    }

    // mane: springs chasing body motion, plus a breeze that travels root -> tip
    this.excite = Math.max(0, this.excite - dt * 1.2);
    this.windDrive *= Math.exp(-dt * 1.3);
    const mr = h.maneResponse;
    const gusty = 0.5 + Math.abs(this.windDrive);
    const drive = -vy * 0.09 + vx * 0.04 + this.windDrive * 0.1;
    const flick = this.excite * this.excite * Math.sin(this.excite * 18) * 0.12;
    for (let i = 0; i < 3; i++) {
      const s = this.mane[i];
      const breeze = (0.016 * Math.sin(this.life * 1.9 - i * 1.1) + 0.008 * Math.sin(this.life * 3.7 - i * 1.6 + 1)) * gusty * m;
      const target = drive * (1 + i * 0.5) + 0.014 * Math.sin(t * 1.4 - i * 0.8) * m + breeze + flick;
      const kk = 26 - i * 6;
      s.v += (kk * (target - s.x) - 2 * Math.sqrt(kk) * 0.45 * s.v) * dt;
      s.x += s.v * dt;
      // sideways sway, lagging further down the mane
      const side = this.maneSide[i];
      const sideTarget = (0.012 * Math.sin(this.life * 1.3 - i * 0.9) * gusty + vx * 0.02 + this.windDrive * 0.03 * (i + 1)) * m;
      side.v += (kk * (sideTarget - side.x) - 2 * Math.sqrt(kk) * 0.4 * side.v) * dt;
      side.x += side.v * dt;
      const n = MANE[i];
      this.bones[n].rotation.z = this.rest[n].z + s.x * mr * (i === 0 ? 0.4 : 1);
      this.bones[n].rotation.x = this.rest[n].x + side.x * mr * (i === 0 ? 0.3 : 1);
    }

    // tail: lag, breeze, and now and then a lazy swish like a real horse
    this.nextSwish -= dt;
    if (this.nextSwish <= 0) {
      this.swish(Math.random() < 0.5 ? 1 : -1);
      this.nextSwish = (sleepy ? 9 : 5) + Math.random() * 6;
    }
    let swish = 0;
    if (this.swishT < 1) {
      this.swishT = Math.min(1, this.swishT + dt / 1.3);
      swish = Math.sin(this.swishT * Math.PI * 2.5) * (1 - this.swishT) * 0.3 * this.swishDir;
    }
    for (let i = 0; i < 2; i++) {
      const s = this.tail[i];
      const target = -drive * 1.3 + 0.03 * Math.sin(t * 1.15 - i * 0.9) * m + flick * 1.3;
      const kk = 20 - i * 6;
      s.v += (kk * (target - s.x) - 2 * Math.sqrt(kk) * 0.4 * s.v) * dt;
      s.x += s.v * dt;
    }
    this.bones.TailRoot.rotation.z = this.rest.TailRoot.z + this.tail[0].x * mr;
    this.bones.TailRoot.rotation.y = this.rest.TailRoot.y + (0.05 * Math.sin(t * 0.8) * m + swish) * mr;
    this.bones.TailTip.rotation.z = this.rest.TailTip.z + this.tail[1].x * mr;
    this.bones.TailTip.rotation.y = this.rest.TailTip.y + swish * 0.7 * mr;

    // ears: springs toward a mood pose, with random twitches
    this.nextTwitch -= dt;
    if (this.nextTwitch <= 0) {
      const e = this.ears[Math.floor(Math.random() * this.ears.length)];
      if (e) {
        e.z.v += 7;
        e.y.v += (Math.random() - 0.5) * 8;
      }
      this.nextTwitch = (sleepy ? 6 : 2.5) + Math.random() * 5;
    }
    const earZ = (happy ? 0.16 : surprised ? -0.22 : sleepy ? -0.12 : 0.02) + 0.03 * breath - Math.abs(this.windDrive) * 0.3;
    const earX = sleepy ? 0.3 : happy ? -0.04 : 0;
    for (const e of this.ears) {
      for (const [s, target] of [[e.z, earZ], [e.x, earX], [e.y, 0]] as const) {
        s.v += (110 * (target - s.x) - 12 * s.v) * dt;
        s.x += s.v * dt;
      }
      e.node.rotation.set(e.x.x * e.side, e.y.x * e.side, e.z.x);
    }

    // eyes: lids by mood, pupils by light and feeling
    // happy: cheeks push the lower lids up into a smiling crescent; sleepy: heavy upper lids
    this.eyes.setLids(happy ? 0.14 : sleepy ? 0.5 : 0.04, happy ? 0.46 : sleepy ? 0.12 : 0.02, surprised ? 1 : 0);
    this.eyes.setPupil((surprised ? 0.31 : happy ? 0.23 : 0.26) - this.brightness * 0.06);

    // glow pulse after a poke
    this.glow = Math.max(0, this.glow - dt * 0.55);
    const g = config.lighting.hornGlow * (0.85 + 0.15 * Math.sin(t * 0.9)) + this.glow * this.glow * 3.5;
    for (const mat of this.hornMats) mat.emissiveIntensity = g * 0.35;
    toonUniforms.uWarm.value = g * 0.5;
    this.hornLight.intensity = g * 0.35;

    this.rig.updateMatrixWorld(true);
    this.bones.Head.getWorldPosition(this.headWorld);
    this.bones.Horn.localToWorld(this.hornTipWorld.set(0, 0.3, 0));
    this.eyes.update(dt, this.gaze, camera, sleepy);
  }
}
