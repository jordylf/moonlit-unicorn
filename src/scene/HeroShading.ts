import * as THREE from 'three';

// Hero material patches, shared by every hero material (body, eyes, ears, horn, hair):
// a stylised moon rim, moonlight translucency, and NaN-safe tangent-space maths.

// Stylised moon rim: fresnel on silhouette edges that face the moon. Shared by all
// hero materials; uRimDir is the moon direction in view space, set every frame.
export const rimUniforms = {
  uRimDir: { value: new THREE.Vector3(0, 1, 0) },
  uRimColor: { value: new THREE.Color() },
  uRimStrength: { value: 1 },
};

// Moonlight passing through thin parts toward the camera (subsurface translucency,
// Barré-Brisebois style). Per material: ears and hair are thin, the body barely.
const TRANSLUCENCY: Record<string, number> = { Ears_Blush: 1.4, Hair_Rose: 0.22, Hair_Magenta: 0.22, Body_Porcelain: 0.16 };
// rim strength per material: hair already gets light through its strand layers
const RIM: Record<string, number> = { Hair_Rose: 0.3, Hair_Magenta: 0.3 };

const heroLightGlsl = (translucency: number, rim: number) => /* glsl */ `{
  vec3 viewDirR = normalize(vViewPosition);
  float rimF = pow(1.0 - clamp(dot(normal, viewDirR), 0.0, 1.0), 4.0);
  float rimSide = smoothstep(-0.3, 0.7, dot(normal, uRimDir));
  outgoingLight += uRimColor * rimF * rimSide * uRimStrength * ${rim.toFixed(3)} * mix(vec3(0.45), diffuseColor.rgb, 0.4);
  vec3 through = normalize(uRimDir + normal * 0.45);
  float trans = pow(clamp(dot(viewDirR, -through), 0.0, 1.0), 3.0) + 0.12 * (1.0 - clamp(dot(normal, uRimDir) * 0.5 + 0.5, 0.0, 1.0));
  outgoingLight += uRimColor * diffuseColor.rgb * trans * ${translucency.toFixed(3)} * uRimStrength;
}
#include <opaque_fragment>`;

// --- NaN-safe tangent space ---------------------------------------------------------
// Root cause of the "black screen while dragging" bug: a few inner mane/tail faces have
// (near-)zero tangents. three normalises them as-is (vertex tangent frame, fragment
// tangent frame, normal map, anisotropic bent normal), so when the swinging mane exposes
// those faces a handful of pixels turn NaN, and bloom spreads one NaN over the whole
// frame. Every normalisation on that path gets a length guard with a sane fallback.
// The guards only ever compare finite values (D3D compilers may drop NaN checks).
export const SAFE_NORMALIZE_GLSL = /* glsl */ `
vec3 safeNormalize(vec3 v, vec3 fallback) {
  float l2 = dot(v, v);
  return l2 > 1e-12 ? v * inversesqrt(l2) : fallback;
}
vec3 anyPerpendicular(vec3 n) {
  return normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
}
mat3 safeTBN(vec3 t, vec3 b, vec3 n) {
  t = safeNormalize(t - n * dot(n, t), anyPerpendicular(n));
  vec3 bb = cross(n, t);
  return mat3(t, dot(bb, b) < 0.0 ? -bb : bb, n);
}
`;

function patchChunk(name: keyof typeof THREE.ShaderChunk, pairs: [string, string][]) {
  let src = THREE.ShaderChunk[name];
  for (const [a, b] of pairs) {
    if (import.meta.env.DEV && !src.includes(a)) console.warn(`three changed ${name}: NaN guard not applied for "${a}"`);
    src = src.replaceAll(a, b);
  }
  return src;
}

const SAFE_NORMAL_VERTEX = patchChunk('normal_vertex', [
  ['vNormal = normalize( transformedNormal );', 'vNormal = safeNormalize( transformedNormal, vec3( 0.0, 0.0, 1.0 ) );'],
  ['vTangent = normalize( transformedTangent );', 'vTangent = safeNormalize( transformedTangent, anyPerpendicular( vNormal ) );'],
  ['vBitangent = normalize( cross( vNormal, vTangent ) * tangent.w );', 'vBitangent = safeNormalize( cross( vNormal, vTangent ) * tangent.w, anyPerpendicular( vNormal ) );'],
]);
const SAFE_NORMAL_BEGIN = patchChunk('normal_fragment_begin', [
  ['vec3 normal = normalize( vNormal );', 'vec3 normal = safeNormalize( vNormal, vec3( 0.0, 0.0, 1.0 ) );'],
  ['mat3( normalize( vTangent ), normalize( vBitangent ), normal )', 'safeTBN( vTangent, vBitangent, normal )'],
]);
const SAFE_NORMAL_MAPS = patchChunk('normal_fragment_maps', [['normal = normalize( tbn * mapN );', 'normal = safeNormalize( tbn * mapN, normal );']]);
const SAFE_ENVMAP_PHYSICAL = patchChunk('envmap_physical_pars_fragment', [
  ['bentNormal = normalize( cross( bentNormal, bitangent ) );', 'bentNormal = safeNormalize( cross( bentNormal, bitangent ), normal );'],
  [
    'bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );',
    'bentNormal = safeNormalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ), normal );',
  ],
]);

const patched = new WeakSet<THREE.Material>();

type ShaderEdit = { key: string; edit: (shader: THREE.WebGLProgramParametersWithUniforms) => void };

