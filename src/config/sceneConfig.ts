// All artistic values in one place. Units: world units (the unicorn is ~2 tall),
// seconds, radians unless marked "deg". The debug panel (?debug in dev) edits this
// object live; most systems read it every frame.

export type Layout = {
  fov: number; // vertical, deg
  distance: number; // camera → look target
  elevation: number; // camera pitch around target (negative = camera below)
  azimuth: number; // camera yaw around target
  lookOffset: [number, number, number]; // look target relative to hero
  moonNdc: [number, number]; // where the moon sits on screen
  moonAngularRadius: number; // deg
};

export const config = {
  hero: {
    position: [0, 0, 0] as [number, number, number],
    scale: 1,
    yaw: 0.88, // base heading: three-quarter view, facing left toward camera
    floatAmplitude: 0.2,
    floatSpeed: 1,
    driftAmplitude: 0.32,
    rotationAmplitude: 1,
    legAmplitude: 0.085,
    maneResponse: 1,
    style: 'toon' as 'toon' | 'realistic', // hero shading; the debug panel switches it live
  },

  toon: {
    lit: '#c9cadf', // lit band (multiplies the albedo)
    shadow: '#55508c', // shadow band: lavender, not grey
    outline: 0.0013, // ink width, fraction of view depth (~1.5 px at 1080p)
    outlineColor: '#130b26',
  },

  camera: {
    desktop: {
      fov: 30,
      distance: 13,
      elevation: -0.2,
      azimuth: 0.05,
      lookOffset: [0.6, 0.55, 0],
      moonNdc: [0.42, 0.42],
      moonAngularRadius: 3.0,
    } as Layout,
    mobile: {
      fov: 46,
      distance: 12.8,
      elevation: -0.33,
      azimuth: 0.03,
      lookOffset: [0.1, 1.3, 0],
      moonNdc: [0.24, 0.56],
      moonAngularRadius: 3.7,
    } as Layout,
    parallaxStrength: 1, // lateral/vertical camera travel from the pointer
    parallaxDamping: 1.6, // higher = snappier
    pushAmplitude: 0.55, // slow dolly in/out
    orbitAmplitude: 0.05, // slow yaw drift around the hero
    heroFollow: 0.22, // how much the camera follows the hero's drift
    introDistance: 4.5, // extra distance at start, eased out
    introDuration: 9,
  },

  moon: {
    distance: 420,
    intensity: 1.05,
    haloStrength: 1,
  },

  sky: {
    top: '#010206',
    mid: '#03050f',
    horizon: '#0a0f25',
    violet: '#0d0a1f',
    below: '#05070f',
    halo: '#7486c4',
    haloWarm: '#e2d8c6',
  },

  lighting: {
    exposure: 1,
    moonLight: 5, // key/rim from the moon direction
    moonLightColor: '#cdd8ff',
    rim: 1.5, // stylised moon rim on the hero's silhouette
    fill: 0.62, // soft front fill (cool; the horn adds the warm accent)
    fillColor: '#d8dcff',
    ambient: 0.4,
    ambientSky: '#5a68a8',
    ambientGround: '#160f22',
    environment: 0.48,
    hornGlow: 1.1,
    shadows: true,
  },

  clouds: {
    density: 1, // multiplier on instance counts (applied on rebuild)
    speed: 1,
    // volumetric: light transport, not paint
    extinction: 2.2, // optical density per world unit
    moonlight: 1.9, // in-scattered moonlight strength
    forwardScatter: 0.62, // Henyey-Greenstein g: silver lining toward the moon
    detail: 0.42, // edge erosion by fine Worley noise
    ambientTop: '#121831',
    ambientBottom: '#04060d',
  },

  stars: {
    count: 2400,
    brightness: 1,
    twinkle: 1,
  },

  particles: {
    dust: 170,
    dustBrightness: 1,
  },

  dof: {
    enabled: true,
    focusOffset: 0, // added to the auto-focus distance on the hero's head
    focusRange: 1.15, // half-width of the sharp band, world units
    nearBlur: 0.034, // CoC growth in front of the band (fraction of screen height)
    farBlur: 0.02, // CoC growth behind the band
    nearMax: 0.04,
    farMax: 0.016,
    bokehStrength: 1,
    focusSmoothing: 2.2,
  },

  bloom: {
    strength: 0.34,
    radius: 0.55,
    threshold: 1.05,
  },

  post: {
    vignette: 0.42,
    grain: 0.03,
    chromatic: 0.0012,
  },

  fog: {
    density: 0.0042,
  },

  interaction: {
    strength: 1,
    dragExtent: [2.2, 1.4, 1.2] as [number, number, number],
    springStiffness: 30,
    springDamping: 6.2,
  },

  quality: {
    dprDesktop: 1.75,
    dprMobile: 1.5,
  },
};

export type SceneConfig = typeof config;
