import * as THREE from 'three';
import { makeToonMaterial, patchHeroMaterial } from './HeroShading';

// Living eyes on the model's black glass beads:
//   iris & pupil  painted on each eyeball around a gaze axis (view space), so the eyes
//                 can make eye contact, dart (saccades) and follow things; the pupil
//                 dilates in the dark or when startled; the lower iris is lighter
//                 (reflected light) and in the toon style the iris glows a little
//   sparkles      two drawn catchlights fixed toward the viewer, so the eyes always shine
//   eyelids       skin-coloured upper-lid shells that sweep down over the eye for blinks,
//                 squints and sleepy looks, each with a thin lash line on its edge
// Each eye has its own realistic and toon material sharing one set of uniforms.

const IRIS_GLSL = /* glsl */ `
{
  // angle from the gaze axis across the eyeball: iris, pupil, radial fibres, limbal ring
  float ang = acos(clamp(dot(normal, uGaze), -1.0, 1.0));
  vec3 e1 = safeNormalize(cross(uGaze, vec3(0.0, 1.0, 0.0)), vec3(1.0, 0.0, 0.0));
  vec3 e2 = cross(uGaze, e1);
  float phi = atan(dot(normal, e2), dot(normal, e1));
  float radial = ang / uIrisR;
  float iris = 1.0 - smoothstep(0.93, 1.0, radial);
  float pupil = 1.0 - smoothstep(uPupilR - 0.035, uPupilR, ang);
  float fibres = 0.72 + 0.28 * sin(phi * 41.0 + sin(phi * 9.0) * 2.2) * sin(phi * 17.0 + 1.3);
  vec3 irisCol = mix(uIrisInner, uIrisOuter, smoothstep(0.3, 0.95, radial)) * fibres;
  irisCol += uIrisRing * (1.0 - smoothstep(0.0, 0.12, abs(radial - 0.42))) * 0.6; // collarette
  irisCol = mix(irisCol, uIrisInner * 1.35, clamp((uGaze.y - normal.y) * 2.2, 0.0, 1.0) * 0.55); // lit from below
  irisCol *= 1.0 - 0.65 * smoothstep(0.78, 1.0, radial); // dark limbal ring
  float showIris = iris * (1.0 - pupil);
  diffuseColor.rgb = mix(diffuseColor.rgb, irisCol, showIris);
  totalEmissiveRadiance += irisCol * showIris * uIrisGlow;
  // drawn catchlights: a big one up-left, a small one down-right, fixed toward the viewer
  float s1 = smoothstep(0.982, 0.988, dot(normal, normalize(vec3(-0.34, 0.42, 0.84))));
  float s2 = smoothstep(0.9935, 0.996, dot(normal, normalize(vec3(0.3, -0.28, 0.91))));
  totalEmissiveRadiance += vec3(1.0, 0.98, 1.0) * (s1 * 2.4 + s2 * 1.5) * uSparkle;
}
`;

type EyeUniforms = { uGaze: { value: THREE.Vector3 }; uPupilR: { value: number } };

type Eye = {
  group: THREE.Object3D;
  gloss: THREE.Mesh;
  ball: THREE.Object3D[]; // gloss + rim: hidden while the eye is fully closed
  realistic: THREE.Material;
  toon: THREE.Material;
  uniforms: EyeUniforms;
  lid: THREE.Object3D;
  lowerLid: THREE.Object3D;
  gaze: THREE.Vector3; // current, world space
};

// lids are caps a little larger than a hemisphere (EXT past the equator) so a closed eye
// also covers the sides of the eyeball; the open angles are offset by EXT to compensate
const EXT = 0.3;
const OPEN = -1.3 - EXT; // lid angle: dome tipped back into the head
const WIDE = -1.65 - EXT;
const CLOSED = 1.62; // dome over the front of the eye
// lower lid (dome pointing down): rises to meet the upper lid, so the underside of the
// eyeball never peeks out when the camera looks up at a closed eye
const LOWER_OPEN = 1.35 + EXT;
const LOWER_CLOSED = -0.95;
const MAX_GAZE = 0.62; // radians the iris may travel from the eye's forward axis

