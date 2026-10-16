import * as THREE from 'three';
import { config } from '../config/sceneConfig';
import { ShootingStars } from './Beams';
import { CameraRig } from './CameraRig';
import { Clouds } from './Clouds';
import { Interaction } from './Interaction';
import { Lighting } from './Lighting';
import { Moon, skyUniforms, syncSkyColors } from './Moon';
import { Particles } from './Particles';
import { PostProcessing, type DofQuality } from './PostProcessing';
import { Stars } from './Stars';
import { outlineUniforms, rimUniforms, syncToonColors, toonUniforms } from './HeroShading';
import { UnicornController, loadUnicorn } from './UnicornController';

export type Quality = { low: boolean; dprCap: number; dof: DofQuality; shadows: boolean };

/** Interactions the guide bar lists (and lights up once discovered). */
export type GuideId = 'drag' | 'poke' | 'star' | 'sky' | 'wish' | 'wind' | 'zoom';

export function detectQuality(): Quality {
  const forced = new URLSearchParams(location.search).get('quality');
  const coarse = matchMedia('(pointer: coarse)').matches;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (coarse && Math.min(screen.width, screen.height) < 820);
  const weak = (navigator.hardwareConcurrency ?? 8) <= 4;
  const low = forced ? forced === 'low' : mobile || weak;
  return low
    ? { low, dprCap: config.quality.dprMobile, dof: { taps: 40, maxRows: 560, samples: 4 }, shadows: false }
    : { low, dprCap: config.quality.dprDesktop, dof: { taps: 64, maxRows: 640, samples: 4 }, shadows: config.lighting.shadows };
}

