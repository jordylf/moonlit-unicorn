import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { config } from '../config/sceneConfig';
import type { World } from './World';

// Dev-only (import.meta.env.DEV + ?debug). Edits the central config live.

export function createDebug(world: World) {
  const gui = new GUI({ title: 'scene · dev' });
  const apply = () => world.applyConfig();
  const relayout = () => world.layoutWorld();

  const dof = gui.addFolder('Depth of field');
  dof.add(config.dof, 'enabled');
  dof.add(config.dof, 'focusOffset', -6, 6, 0.01);
  dof.add(config.dof, 'focusRange', 0, 5, 0.01);
  dof.add(config.dof, 'nearBlur', 0, 0.08, 0.001);
  dof.add(config.dof, 'farBlur', 0, 0.05, 0.001);
  dof.add(config.dof, 'nearMax', 0, 0.06, 0.001);
  dof.add(config.dof, 'farMax', 0, 0.03, 0.0005);
  dof.add(config.dof, 'bokehStrength', 0, 2, 0.01);
  dof.add(config.dof, 'focusSmoothing', 0.2, 10, 0.1);

  const bloom = gui.addFolder('Bloom & post');
  bloom.add(config.bloom, 'strength', 0, 1.5, 0.01);
  bloom.add(config.bloom, 'radius', 0, 1, 0.01);
  bloom.add(config.bloom, 'threshold', 0, 4, 0.01);
  bloom.add(config.post, 'vignette', 0, 1, 0.01);
  bloom.add(config.post, 'grain', 0, 0.12, 0.001);
  bloom.add(config.post, 'chromatic', 0, 0.006, 0.0001);

  const light = gui.addFolder('Moon & light');
  light.add(config.moon, 'intensity', 0, 6, 0.01);
  light.add(config.moon, 'haloStrength', 0, 3, 0.01).onChange(apply);
  light.add(config.lighting, 'exposure', 0.2, 3, 0.01).onChange(apply);
  light.add(config.lighting, 'moonLight', 0, 10, 0.01).onChange(apply);
  light.addColor(config.lighting, 'moonLightColor').onChange(apply);
  light.add(config.lighting, 'fill', 0, 3, 0.01).onChange(apply);
  light.addColor(config.lighting, 'fillColor').onChange(apply);
  light.add(config.lighting, 'ambient', 0, 2, 0.01).onChange(apply);
  light.add(config.lighting, 'environment', 0, 2, 0.01).onChange(apply);
  light.add(config.lighting, 'hornGlow', 0, 3, 0.01);
  light.add(config.fog, 'density', 0, 0.02, 0.0001).name('fogDensity').onChange(apply);
  for (const k of Object.keys(config.sky) as (keyof typeof config.sky)[]) light.addColor(config.sky, k).name(`sky.${k}`).onChange(apply);

  const cam = gui.addFolder('Camera');
  cam.add(config.camera, 'parallaxStrength', 0, 3, 0.01);
  cam.add(config.camera, 'parallaxDamping', 0.2, 8, 0.1);
  cam.add(config.camera, 'pushAmplitude', 0, 3, 0.01);
  cam.add(config.camera, 'orbitAmplitude', 0, 0.3, 0.001);
  cam.add(config.camera, 'heroFollow', 0, 1, 0.01);
  cam.add(config.camera.desktop, 'fov', 15, 60, 0.1).name('desktop fov').onFinishChange(relayout);
  cam.add(config.camera.desktop, 'distance', 6, 30, 0.1).name('desktop distance').onFinishChange(relayout);

  const clouds = gui.addFolder('Clouds & stars');
  clouds.add(config.clouds, 'density', 0.2, 2, 0.01).onFinishChange(relayout);
  clouds.add(config.clouds, 'speed', 0, 5, 0.01);
  clouds.add(config.clouds, 'extinction', 0.1, 6, 0.01).onChange(apply);
  clouds.add(config.clouds, 'moonlight', 0, 12, 0.01).onChange(apply);
  clouds.add(config.clouds, 'forwardScatter', 0, 0.95, 0.01).onChange(apply);
  clouds.add(config.clouds, 'detail', 0, 0.9, 0.01).onChange(apply);
  clouds.addColor(config.clouds, 'ambientTop').onChange(apply);
  clouds.addColor(config.clouds, 'ambientBottom').onChange(apply);
  clouds.add(config.stars, 'brightness', 0, 3, 0.01);
  clouds.add(config.stars, 'twinkle', 0, 2, 0.01);
  clouds.add(config.particles, 'dustBrightness', 0, 3, 0.01);

  const hero = gui.addFolder('Unicorn');
  hero.add(config.hero, 'style', ['toon', 'realistic']).onChange((v: 'toon' | 'realistic') => world.hero?.setStyle(v));
  hero.addColor(config.toon, 'lit').name('toon lit').onChange(apply);
  hero.addColor(config.toon, 'shadow').name('toon shadow').onChange(apply);
  hero.add(config.toon, 'outline', 0, 0.004, 0.0001).name('ink width').onChange(apply);
  hero.addColor(config.toon, 'outlineColor').name('ink colour').onChange(apply);
  hero.add(config.hero, 'yaw', -Math.PI, Math.PI, 0.01);
  hero.add(config.hero, 'scale', 0.3, 2, 0.01);
  hero.add(config.hero, 'floatAmplitude', 0, 1, 0.01);
  hero.add(config.hero, 'floatSpeed', 0, 3, 0.01);
  hero.add(config.hero, 'driftAmplitude', 0, 1.5, 0.01);
  hero.add(config.hero, 'rotationAmplitude', 0, 3, 0.01);
  hero.add(config.hero, 'legAmplitude', 0, 0.3, 0.001);
  hero.add(config.hero, 'maneResponse', 0, 3, 0.01);
  hero.add(config.interaction, 'strength', 0, 2, 0.01).name('drag strength');
  hero.add(config.interaction, 'springStiffness', 2, 120, 0.5);
  hero.add(config.interaction, 'springDamping', 0.5, 30, 0.1);

  for (const f of gui.folders) f.close();
  return gui;
}