const IRIS = {
  realistic: { r: 0.6, inner: '#a77cff', outer: '#2a1250', glow: 0, sparkle: 0.7 },
  toon: { r: 0.72, inner: '#c9a6ff', outer: '#4b2595', glow: 0.32, sparkle: 1 },
};

export class HeroEyes {
  private readonly eyes: Eye[] = [];
  private readonly irisUniforms = {
    uIrisR: { value: 0.6 },
    uIrisInner: { value: new THREE.Color() },
    uIrisOuter: { value: new THREE.Color() },
    uIrisRing: { value: new THREE.Color('#ffc98a') },
    uIrisGlow: { value: 0 },
    uSparkle: { value: 1 },
  };
  private pupil = 0.24;
  private pupilTarget = 0.24;
  // mood lids, 0 open .. 1 closed, eased: upper and lower move separately (a happy eye is
  // mostly the lower lid rising, a sleepy one mostly the upper lid dropping)
  private upperTarget = 0;
  private lowerTarget = 0;
  private upper = 0;
  private lower = 0;
  private lidWide = 0; // 0..1 startled
  private blinkT = 1; // 1 = not blinking
  private blinkLen = 0.2;
  private nextBlink = 2;
  private doubleBlink = false;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly view = new THREE.Vector3();

  constructor(head: THREE.Object3D, skin: THREE.Material, lashMaterial: THREE.Material) {
    const cap = new THREE.SphereGeometry(1, 36, 16, 0, Math.PI * 2, 0, Math.PI / 2 + EXT); // upper lid
    const lowerCap = cap.clone().rotateX(Math.PI); // lower lid
    // lash line: the front half of the cap rim (on top when open, at the bottom when closed)
    const lash = new THREE.TorusGeometry(Math.cos(EXT), 0.05, 6, 32, Math.PI).rotateX(Math.PI / 2).translate(0, -Math.sin(EXT), 0);
    for (const name of ['Eye_L', 'Eye_R']) {
      const group = head.getObjectByName(name);
      // GLTFLoader de-duplicates names: the second eye's children are "Eye_Gloss_1" etc.
      const gloss = group?.children.find((c) => c.name.startsWith('Eye_Gloss')) as THREE.Mesh | undefined;
      if (!group || !gloss) continue;
      const src = gloss.material as THREE.MeshPhysicalMaterial;
      const uniforms: EyeUniforms = { uGaze: { value: new THREE.Vector3(0, 0, 1) }, uPupilR: { value: this.pupil } };
      const edit = {
        key: 'iris',
        edit: (shader: THREE.WebGLProgramParametersWithUniforms) => {
          Object.assign(shader.uniforms, this.irisUniforms, uniforms);
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform vec3 uGaze, uIrisInner, uIrisOuter, uIrisRing;\nuniform float uIrisR, uPupilR, uIrisGlow, uSparkle;')
            // normal_fragment_maps is already expanded by the hero patch; this runs right after it
            .replace('#include <emissivemap_fragment>', IRIS_GLSL + '\n#include <emissivemap_fragment>');
        },
      };
      const realistic = src.clone();
      patchHeroMaterial(realistic, edit);
      const toon = makeToonMaterial(src, edit);
      gloss.material = realistic;
      gloss.userData.styledByEyes = true;

      // lid: unit cap rotating inside a frame scaled just outside the eyeball
      const frame = new THREE.Group();
      frame.scale.set(0.117, 0.137, 0.095);
      const lid = new THREE.Mesh(cap, skin);
      lid.userData.noOutline = true;
      const lashMesh = new THREE.Mesh(lash, lashMaterial);
      lashMesh.userData.noOutline = true;
      lid.add(lashMesh);
      lid.rotation.x = OPEN;
      frame.add(lid);
      const lowerLid = new THREE.Mesh(lowerCap, skin);
      lowerLid.userData.noOutline = true;
      lowerLid.rotation.x = LOWER_OPEN;
      frame.add(lowerLid);
      group.add(frame);
      const ball = group.children.filter((c) => c.name.startsWith('Eye_Gloss') || c.name.startsWith('Eye_Rim'));
      this.eyes.push({ group, gloss, ball, realistic, toon, uniforms, lid, lowerLid, gaze: new THREE.Vector3(0, 0, 1) });
    }
    this.setStyle(false);
  }

