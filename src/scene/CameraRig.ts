import * as THREE from 'three';
import { config, type Layout } from '../config/sceneConfig';

// A slow, damped observer orbiting the hero. Pointer moves the camera a little around
// the look target (diorama parallax), never the unicorn. Composition blends between a
// wide desktop layout and a vertical mobile one by aspect ratio.

const TAU = Math.PI * 2;

function easeOutCubic(x: number) {
  return 1 - Math.pow(1 - Math.min(Math.max(x, 0), 1), 3);
}

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 1200);
  /** Camera at rest (no motion, no pointer, no intro): used to lay out the world. */
  readonly restCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 1200);
  readonly layout: Layout = { ...config.camera.desktop, lookOffset: [0, 0, 0], moonNdc: [0, 0] };
  private readonly pointer = new THREE.Vector2();
  private readonly smooth = new THREE.Vector2();
  private readonly target = new THREE.Vector3();
  private readonly heroBase = new THREE.Vector3();
  private readonly follow = new THREE.Vector3();
  private zoomTarget = 0; // extra dolly distance from scroll / pinch
  private zoom = 0;

  /** Dolly in (negative) or out (positive), soft-bounded. */
  addZoom(delta: number) {
    this.zoomTarget = THREE.MathUtils.clamp(this.zoomTarget + delta, -5, 7);
  }

  setAspect(aspect: number) {
    const t = THREE.MathUtils.smoothstep(aspect, 0.7, 1.35);
    const a = config.camera.mobile;
    const b = config.camera.desktop;
    const L = this.layout;
    const mix = THREE.MathUtils.lerp;
    L.fov = mix(a.fov, b.fov, t);
    L.distance = mix(a.distance, b.distance, t);
    L.elevation = mix(a.elevation, b.elevation, t);
    L.azimuth = mix(a.azimuth, b.azimuth, t);
    L.lookOffset = [0, 1, 2].map((i) => mix(a.lookOffset[i], b.lookOffset[i], t)) as Layout['lookOffset'];
    L.moonNdc = [mix(a.moonNdc[0], b.moonNdc[0], t), mix(a.moonNdc[1], b.moonNdc[1], t)];
    L.moonAngularRadius = mix(a.moonAngularRadius, b.moonAngularRadius, t);

    for (const cam of [this.camera, this.restCamera]) {
      cam.fov = L.fov;
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    this.heroBase.fromArray(config.hero.position);
    this.place(this.restCamera, this.heroBase, L.distance, L.elevation, L.azimuth);
    this.restCamera.updateMatrixWorld(true);
  }

  setPointer(x: number, y: number) {
    this.pointer.set(x, y);
  }

  update(dt: number, time: number, heroPosition: THREE.Vector3, motion: number) {
    const c = config.camera;
    const L = this.layout;
    this.smooth.lerp(this.pointer, 1 - Math.exp(-dt * c.parallaxDamping));
    this.zoom += (this.zoomTarget - this.zoom) * (1 - Math.exp(-dt * 2.2));
    const p = this.smooth;
    const ps = c.parallaxStrength;
    const intro = 1 - easeOutCubic(time / c.introDuration);

    const dist =
      L.distance +
      this.zoom +
      c.introDistance * intro +
      c.pushAmplitude * motion * (0.7 * Math.sin((time * TAU) / 71) + 0.3 * Math.sin((time * TAU) / 43 + 1));
    const az = L.azimuth + c.orbitAmplitude * motion * Math.sin((time * TAU) / 97 + 0.4) + p.x * 0.06 * ps + intro * 0.08;
    const el = L.elevation + 0.014 * motion * Math.sin((time * TAU) / 59 + 0.7) + p.y * 0.035 * ps - intro * 0.025;

    // follow the hero's drift a little, so it moves within a steady frame
    this.heroBase.fromArray(config.hero.position);
    this.follow.copy(heroPosition).sub(this.heroBase).multiplyScalar(c.heroFollow);
    this.place(this.camera, this.follow.add(this.heroBase), dist, el, az);
  }

  private place(cam: THREE.PerspectiveCamera, hero: THREE.Vector3, dist: number, el: number, az: number) {
    const o = this.layout.lookOffset;
    this.target.set(hero.x + o[0], hero.y + o[1], hero.z + o[2]);
    cam.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist).add(this.target);
    cam.lookAt(this.target);
  }
}
