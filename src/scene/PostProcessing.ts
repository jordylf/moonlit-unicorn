import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { config } from '../config/sceneConfig';
import { CLOUD_LAYER } from './Clouds';

// Pipeline: scene (HDR, MSAA, depth) + volumetric clouds (half resolution, own pass)
// → bokeh depth of field (which also composites the clouds) → bloom → grade
// (chromatic aberration, vignette, tone map, grain) to screen.
//
// DOF is a gather-based bokeh at reduced resolution:
//   prefilter  downsample colour, compute signed CoC (− near, + far) in DOF pixels
//   tile       max near-CoC per tile, so foreground blur can spill over sharp pixels
//   gather     Vogel-disc kernel; background uses min(centre, sample) CoC so nothing
//              blurry leaks onto the sharp hero, foreground scatters by its own CoC
//   postfilter small tent to hide kernel sparsity
//   composite  full-res sharp image blended with the blurred one by CoC / fg alpha
//
// Scene alpha carries a per-pixel limit on far blur: 1 = normal, lower = keep sharper.
// Far stars write ~0.1 and the moon ~0.25, so they stay small/crisp while the rest
// of the background (clouds, bokeh lights) defocuses normally.

const TILE = 12;

const COC_GLSL = /* glsl */ `
#include <packing>
uniform float cameraNear, cameraFar;
uniform float uFocus, uRange, uNear, uFar, uNearMax, uFarMax, uDofHeight;
float viewDist(float depth) { return -perspectiveDepthToViewZ(depth, cameraNear, cameraFar); }
float cocDist(float d, float farLimit) {
  float fn = max(uFocus - uRange, 0.05);
  float ff = uFocus + uRange;
  float c = 0.0;
  if (d < fn) c = -min(uNear * (fn / d - 1.0), uNearMax);
  else if (d > ff) c = min(uFar * (1.0 - ff / d), uFarMax * clamp(farLimit, 0.0, 1.0));
  return c * uDofHeight;
}
`;

// Scene + half-resolution clouds (premultiplied), plus the view distance the CoC should
// use: the cloud's where it is opaque, the scene's elsewhere. alpha = far-blur limit.
const LIT_GLSL = /* glsl */ `
uniform sampler2D tColor, tDepth, tCloud, tCloudDepth;
vec4 lit(vec2 uv, out float dist) {
  vec4 s = sane(texture2D(tColor, uv));
  vec4 c = texture2D(tCloud, uv);
  vec4 cd = texture2D(tCloudDepth, uv);
  if (nonFinite(c.r + c.g + c.b + c.a + cd.r)) { c = vec4(0.0); cd = vec4(0.0); }
  float d = viewDist(texture2D(tDepth, uv).x);
  float cloudD = cd.a > 1e-3 ? cd.r / cd.a : d;
  dist = mix(d, min(cloudD, d), smoothstep(0.1, 0.6, c.a));
  return vec4(s.rgb * (1.0 - c.a) + c.rgb, mix(s.a, 1.0, c.a));
}
`;

