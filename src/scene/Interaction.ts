import * as THREE from 'three';

// Pointer → intent.
//   hover            camera parallax (mouse)
//   press hero       drag on a camera-facing plane; short press without moving = tap
//   tap a star       chime / constellation; tap empty sky = shooting star
//   press-hold sky   make a wish (until release)
//   fast swipe sky   wind gust in the swipe direction
//   wheel / pinch    zoom
//   keyboard         Enter/Space tap the unicorn, arrows nudge it

export type InteractionHooks = {
  heroSphere(): THREE.Sphere;
  heroPosition(): THREE.Vector3;
  pickStar(ndcX: number, ndcY: number): number;
  drag(worldTarget: THREE.Vector3 | null): void;
  tapHero(): void;
  tapStar(index: number): void;
  tapSky(ndcX: number, ndcY: number): void;
  wish(phase: 'start' | 'move' | 'end', ndcX: number, ndcY: number): void;
  gust(direction: number, strength: number): void;
  zoom(delta: number): void;
  nudge(x: number, y: number): void;
  parallax(x: number, y: number): void;
};

const TAP_PX = 8;
const TAP_MS = 400;
const HOLD_MS = 420;
const GUST_PX_S = 1300; // swipe speed that counts as a gust
const GUST_COOLDOWN_MS = 350;

type Mode = 'none' | 'hero' | 'sky' | 'wish' | 'pinch';

export class Interaction {
  private readonly ndc = new THREE.Vector2();
  private readonly ray = new THREE.Raycaster();
  private readonly plane = new THREE.Plane();
  private readonly grab = new THREE.Vector3();
  private readonly hitPoint = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private mode: Mode = 'none';
  private downX = 0;
  private downY = 0;
  private downT = 0;
  private moved = false;
  private starAtDown = -1;
  private holdTimer = 0;
  private lastX = 0;
  private lastT = 0;
  private speedX = 0;
  private lastGust = 0;
  private pinchDist = 0;
  private readonly keys = new Set<string>();
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: THREE.Camera;
  private readonly hooks: InteractionHooks;