const HERO_SPARK = new THREE.Color(2.6, 2.0, 3.0);
const WISH_MOTE = new THREE.Color(2.2, 2.0, 3.2);
const CHIME_COLORS = [new THREE.Color(3.2, 2.4, 1.4), new THREE.Color(2.0, 2.2, 3.4), new THREE.Color(3.2, 1.8, 2.8), new THREE.Color(2.6, 3.0, 2.4), new THREE.Color(3.0, 2.6, 3.2)];

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig = new CameraRig();
  readonly quality = detectQuality();
  readonly moon: Moon;
  readonly lighting: Lighting;
  readonly clouds: Clouds;
  readonly stars: Stars;
  readonly particles: Particles;
  readonly meteors: ShootingStars;
  readonly post: PostProcessing;
  hero: UnicornController | null = null;
  /** Called when the visitor performs one of the guide's interactions. */
  onDiscover: ((id: GuideId, detail?: string) => void) | null = null;
  private silhouettes: ReturnType<UnicornController['createSilhouettes']> | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly timer = new THREE.Timer();
  private time = 0;
  private motion = 1;
  private motionTarget = 1;
  private focus = 15;
  private fadeIn = 0;
  private dpr = 1;
  private dprLimit = Infinity; // lowered by adaptResolution when the GPU can't keep up
  private frameAvg = 16;
  private frames = 0;
  private relayoutTimer = 0;
  private readonly forward = new THREE.Vector3();
  private readonly toHead = new THREE.Vector3();
  private readonly moonDir = new THREE.Vector3(0, 0.3, -1);
  // interaction state
  private wishHeld = false;
  private wishLevel = 0;
  private readonly wishNdc = new THREE.Vector2();
  private readonly wishPoint = new THREE.Vector3();
  private moteClock = 0;
  private wind = 0;
  private shower = 0; // meteors still to launch in a constellation shower
  private showerClock = 0;
  private zoomTravel = 0;
  private dragging = false;
  private readonly tmpV = new THREE.Vector3();
  private readonly keyColor = new THREE.Color();
  private readonly fillColor = new THREE.Color();
  private readonly ambientColor = new THREE.Color();
  private readonly fillDir = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    const r = this.renderer;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = config.lighting.exposure;
    r.setClearColor(0x000000, 1);
    r.shadowMap.enabled = this.quality.shadows;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false; // PostProcessing updates it once per frame

    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const applyMotion = () => (this.motionTarget = reduce.matches ? 0.12 : 1);
    applyMotion();
    this.motion = this.motionTarget;
    reduce.addEventListener('change', applyMotion);

    this.moon = new Moon(this.scene);
    this.lighting = new Lighting(this.scene, this.quality.shadows);
    this.clouds = new Clouds(this.scene, this.quality.low);
    this.stars = new Stars(this.scene, this.quality.low);
    this.particles = new Particles(this.scene, this.quality.low);
    this.meteors = new ShootingStars(this.scene);
    this.post = new PostProcessing(r, this.quality.dof);
    this.post.cloudMaterial = this.clouds.material;

    this.resize();
    this.layoutWorld();
    window.addEventListener('resize', () => {
      this.resize();
      clearTimeout(this.relayoutTimer);
      this.relayoutTimer = window.setTimeout(() => this.layoutWorld(), 160);
    });
    if (import.meta.env.DEV) (window as unknown as { __world: World }).__world = this;
  }

  /** Every interaction, callable from input and from the guide bar (keyboard access). */
  readonly actions = {
    poke: () => {
      const hero = this.hero;
      if (!hero) return;
      hero.poke();
      this.particles.burst(hero.hornTipWorld, 44, HERO_SPARK, 1.7, 0.06);
      this.discover('poke');
    },
    /** Chime a star; without an index, the next one still dark. */
    strikeStar: (index?: number) => {
      const i = index ?? Math.max(this.stars.nextUnlit(), 0);
      const hit = this.stars.strike(i);
      this.hero?.attend(hit.position, 1.8, 2);
      const color = CHIME_COLORS[i % CHIME_COLORS.length];
      this.particles.burst(hit.position, 36, color, 1.8, 0.08);
      this.particles.ripple(hit.position, color, 0.75);
      if (hit.complete) this.celebrate();
      this.discover('star', `${this.stars.litCount}/${this.stars.total}`);
    },
    shootingStar: (ndcX = Math.random() * 1.6 - 0.8, ndcY = 0.25 + Math.random() * 0.6) => {
      this.meteors.spawn(this.rig.camera, ndcX, ndcY, ndcX > 0.3 ? -1 : ndcX < -0.3 ? 1 : undefined);
      this.hero?.attend(this.pointAt(ndcX, ndcY, 60), 1.6, 2);
      this.discover('sky');
    },
    wish: (phase: 'start' | 'move' | 'end', ndcX: number, ndcY: number) => {
      this.wishNdc.set(ndcX, ndcY);
      if (phase === 'start') this.wishHeld = true;
      if (phase !== 'end') return;
      this.wishHeld = false;
      if (this.wishLevel > 0.3) {
        // the wish flies off as a shooting star from where it was made
        this.meteors.spawn(this.rig.camera, ndcX, ndcY, ndcX > 0 ? -1 : 1, 70);
        this.particles.ripple(this.wishPoint, WISH_MOTE, 0.32);
        this.discover('wish');
      }
    },
    /** Guide-bar version of hold-to-wish. */
    wishPulse: () => {
      this.actions.wish('start', -0.25 + Math.random() * 0.5, 0.35);
      window.setTimeout(() => this.actions.wish('end', this.wishNdc.x, this.wishNdc.y), 2200);
    },
    gust: (direction: number, strength: number) => {
      this.wind = THREE.MathUtils.clamp(this.wind + direction * (0.5 + strength), -1.6, 1.6);
      this.hero?.wind(direction * (0.4 + strength * 0.8));
      this.discover('wind');
    },
    zoom: (delta: number) => {
      this.rig.addZoom(delta);
      this.hero?.wake();
      this.zoomTravel += Math.abs(delta);
      if (this.zoomTravel > 0.8) this.discover('zoom');
    },
    /** Guide-bar version of zoom: alternate in and out. */
    zoomStep: () => {
      this.actions.zoom(this.zoomTravel % 6 < 3 ? -3 : 3);
      this.zoomTravel += 3;
    },
    /** Guide-bar version of dragging: a little push and the spring brings it home. */
    dragDemo: () => {
      this.hero?.setNudge(0.9, 0.5);
      window.setTimeout(() => this.hero?.setNudge(0, 0), 650);
      this.discover('drag');
    },
  };

  /** World point along the view ray through a screen position. */
  private pointAt(ndcX: number, ndcY: number, distance: number) {
    const cam = this.rig.camera;
    return this.tmpV.set(ndcX, ndcY, 0.5).unproject(cam).sub(cam.position).normalize().multiplyScalar(distance).add(cam.position);
  }

  private discover(id: GuideId, detail?: string) {
    this.onDiscover?.(id, detail);
  }

  /** Constellation complete: flare, a meteor shower, and the unicorn twirls. */
  private celebrate() {
    this.stars.completeConstellation();
    this.shower = 7;
    this.showerClock = 0.4;
    this.hero?.twirl();
    window.setTimeout(() => this.actions.poke(), 900);
  }

  async load(onProgress: (p: number) => void) {
    const gltf = await loadUnicorn(`${import.meta.env.BASE_URL}models/unicorn.glb`, onProgress);
    this.hero = new UnicornController(gltf, this.scene, this.quality.shadows, this.quality.low ? 6 : 12);
    this.hero.setMoonPoint(this.moon.moon.position);
    this.silhouettes = this.hero.createSilhouettes(this.scene);
    this.silhouettes.layout(this.rig.restCamera, this.rig.layout.moonNdc);
    const hero = this.hero;
    const a = this.actions;
    new Interaction(this.canvas, this.rig.camera, {
      heroSphere: () => hero.hitSphere(),
      heroPosition: () => hero.rig.position,
      pickStar: (x, y) => this.stars.pick(this.rig.camera, x, y, this.canvas.clientWidth, this.canvas.clientHeight),
      drag: (p) => {
        hero.setDragTarget(p);
        if (p && !this.dragging) this.discover('drag');
        this.dragging = p !== null;
      },
      tapHero: a.poke,
      tapStar: (i) => a.strikeStar(i),
      tapSky: (x, y) => a.shootingStar(x, y),
      wish: a.wish,
      gust: a.gust,
      zoom: a.zoom,
      nudge: (x, y) => hero.setNudge(x, y),
      parallax: (x, y) => {
        this.rig.setPointer(x, y);
        // the unicorn's eyes follow the cursor, a little in front of it
        if (x || y) hero.setHover(this.pointAt(x, y, this.rig.camera.position.distanceTo(hero.rig.position) * 0.55));
      },
    });
    // settle the simulation and compile shaders behind the loader
    this.step(1 / 60);
    await this.post.compile(this.scene, this.rig.camera);
    this.post.render(this.scene, this.rig.camera, 0);
  }

  start() {
    this.timer.reset();
    this.renderer.setAnimationLoop(() => {
      this.timer.update();
      const dt = Math.min(this.timer.getDelta(), 1 / 20);
      this.step(dt);
      this.post.render(this.scene, this.rig.camera, this.time);
      this.adaptResolution(dt);
    });
  }

  /** Push config changes that are baked into colours/materials. */
  applyConfig() {
    this.renderer.toneMappingExposure = config.lighting.exposure;
    this.scene.environmentIntensity = config.lighting.environment;
    this.lighting.applyConfig();
    rimUniforms.uRimColor.value.set(config.lighting.moonLightColor);
    syncToonColors(config.toon.shadow, config.toon.lit);
    outlineUniforms.uOutlineWidth.value = config.toon.outline;
    outlineUniforms.uOutlineColor.value.set(config.toon.outlineColor);
    this.clouds.applyConfig();
    syncSkyColors();
  }

  layoutWorld() {
    const cam = this.rig.restCamera;
    const L = this.rig.layout;
    this.moon.layout(cam, L.moonNdc, L.moonAngularRadius);
    this.moonDir.fromArray(config.hero.position).negate().add(this.moon.moon.position).normalize();
    this.lighting.setMoonDirection(this.moonDir);
    this.clouds.layout(cam, L.moonNdc);
    this.silhouettes?.layout(cam, L.moonNdc);
    this.hero?.setMoonPoint(this.moon.moon.position);
    this.stars.layout(cam, skyUniforms.uMoonDir.value, skyUniforms.uMoonAngle.value, this.dpr, this.canvas.clientHeight);
    // eye light: from the hero toward the resting camera, raised and shifted left
    const eye = this.toHead.copy(cam.position).sub(new THREE.Vector3().fromArray(config.hero.position)).normalize();
    eye.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.35).add(new THREE.Vector3(0, 0.45, 0)).normalize();
    this.scene.environment = this.moon.buildEnvironment(this.renderer, eye);
    this.applyConfig();
  }

  private resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, this.quality.dprCap, this.dprLimit);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.post.setSize(Math.round(w * this.dpr), Math.round(h * this.dpr));
    this.rig.setAspect(w / h);
    this.stars.setViewport(this.rig.camera, this.dpr, h);
    this.particles.setViewport(this.rig.camera.fov, this.dpr, h);
  }

  /** Drop resolution once if the GPU can't keep up; never oscillate back up. */
  private adaptResolution(dt: number) {
    this.frames++;
    this.frameAvg += (dt * 1000 - this.frameAvg) * 0.03;
    if (this.frames > 180 && this.frameAvg > 26 && this.dpr > 1) {
      this.dprLimit = Math.max(1, this.dpr - 0.25);
      this.frames = 1;
      this.frameAvg = 16;
      this.resize();
    }
  }

  private step(dt: number) {
    this.time += dt;
    this.motion += (this.motionTarget - this.motion) * (1 - Math.exp(-dt * 2));
    const hero = this.hero;
    const cam = this.rig.camera;

    // wish: moonlight swells while held; motes gather where it is being made
    this.wishLevel += ((this.wishHeld ? 1 : 0) - this.wishLevel) * (1 - Math.exp(-dt * (this.wishHeld ? 1.6 : 2.4)));
    const w = this.wishLevel;
    if (this.wishHeld) {
      this.wishPoint.set(this.wishNdc.x, this.wishNdc.y, 0.5).unproject(cam).sub(cam.position).normalize().multiplyScalar(11).add(cam.position);
      this.hero?.attend(this.wishPoint, 0.3, 3);
      this.moteClock -= dt;
      if (this.moteClock <= 0) {
        this.moteClock = 0.07;
        this.particles.burst(this.wishPoint, 2, WISH_MOTE, 0.35 + w * 0.5, 0.05);
      }
    }
    this.wind *= Math.exp(-dt * 1.1);
    if (this.shower > 0 && (this.showerClock -= dt) <= 0) {
      this.shower--;
      this.showerClock = 0.22 + Math.random() * 0.2;
      this.meteors.spawn(cam, Math.random() * 1.8 - 0.9, 0.2 + Math.random() * 0.7);
    }

    if (hero) {
      hero.setBrightness(w);
      hero.update(dt, this.motion, cam);
      this.rig.update(dt, this.time, hero.rig.position, this.motion);
      this.lighting.update(hero.rig.position, cam.position);
      cam.updateMatrixWorld();
      rimUniforms.uRimDir.value.copy(this.moonDir).transformDirection(cam.matrixWorldInverse);
      rimUniforms.uRimStrength.value = config.lighting.rim * (1 + w * 0.6);
      // strand hair is lit by hand: same lights, radiance-scaled like three's (1/pi)
      const l = config.lighting;
      this.keyColor.set(l.moonLightColor).multiplyScalar((l.moonLight * (1 + w * 0.5)) / Math.PI);
      this.fillColor.set(l.fillColor).multiplyScalar(l.fill / Math.PI);
      this.ambientColor.set(l.ambientSky).multiplyScalar(l.ambient * 0.5 + l.environment * 0.25);
      this.fillDir.copy(this.lighting.fill.position).sub(this.lighting.fill.target.position).normalize().transformDirection(cam.matrixWorldInverse);
      hero.hair.setLights(rimUniforms.uRimDir.value, this.keyColor, this.fillDir, this.fillColor, this.ambientColor);

      // auto-focus on the head, measured along the view axis, eased
      this.forward.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const target = this.toHead.copy(hero.headWorld).sub(cam.position).dot(this.forward) + config.dof.focusOffset;
      this.focus += (target - this.focus) * (1 - Math.exp(-dt * config.dof.focusSmoothing));
      this.post.setFocus(this.focus);
    }
    this.moon.update(cam);
    // the wish brightens the whole moonlit chain: moon, halo, key light, clouds, stars
    this.moon.moonMaterial.uniforms.uIntensity.value = config.moon.intensity * (1 + w * 0.35);
    skyUniforms.uHaloStrength.value = config.moon.haloStrength * (1 + w * 0.9);
    this.lighting.moonLight.intensity = config.lighting.moonLight * (1 + w * 0.5);
    this.renderer.toneMappingExposure = config.lighting.exposure * (1 + w * 0.12);
    toonUniforms.uToonBoost.value = 1 + w * 0.3;
    this.clouds.update(dt, this.motion, this.wind, w);
    this.stars.update(dt, this.time, this.motion, w);
    this.particles.update(dt, this.time, this.motion, cam, this.wind);
    this.meteors.update(dt);
    this.silhouettes?.update(this.time * (0.3 + 0.7 * this.motion));

    this.fadeIn = Math.min(1, this.fadeIn + dt / 2.8);
    this.post.fade = this.fadeIn * this.fadeIn * (3 - 2 * this.fadeIn);
  }
}