  get count() {
    return this.eyes.length;
  }

  setStyle(toon: boolean) {
    const p = toon ? IRIS.toon : IRIS.realistic;
    const u = this.irisUniforms;
    u.uIrisR.value = p.r;
    u.uIrisInner.value.set(p.inner);
    u.uIrisOuter.value.set(p.outer);
    u.uIrisGlow.value = p.glow;
    u.uSparkle.value = p.sparkle;
    for (const e of this.eyes) e.gloss.material = toon ? e.toon : e.realistic;
  }

  /** mood lids, 0 open .. 1 closed, for the upper and lower lid; wide 0..1 startled. */
  setLids(upper: number, lower: number, wide: number) {
    this.upperTarget = upper;
    this.lowerTarget = lower;
    this.lidWide = wide;
  }

  setPupil(size: number) {
    this.pupilTarget = size;
  }

  blink(slow = false) {
    if (this.blinkT < 1) return;
    this.blinkT = 0;
    this.blinkLen = slow ? 0.85 : 0.17 + Math.random() * 0.05;
  }

  /** target: world point to look at. Runs after the hero's pose is updated. */
  update(dt: number, target: THREE.Vector3, camera: THREE.Camera, sleepy: boolean) {
    // blinking: random intervals, sometimes a double blink, slower when sleepy
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && this.blinkT >= 1) {
      this.blink(sleepy && Math.random() < 0.6);
      this.doubleBlink = !sleepy && Math.random() < 0.18;
      this.nextBlink = sleepy ? 1.5 + Math.random() * 2.5 : 2.2 + Math.random() * 4;
    }
    let blink = 0;
    if (this.blinkT < 1) {
      this.blinkT = Math.min(1, this.blinkT + dt / this.blinkLen);
      const t = this.blinkT;
      blink = t < 0.32 ? t / 0.32 : t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55;
      blink = blink * blink * (3 - 2 * blink);
      if (this.blinkT >= 1 && this.doubleBlink) {
        this.doubleBlink = false;
        this.blinkT = 0;
        this.blinkLen = 0.15;
      }
    }
    const ease = 1 - Math.exp(-dt * 9);
    this.upper += (this.upperTarget - this.upper) * ease;
    this.lower += (this.lowerTarget - this.lower) * ease;
    const closure = Math.max(this.upper, blink);
    const open = THREE.MathUtils.lerp(OPEN, WIDE, this.lidWide);
    const angle = THREE.MathUtils.lerp(open, CLOSED, closure);
    const lowerAngle = THREE.MathUtils.lerp(LOWER_OPEN, LOWER_CLOSED, Math.max(this.lower, blink));

    this.pupil += (this.pupilTarget - this.pupil) * (1 - Math.exp(-dt * 4));
    const k = 1 - Math.exp(-dt * 22); // saccades are fast
    for (const eye of this.eyes) {
      eye.lid.rotation.x = angle;
      eye.lowerLid.rotation.x = lowerAngle;
      // fully shut: the lids alone make the closed eye; the head skin underneath is closed,
      // so no edge of the eyeball can peek out from any angle (side views, twirls)
      for (const b of eye.ball) b.visible = closure < 0.9;
      // gaze: toward the target, clamped to what the eyeball can show
      const center = eye.group.getWorldPosition(this.tmpA);
      const forward = this.tmpB.set(0, 0, 1).applyQuaternion(eye.group.getWorldQuaternion(this.tmpQ));
      const desired = center.subVectors(target, center).normalize();
      const a = forward.angleTo(desired);
      if (a > MAX_GAZE) desired.lerp(forward, 1 - MAX_GAZE / a).normalize();
      eye.gaze.lerp(desired, k).normalize();
      const u = eye.uniforms;
      u.uGaze.value.copy(this.view.copy(eye.gaze).transformDirection(camera.matrixWorldInverse));
      u.uPupilR.value = this.pupil;
    }
  }
}
