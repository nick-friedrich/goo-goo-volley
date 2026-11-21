// A Goo: a glossy jelly gumdrop with a drip on top and big eyes.
// Physically it is just a circle in the simulation; everything squishy here is
// presentation: a spring drives squash & stretch, a vertex shader adds wobble
// and lean, and the pupils track the ball.

import * as THREE from "three";

const BODY_GEO = (() => {
  // Unit sphere moved up so it sits on y=0, with the bottom flattened into a foot.
  const g = new THREE.SphereGeometry(1, 64, 40);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    let y = p.getY(i) + 1;
    if (y < 0.3) y = 0.3 - (0.3 - y) * 0.35;
    // slightly wider at the bottom, like a settling drop
    const spread = 1 + 0.12 * Math.max(0, 1 - y);
    p.setXYZ(i, p.getX(i) * spread, y - 0.195, p.getZ(i) * spread);
  }
  g.computeVertexNormals();
  return g;
})();

const TIP_GEO = (() => {
  // a little drip curling back from the top
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push(new THREE.Vector2(Math.sin(t * Math.PI) * 0.22 * (1 - t * 0.85) + 0.001, t * 0.55));
  }
  return new THREE.LatheGeometry(pts, 24);
})();

const EYE_GEO = new THREE.SphereGeometry(1, 24, 16);

export interface GooUniforms {
  uTime: { value: number };
  uWobble: { value: number };
  uLean: { value: number };
}

function jellyMaterial(color: THREE.ColorRepresentation, uniforms: GooUniforms) {
  const c = new THREE.Color(color);
  const m = new THREE.MeshPhysicalMaterial({
    color: c,
    roughness: 0.22,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    sheen: 0.8,
    sheenColor: c.clone().lerp(new THREE.Color("#ffffff"), 0.5),
    sheenRoughness: 0.4,
    emissive: c.clone().multiplyScalar(0.12),
  });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uTime; uniform float uWobble; uniform float uLean;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        float h = clamp(position.y / 1.8, 0.0, 1.0);
        transformed.x += uLean * h * h;
        float w = sin(position.y * 5.0 - uTime * 19.0) + 0.6 * sin(position.x * 7.0 + uTime * 13.0);
        transformed += normal * w * uWobble * 0.075 * (0.3 + h);`,
      );
  };
  return m;
}

export class GooModel {
  readonly root = new THREE.Group(); // positioned at the goo's foot
  private squash = new THREE.Group(); // scaled for squash & stretch
  private model = new THREE.Group(); // scaled to world size
  private eyes: { white: THREE.Mesh; pupil: THREE.Mesh; base: THREE.Vector3 }[] = [];
  private eyeGroup = new THREE.Group();
  readonly uniforms: GooUniforms = { uTime: { value: 0 }, uWobble: { value: 0 }, uLean: { value: 0 } };

  private stretch = 0;
  private stretchVel = 0;
  private lean = 0;
  private leanVel = 0;
  private blink = 2 + Math.random() * 3;
  private mood = 0; // >0 happy squint, <0 sad droop

  constructor(color: THREE.ColorRepresentation, radius: number, private toNet: number) {
    const mat = jellyMaterial(color, this.uniforms);
    const body = new THREE.Mesh(BODY_GEO, mat);
    body.castShadow = true;
    const tip = new THREE.Mesh(TIP_GEO, mat);
    tip.position.set(-toNet * 0.08, 1.52, -0.05);
    tip.rotation.z = toNet * 0.45;
    tip.castShadow = true;

    const white = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.25 });
    const dark = new THREE.MeshStandardMaterial({ color: "#141a2e", roughness: 0.15 });
    for (const sx of [-1, 1]) {
      const base = new THREE.Vector3(sx * 0.3 + toNet * 0.16, 1.12, 0.78);
      const w = new THREE.Mesh(EYE_GEO, white);
      w.scale.set(0.2, 0.25, 0.14);
      w.position.copy(base);
      const p = new THREE.Mesh(EYE_GEO, dark);
      p.scale.set(0.1, 0.12, 0.06);
      // highlight
      const hl = new THREE.Mesh(EYE_GEO, new THREE.MeshBasicMaterial({ color: "#ffffff" }));
      hl.scale.set(0.3, 0.3, 0.3);
      hl.position.set(0.35, 0.4, 0.8);
      p.add(hl);
      this.eyeGroup.add(w, p);
      this.eyes.push({ white: w, pupil: p, base });
    }

    this.model.add(body, tip, this.eyeGroup);
    this.model.scale.setScalar(radius);
    this.squash.add(this.model);
    this.root.add(this.squash);
  }

  kick(type: "jump" | "land" | "hit", power = 0) {
    if (type === "jump") this.stretchVel += 3.2;
    if (type === "land") this.stretchVel -= 1.2 + power * 0.22;
    if (type === "hit") {
      this.uniforms.uWobble.value = Math.min(1.4, this.uniforms.uWobble.value + 0.6 + power * 0.03);
      this.stretchVel -= 1.5;
    }
  }

  setMood(m: number) {
    this.mood = m;
  }

  /**
   * @param x,y   foot position in world units
   * @param vx,vy velocity in world units per second
   * @param look  world position the eyes should look at
   */
  update(dt: number, time: number, x: number, y: number, vx: number, vy: number, look: THREE.Vector3) {
    this.root.position.set(x, y, 0);

    // squash & stretch spring: stretch with vertical speed, overshoot on impacts
    const target = THREE.MathUtils.clamp(vy * 0.018, -0.12, 0.22);
    this.stretchVel += ((target - this.stretch) * 160 - this.stretchVel * 11) * dt;
    this.stretch = THREE.MathUtils.clamp(this.stretch + this.stretchVel * dt, -0.45, 0.5);
    const sy = 1 + this.stretch;
    const sxz = 1 / Math.sqrt(sy);
    this.squash.scale.set(sxz, sy, sxz);

    // the top lags behind horizontal motion like jelly
    const leanTarget = -vx * 0.05;
    this.leanVel += ((leanTarget - this.lean) * 90 - this.leanVel * 7) * dt;
    this.lean += this.leanVel * dt;
    this.uniforms.uLean.value = this.lean;

    this.uniforms.uTime.value = time;
    this.uniforms.uWobble.value = Math.max(0, this.uniforms.uWobble.value - dt * 1.6);

    // eyes: look at the ball, blink now and then
    this.blink -= dt;
    const closed = this.blink < 0.12 ? 0.1 : 1;
    if (this.blink < 0) this.blink = 2 + Math.random() * 4;
    const happy = this.mood > 0 ? 0.45 : 1;
    const sad = this.mood < 0 ? 0.6 : 1;

    const local = this.model.worldToLocal(look.clone());
    for (const e of this.eyes) {
      const dir = local.clone().sub(e.base);
      dir.z = 0;
      if (dir.lengthSq() > 1e-6) dir.normalize();
      e.white.scale.y = 0.25 * closed * happy * sad;
      e.pupil.position.set(e.base.x + dir.x * 0.08, e.base.y + dir.y * 0.09 - (1 - sad) * 0.08, e.base.z + 0.1);
      e.pupil.scale.y = 0.12 * Math.min(closed * happy * sad * 1.6, 1);
    }
  }
}