/** Patch a hero material; `extra` adds a further edit (e.g. the eyes' iris) on top. */
export function patchHeroMaterial(material: THREE.Material, extra?: ShaderEdit) {
  if (patched.has(material)) return;
  patched.add(material);
  const translucency = TRANSLUCENCY[material.name] ?? 0;
  const rim = RIM[material.name] ?? 1;
  material.customProgramCacheKey = () => `hero-${translucency}-${rim}-${extra?.key ?? ''}`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, rimUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SAFE_NORMALIZE_GLSL)
      .replace('#include <normal_vertex>', SAFE_NORMAL_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRimDir, uRimColor;\nuniform float uRimStrength;\n' + SAFE_NORMALIZE_GLSL)
      .replace('#include <envmap_physical_pars_fragment>', SAFE_ENVMAP_PHYSICAL)
      .replace('#include <normal_fragment_begin>', SAFE_NORMAL_BEGIN)
      .replace('#include <normal_fragment_maps>', SAFE_NORMAL_MAPS)
      .replace('#include <opaque_fragment>', heroLightGlsl(translucency, rim));
    extra?.edit(shader);
  };
}


// --- Toon style ---------------------------------------------------------------------
// Cel shading done by hand (three's lights are ignored for these materials): a main
// light fixed in view space (upper-front-left, so the face always reads), two crisp
// bands with tinted shadows, a crisp moon rim band, a toon specular dab on glossy parts,
// and a warm wash from the horn glow. Ink outlines come from an inverted hull.

export const toonUniforms = {
  uToonLight: { value: new THREE.Vector3(-0.45, 0.62, 0.64).normalize() },
  uShadowTint: { value: new THREE.Color() },
  uLitTint: { value: new THREE.Color() },
  uWarmColor: { value: new THREE.Color('#ffbf73') },
  uWarm: { value: 0 },
  uToonBoost: { value: 1 },
};

export const TOON_GLSL = /* glsl */ `
uniform vec3 uToonLight, uShadowTint, uLitTint, uWarmColor;
uniform float uWarm, uToonBoost;
vec3 toonShade(vec3 albedo, vec3 N, vec3 V, float gloss) {
  float nl = dot(N, uToonLight);
  float lit = smoothstep(-0.04, 0.04, nl + 0.12);
  float high = smoothstep(0.6, 0.66, nl);
  vec3 col = albedo * mix(uShadowTint, uLitTint, lit) + albedo * uLitTint * high * 0.08;
  float fres = 1.0 - clamp(dot(N, V), 0.0, 1.0);
  float rim = smoothstep(0.56, 0.62, fres) * smoothstep(-0.2, 0.15, dot(N, uRimDir));
  col += uRimColor * rim * uRimStrength * 0.42 * mix(vec3(1.0), albedo, 0.35);
  vec3 H = safeNormalize(uToonLight + V, N);
  col += vec3(smoothstep(0.962, 0.972, dot(N, H)) * gloss);
  col += albedo * uWarmColor * uWarm * smoothstep(0.15, 0.9, N.y) * 0.3;
  return col * uToonBoost;
}
`;

// how much of a crisp specular dab each material gets
const TOON_GLOSS: Record<string, number> = { Body_Porcelain: 0, Ears_Blush: 0, Eyes_Obsidian: 0.9, Horn_Gold: 0.75, Horn_Spiral: 0.4, Hooves_Charcoal: 0.35, Hair_Rose: 0.0, Hair_Magenta: 0.0, Eye_Rims: 0.2 };

export function syncToonColors(shadow: string, lit: string) {
  toonUniforms.uShadowTint.value.set(shadow);
  toonUniforms.uLitTint.value.set(lit);
}

/** A cel-shaded twin of a hero material (same colours), with optional extra edit. */
export function makeToonMaterial(src: THREE.MeshStandardMaterial, extra?: ShaderEdit) {
  const m = new THREE.MeshToonMaterial({ name: src.name, color: src.color, emissive: src.emissive, emissiveIntensity: src.emissiveIntensity, side: src.side });
  const gloss = TOON_GLOSS[src.name] ?? 0.08;
  m.customProgramCacheKey = () => `toon-${gloss}-${extra?.key ?? ''}`;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, rimUniforms, toonUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SAFE_NORMALIZE_GLSL)
      .replace('#include <normal_vertex>', SAFE_NORMAL_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRimDir, uRimColor;\nuniform float uRimStrength;\n' + SAFE_NORMALIZE_GLSL + TOON_GLSL)
      .replace('#include <normal_fragment_begin>', SAFE_NORMAL_BEGIN)
      .replace(
        '#include <opaque_fragment>',
        `outgoingLight = toonShade(diffuseColor.rgb, normal, safeNormalize(vViewPosition, vec3(0.0, 0.0, 1.0)), ${gloss.toFixed(3)}) + totalEmissiveRadiance;\n#include <opaque_fragment>`,
      );
    extra?.edit(shader);
  };
  return m;
}

export const outlineUniforms = {
  uOutlineWidth: { value: 0.0013 },
  uOutlineColor: { value: new THREE.Color('#120a24') },
};

/** Inverted-hull ink line; works for skinned and plain meshes. `scale` widens it. */
export function makeOutlineMaterial(scale: number) {
  return new THREE.ShaderMaterial({
    uniforms: { ...outlineUniforms, uScale: { value: scale } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <skinning_pars_vertex>
      ${SAFE_NORMALIZE_GLSL}
      uniform float uOutlineWidth, uScale;
      void main() {
        vec3 objectNormal = normal;
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        vec3 transformed = position;
        #include <skinning_vertex>
        vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
        vec3 n = safeNormalize(normalMatrix * objectNormal, vec3(0.0, 0.0, 1.0));
        mv.xyz += n * uOutlineWidth * uScale * max(-mv.z, 0.5); // ~constant width on screen
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uOutlineColor;
      void main() { gl_FragColor = vec4(uOutlineColor, 1.0); }`,
    side: THREE.BackSide,
  });
}