// Guard at the entrance of the chain: one NaN/Inf pixel would otherwise be spread
// over the whole frame by the gather and the bloom mips.
const SANE_GLSL = /* glsl */ `
// exponent bits all set = Inf/NaN; isnan() would be optimised away by D3D compilers
bool nonFinite(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; }
vec4 sane(vec4 c) {
  if (nonFinite(c.r) || nonFinite(c.g) || nonFinite(c.b) || nonFinite(c.a)) return vec4(0.0, 0.0, 0.0, 1.0);
  return vec4(clamp(c.rgb, 0.0, 512.0), c.a);
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function cocUniforms() {
  return {
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    uFocus: { value: 15 },
    uRange: { value: 1 },
    uNear: { value: 0.02 },
    uFar: { value: 0.01 },
    uNearMax: { value: 0.03 },
    uFarMax: { value: 0.01 },
    uDofHeight: { value: 540 },
  };
}

function rt(w: number, h: number, filter: THREE.MagnificationTextureFilter = THREE.LinearFilter) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: false,
  });
}

export type DofQuality = { taps: number; maxRows: number; samples: number };

export class PostProcessing {
  readonly sceneTarget: THREE.WebGLRenderTarget;
  private readonly preTarget = rt(1, 1);
  private readonly tileTarget = rt(1, 1, THREE.NearestFilter);
  private readonly gatherTarget = rt(1, 1);
  private readonly postTarget = rt(1, 1);
  private readonly outTarget = rt(1, 1);
  // clouds at half resolution: [0] premultiplied colour, [1] r = view depth * alpha, a = alpha
  private readonly cloudTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, count: 2, depthBuffer: false });
  private readonly litUniforms = {
    tColor: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    tCloud: { value: this.cloudTarget.textures[0] },
    tCloudDepth: { value: this.cloudTarget.textures[1] },
  };
  private readonly clearColor = new THREE.Color();
  /** The volumetric cloud material, rendered by this class's half-resolution pass. */
  cloudMaterial: THREE.ShaderMaterial | null = null;
  private readonly quad = new FullScreenQuad();
  private readonly bloom: UnrealBloomPass;

  private readonly shared = cocUniforms();
  private readonly preMat: THREE.ShaderMaterial;
  private readonly tileMat: THREE.ShaderMaterial;
  private readonly gatherMat: THREE.ShaderMaterial;
  private readonly postMat: THREE.ShaderMaterial;
  private readonly compositeMat: THREE.ShaderMaterial;
  private readonly gradeMat: THREE.ShaderMaterial;
  private readonly copyMat: THREE.ShaderMaterial;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly quality: DofQuality;
  fade = 0;

  constructor(renderer: THREE.WebGLRenderer, quality: DofQuality) {
    this.renderer = renderer;
    this.quality = quality;
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: quality.samples,
      depthTexture: new THREE.DepthTexture(1, 1),
    });
    const s = this.shared;

    this.preMat = new THREE.ShaderMaterial({
      uniforms: { ...s, ...this.litUniforms, uOffset: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        ${COC_GLSL}
        ${SANE_GLSL}
        ${LIT_GLSL}
        uniform vec2 uOffset;
        varying vec2 vUv;
        void main() {
          vec3 acc = vec3(0.0);
          float best = 0.0;
          for (int i = 0; i < 4; i++) {
            vec2 o = vec2(i == 1 || i == 3 ? 1.0 : -1.0, i >= 2 ? 1.0 : -1.0) * uOffset;
            float dd;
            vec4 c = lit(vUv + o, dd);
            float k = cocDist(dd, c.a);
            acc += c.rgb;
            if (abs(k) > abs(best)) best = k;
          }
          gl_FragColor = vec4(acc * 0.25, best);
        }`,
    });

    this.tileMat = new THREE.ShaderMaterial({
      uniforms: { tPre: { value: null }, uPreSize: { value: new THREE.Vector2() }, uTile: { value: TILE } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tPre;
        uniform vec2 uPreSize;
        uniform int uTile; // uniform loop bounds: ANGLE/D3D would unroll constants, compiling for seconds
        void main() {
          ivec2 base = ivec2(gl_FragCoord.xy) * uTile;
          ivec2 lim = ivec2(uPreSize) - 1;
          float m = 0.0;
          for (int y = 0; y < uTile; y++)
            for (int x = 0; x < uTile; x++)
              m = min(m, texelFetch(tPre, min(base + ivec2(x, y), lim), 0).a);
          gl_FragColor = vec4(-m, 0.0, 0.0, 1.0);
        }`,
    });

    this.gatherMat = new THREE.ShaderMaterial({
      uniforms: {
        tPre: { value: null },
        tTile: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uTileTexel: { value: new THREE.Vector2() },
        uTaps: { value: quality.taps },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tPre, tTile;
        uniform vec2 uTexel, uTileTexel;
        uniform int uTaps;
        varying vec2 vUv;
        void main() {
          float taps = float(uTaps);
          vec4 c0 = texture2D(tPre, vUv);
          float coc0 = c0.a;
          float nearR = 0.0;
          for (int y = -1; y <= 1; y++)
            for (int x = -1; x <= 1; x++)
              nearR = max(nearR, texture2D(tTile, vUv + vec2(float(x), float(y)) * uTileTexel).r);
          float R = max(max(abs(coc0), nearR), 1.0);
          // rotate the spiral per pixel: kernel structure becomes noise the tent filter removes
          float rot = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          const float margin = 1.25;
          vec4 bg = vec4(c0.rgb, 1.0);
          vec3 fgCol = vec3(0.0);
          float fgW = 0.0;
          for (int i = 0; i < uTaps; i++) {
            float fi = float(i) + 0.5;
            float r = sqrt(fi / taps) * R;
            float a = fi * 2.39996323 + rot;
            vec4 s = textureLod(tPre, vUv + vec2(cos(a), sin(a)) * r * uTexel, 0.0);
            float bgCoc = max(min(coc0, s.a), 0.0);
            float bw = clamp((bgCoc - r + margin) / margin, 0.0, 1.0);
            bg += vec4(s.rgb, 1.0) * bw;
            // foreground scatters: each sample spreads its energy over its own CoC disc
            float fc = -s.a;
            float fw = clamp((fc - r + margin) / margin, 0.0, 1.0) * step(1.0, fc) / max(fc * fc, 1.0);
            fgCol += s.rgb * fw;
            fgW += fw;
          }
          bg.rgb /= bg.a;
          float alpha = clamp(fgW * R * R / taps, 0.0, 1.0);
          vec3 fg = fgW > 0.0 ? fgCol / fgW : bg.rgb;
          float defocused = smoothstep(0.5, 1.5, abs(coc0));
          vec3 rgb = mix(fg, mix(bg.rgb, fg, alpha), defocused);
          gl_FragColor = vec4(rgb, alpha);
        }`,
    });

    this.postMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          vec2 o = uTexel * 0.5; // 4 bilinear taps = 3x3 tent
          gl_FragColor = 0.25 * (texture2D(tSrc, vUv + vec2(-o.x, -o.y)) + texture2D(tSrc, vUv + vec2(o.x, -o.y))
                               + texture2D(tSrc, vUv + vec2(-o.x, o.y)) + texture2D(tSrc, vUv + vec2(o.x, o.y)));
        }`,
    });

    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: { ...s, ...this.litUniforms, tDof: { value: null } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        ${COC_GLSL}
        ${SANE_GLSL}
        ${LIT_GLSL}
        uniform sampler2D tDof;
        varying vec2 vUv;
        void main() {
          float dd;
          vec4 src = lit(vUv, dd);
          float c = cocDist(dd, src.a);
          vec4 dof = texture2D(tDof, vUv);
          float a = max(smoothstep(0.5, 1.5, abs(c)), dof.a);
          gl_FragColor = vec4(mix(src.rgb, dof.rgb, a), 1.0);
        }`,
    });

    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { ...s, ...this.litUniforms },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        ${COC_GLSL}
        ${SANE_GLSL}
        ${LIT_GLSL}
        varying vec2 vUv;
        void main() { float dd; gl_FragColor = vec4(lit(vUv, dd).rgb, 1.0); }`,
    });

    this.gradeMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.outTarget.texture },
        uTime: { value: 0 },
        uVignette: { value: 0.4 },
        uGrain: { value: 0.03 },
        uCA: { value: 0.001 },
        uFade: { value: 0 },
        uAspect: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uTime, uVignette, uGrain, uCA, uFade, uAspect;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          vec2 d = vUv - 0.5;
          float r = length(d * vec2(uAspect, 1.0));
          vec2 off = d * uCA * r;
          vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
          float v = 1.0 - smoothstep(0.35, 1.25, length(d * vec2(uAspect * 0.85, 1.0)) * 1.15);
          col *= mix(1.0, v, uVignette) * uFade;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          float n = hash(gl_FragCoord.xy + fract(uTime * 7.31) * 113.0) - 0.5;
          gl_FragColor.rgb += n * uGrain;
        }`,
    });

    // render targets persist across resizes, so texture bindings are set once
    const color = this.sceneTarget.texture;
    const depth = this.sceneTarget.depthTexture;
    this.litUniforms.tColor.value = color;
    this.litUniforms.tDepth.value = depth;
    this.tileMat.uniforms.tPre.value = this.preTarget.texture;
    this.gatherMat.uniforms.tPre.value = this.preTarget.texture;
    this.gatherMat.uniforms.tTile.value = this.tileTarget.texture;
    this.postMat.uniforms.tSrc.value = this.gatherTarget.texture;
    this.compositeMat.uniforms.tDof.value = this.postTarget.texture;

    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), config.bloom.strength, config.bloom.radius, config.bloom.threshold);
  }

  setSize(width: number, height: number) {
    // width/height are device pixels
    this.sceneTarget.setSize(width, height);
    this.outTarget.setSize(width, height);
    const cw = Math.ceil(width / 2);
    const ch = Math.ceil(height / 2);
    this.cloudTarget.setSize(cw, ch);
    this.cloudMaterial?.uniforms.uInvResolution.value.set(1 / cw, 1 / ch);
    const scale = Math.min(0.5, this.quality.maxRows / height);
    const dw = Math.max(1, Math.round(width * scale));
    const dh = Math.max(1, Math.round(height * scale));
    this.preTarget.setSize(dw, dh);
    this.gatherTarget.setSize(dw, dh);
    this.postTarget.setSize(dw, dh);
    const tw = Math.ceil(dw / TILE);
    const th = Math.ceil(dh / TILE);
    this.tileTarget.setSize(tw, th);

    this.shared.uDofHeight.value = dh;
    this.preMat.uniforms.uOffset.value.set(0.25 / dw, 0.25 / dh);
    this.tileMat.uniforms.uPreSize.value.set(dw, dh);
    this.gatherMat.uniforms.uTexel.value.set(1 / dw, 1 / dh);
    this.gatherMat.uniforms.uTileTexel.value.set(1 / tw, 1 / th);
    this.postMat.uniforms.uTexel.value.set(1 / dw, 1 / dh);
    this.gradeMat.uniforms.uAspect.value = width / height;
    this.bloom.setSize(width, height);
  }

  /**
   * Compile every program up front, in parallel, with the render target each one will
   * really draw into (three picks tone-mapping/colour-space variants from the bound
   * target, so compiling against the screen would leave the HDR variants for frame one).
   */
  async compile(scene: THREE.Scene, camera: THREE.Camera) {
    const r = this.renderer;
    const b = this.bloom;
    const quad = new THREE.PlaneGeometry(2, 2);
    const offscreen = new THREE.Scene();
    const mats = [this.preMat, this.tileMat, this.gatherMat, this.postMat, this.compositeMat, this.copyMat, b.materialHighPassFilter, b.compositeMaterial, b.blendMaterial, ...b.separableBlurMaterials];
    for (const m of mats) offscreen.add(new THREE.Mesh(quad, m));
    const screen = new THREE.Scene().add(new THREE.Mesh(quad, this.gradeMat));
    r.setRenderTarget(this.sceneTarget);
    await Promise.all([r.compileAsync(scene, camera), r.compileAsync(offscreen, camera)]);
    r.setRenderTarget(null);
    await r.compileAsync(screen, camera);
    quad.dispose();
  }

  setFocus(distance: number) {
    this.shared.uFocus.value = distance;
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, time: number) {
    const r = this.renderer;
    const d = config.dof;
    const s = this.shared;
    s.cameraNear.value = camera.near;
    s.cameraFar.value = camera.far;
    s.uRange.value = d.focusRange;
    s.uNear.value = d.nearBlur * d.bokehStrength;
    s.uFar.value = d.farBlur * d.bokehStrength;
    s.uNearMax.value = d.nearMax * d.bokehStrength;
    s.uFarMax.value = d.farMax * d.bokehStrength;

    r.shadowMap.needsUpdate = true; // once per frame, not again for the cloud pass
    r.setRenderTarget(this.sceneTarget);
    r.render(scene, camera);
    this.renderClouds(scene, camera);

    if (d.enabled) {
      this.pass(this.preMat, this.preTarget);
      this.pass(this.tileMat, this.tileTarget);
      this.pass(this.gatherMat, this.gatherTarget);
      this.pass(this.postMat, this.postTarget);
      this.pass(this.compositeMat, this.outTarget);
    } else {
      this.pass(this.copyMat, this.outTarget);
    }

    const b = config.bloom;
    this.bloom.strength = b.strength;
    this.bloom.radius = b.radius;
    this.bloom.threshold = b.threshold;
    if (b.strength > 0) this.bloom.render(r, this.outTarget, this.outTarget, 0, false);

    const g = this.gradeMat.uniforms;
    g.uTime.value = time;
    g.uVignette.value = config.post.vignette;
    g.uGrain.value = config.post.grain;
    g.uCA.value = config.post.chromatic;
    g.uFade.value = this.fade;
    this.quad.material = this.gradeMat;
    r.setRenderTarget(null);
    this.quad.render(r);
  }

  private renderClouds(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const r = this.renderer;
    const m = this.cloudMaterial;
    r.setRenderTarget(this.cloudTarget);
    r.getClearColor(this.clearColor);
    const alpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    if (m) {
      m.uniforms.tSceneDepth.value = this.sceneTarget.depthTexture;
      m.uniforms.uNear.value = camera.near;
      m.uniforms.uFar.value = camera.far;
      camera.layers.set(CLOUD_LAYER);
      r.render(scene, camera);
      camera.layers.set(0);
    } else r.clear();
    r.setClearColor(this.clearColor, alpha);
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }
}
