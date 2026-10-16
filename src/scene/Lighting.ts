import * as THREE from 'three';
import { config } from '../config/sceneConfig';

// Moonlight motivates everything: a cool key/rim from the moon's direction
// (behind the hero), a faint warm fill from the front, a small sky ambient.

export class Lighting {
  readonly moonLight = new THREE.DirectionalLight();
  readonly fill = new THREE.DirectionalLight();
  readonly ambient = new THREE.HemisphereLight();
  private readonly moonDir = new THREE.Vector3(0, 0.3, -1);

  constructor(scene: THREE.Scene, shadows: boolean) {
    const key = this.moonLight;
    key.castShadow = shadows;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 40;
    const s = key.shadow.camera as THREE.OrthographicCamera;
    s.left = s.bottom = -2.2;
    s.right = s.top = 2.2;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.025;
    key.shadow.radius = 3;
    scene.add(key, key.target, this.fill, this.fill.target, this.ambient);
    this.applyConfig();
  }

  applyConfig() {
    const l = config.lighting;
    this.moonLight.color.set(l.moonLightColor);
    this.moonLight.intensity = l.moonLight;
    this.fill.color.set(l.fillColor);
    this.fill.intensity = l.fill;
    this.ambient.color.set(l.ambientSky);
    this.ambient.groundColor.set(l.ambientGround);
    this.ambient.intensity = l.ambient;
  }

  setMoonDirection(dir: THREE.Vector3) {
    this.moonDir.copy(dir);
  }

  update(heroPosition: THREE.Vector3, cameraPosition: THREE.Vector3) {
    this.moonLight.target.position.copy(heroPosition);
    this.moonLight.position.copy(heroPosition).addScaledVector(this.moonDir, 20);
    // fill from the camera side, low-left, so the face reads without going flat
    this.fill.target.position.copy(heroPosition);
    this.fill.position.set(cameraPosition.x - 7, heroPosition.y - 2, cameraPosition.z);
  }
}