  constructor(canvas: HTMLCanvasElement, camera: THREE.Camera, hooks: InteractionHooks) {
    this.canvas = canvas;
    this.camera = camera;
    this.hooks = hooks;
    canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && this.mode === 'none') hooks.parallax(0, 0);
    });
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('keydown', this.onKey);
    canvas.addEventListener('keyup', this.onKey);
    canvas.addEventListener('blur', () => {
      this.keys.clear();
      hooks.nudge(0, 0);
    });
  }

  private setNdc(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
  }

  private overHero() {
    return this.ray.ray.intersectsSphere(this.hooks.heroSphere());
  }

  private pinchSpan() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private endGesture() {
    clearTimeout(this.holdTimer);
    if (this.mode === 'hero') this.hooks.drag(null);
    if (this.mode === 'wish') this.hooks.wish('end', this.ndc.x, this.ndc.y);
  }

  private readonly onDown = (e: PointerEvent) => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.canvas.setPointerCapture(e.pointerId);
    if (this.pointers.size === 2) {
      this.endGesture();
      this.mode = 'pinch';
      this.pinchDist = this.pinchSpan();
      return;
    }
    if (this.pointers.size > 2) return;
    this.setNdc(e);
    this.downX = this.lastX = e.clientX;
    this.downY = e.clientY;
    this.downT = this.lastT = performance.now();
    this.speedX = 0;
    this.moved = false;
    this.starAtDown = -1;
    if (this.overHero()) {
      this.mode = 'hero';
      this.camera.getWorldDirection(this.normal).negate();
      this.plane.setFromNormalAndCoplanarPoint(this.normal, this.hooks.heroPosition());
      if (this.ray.ray.intersectPlane(this.plane, this.hitPoint)) this.grab.copy(this.hitPoint).sub(this.hooks.heroPosition());
      else this.grab.set(0, 0, 0);
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    this.mode = 'sky';
    this.starAtDown = this.hooks.pickStar(this.ndc.x, this.ndc.y);
    if (this.starAtDown < 0) {
      this.holdTimer = window.setTimeout(() => {
        if (this.mode !== 'sky' || this.moved) return;
        this.mode = 'wish';
        this.hooks.wish('start', this.ndc.x, this.ndc.y);
      }, HOLD_MS);
    }
  };

  private readonly onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (p) {
      p.x = e.clientX;
      p.y = e.clientY;
    }
    if (this.mode === 'pinch') {
      if (this.pointers.size < 2) return;
      const span = this.pinchSpan();
      this.hooks.zoom((this.pinchDist - span) * 0.02);
      this.pinchDist = span;
      return;
    }
    this.setNdc(e);
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > TAP_PX) this.moved = true;

    if (this.mode === 'hero') {
      if (this.ray.ray.intersectPlane(this.plane, this.hitPoint)) this.hooks.drag(this.target.copy(this.hitPoint).sub(this.grab));
      return;
    }
    if (this.mode === 'wish') {
      this.hooks.wish('move', this.ndc.x, this.ndc.y);
      return;
    }
    if (this.mode === 'sky') {
      if (this.moved) clearTimeout(this.holdTimer);
      const now = performance.now();
      const dtm = Math.max(now - this.lastT, 1);
      this.speedX += ((e.clientX - this.lastX) / dtm) * 1000 * 0.5 - this.speedX * 0.5; // smoothed px/s
      this.lastX = e.clientX;
      this.lastT = now;
      if (Math.abs(this.speedX) > GUST_PX_S && now - this.lastGust > GUST_COOLDOWN_MS) {
        this.lastGust = now;
        this.hooks.gust(Math.sign(this.speedX), Math.min(1, Math.abs(this.speedX) / 3600));
      }
    }
    // mouse parallax everywhere; on touch only while dragging empty sky
    if (e.pointerType === 'mouse' || this.mode === 'sky') this.hooks.parallax(this.ndc.x, this.ndc.y);
    if (e.pointerType === 'mouse' && this.mode === 'none') {
      this.canvas.style.cursor = this.overHero() ? 'grab' : this.hooks.pickStar(this.ndc.x, this.ndc.y) >= 0 ? 'pointer' : '';
    }
  };

  private readonly onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this.mode === 'pinch') {
      if (this.pointers.size === 0) this.mode = 'none';
      return;
    }
    clearTimeout(this.holdTimer);
    const tap = !this.moved && performance.now() - this.downT < TAP_MS && e.type === 'pointerup';
    if (this.mode === 'hero') {
      this.hooks.drag(null);
      if (tap) this.hooks.tapHero();
    } else if (this.mode === 'sky' && tap) {
      if (this.starAtDown >= 0) this.hooks.tapStar(this.starAtDown);
      else this.hooks.tapSky(this.ndc.x, this.ndc.y);
    } else if (this.mode === 'wish') {
      this.hooks.wish('end', this.ndc.x, this.ndc.y);
    }
    if (e.pointerType !== 'mouse') this.hooks.parallax(0, 0);
    this.mode = 'none';
    this.canvas.style.cursor = '';
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.hooks.zoom(THREE.MathUtils.clamp(px, -120, 120) * 0.006);
  };

  private readonly onKey = (e: KeyboardEvent) => {
    const down = e.type === 'keydown';
    if (down && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      this.hooks.tapHero();
      return;
    }
    if (!e.key.startsWith('Arrow')) return;
    e.preventDefault();
    if (down) this.keys.add(e.key);
    else this.keys.delete(e.key);
    const x = (this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('ArrowLeft') ? 1 : 0);
    const y = (this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('ArrowDown') ? 1 : 0);
    this.hooks.nudge(x, y);
  };
}
