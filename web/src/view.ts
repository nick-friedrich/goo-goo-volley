// The 3D presentation. The game is 2D (x, y); we draw it on the z=0 plane of a
// sunset beach and let the camera, light and effects do the showing off.

import * as THREE from "three";
import type { Brain } from "../../sim/cpu";
import { BALL_R, COURT_W, FP, GOO_R, NET_TOP, NET_X, type GameEvent, type State } from "../../sim/index";
import { GooModel } from "./goo";

/** fixed-point simulation units → world units (100 sim units = 1 metre-ish) */
export const S = 0.01 / FP;
export const COLORS = ["#3ddc97", "#ff8c42"] as const;
const W = COURT_W * S; // 8
const NET_H = NET_TOP * S; // 1.7
const BR = BALL_R * S;
const GR = GOO_R * S;
const DEPTH = 1.85; // half depth of the visual court

const SKY = { top: new THREE.Color("#2a5fb0"), mid: new THREE.Color("#7fb2e8"), horizon: new THREE.Color("#ffc9a3") };
const SUN_DIR = new THREE.Vector3(0.55, 0.16, -1).normalize();

type CamMode = "live" | "menu" | "replay";

interface Particle {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  max: number;
  size: number;
  grav: number;
  color: THREE.Color;
}

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(36, 1, 0.1, 400);
  readonly goos: [GooModel, GooModel];
  private ball: THREE.Mesh;
  private ballShadow: THREE.Mesh;
  private gooShadows: THREE.Mesh[] = [];
  private sea: THREE.ShaderMaterial;
  private walls: THREE.ShaderMaterial[] = [];
  private net: { mesh: THREE.Mesh; base: Float32Array; hitY: number; age: number; amp: number };
  private clouds: THREE.Group[] = [];

  private particles: Particle[] = [];
  private particleMesh: THREE.InstancedMesh;
  private rings: { mesh: THREE.Mesh; age: number }[] = [];
  private trail: THREE.InstancedMesh;
  private trailPts: THREE.Vector3[] = [];

  private brainDots: THREE.InstancedMesh;
  private brainMeet: THREE.Mesh;
  private brainTarget: THREE.Group;
  private brainJump: THREE.Mesh;

  camMode: CamMode = "menu";
  private camPos = new THREE.Vector3(4, 3, 11);
  private camLook = new THREE.Vector3(4, 1.5, 0);
  private replayFocus = new THREE.Vector3(4, 1, 0);
  private replayT = 0;
  private shake = 0;
  private time = 0;
  readonly ballPos = new THREE.Vector3();
  private ballSpin = 0;
  private tmp = new THREE.Object3D();

  constructor(container: HTMLElement) {
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" }));
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    container.appendChild(r.domElement);

    this.scene.fog = new THREE.Fog(SKY.horizon, 45, 170);
    this.buildLights();
    this.buildSky();
    this.sea = this.buildSea();
    this.buildSand();
    this.buildCourt();
    this.net = this.buildNet();

    this.goos = [new GooModel(COLORS[0], GR, 1), new GooModel(COLORS[1], GR, -1)];
    for (const g of this.goos) this.scene.add(g.root);

    this.ball = this.buildBall();
    const shadowTex = radialTexture();
    const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, color: "#3b2410" });
    this.ballShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.ballShadow.position.y = 0.012;
    this.scene.add(this.ballShadow);
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat.clone());
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.011;
      this.scene.add(m);
      this.gooShadows.push(m);
    }

    this.particleMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }),
      600,
    );
    this.particleMesh.count = 0;
    this.particleMesh.frustumCulled = false;
    this.particleMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(600 * 3), 3);
    this.scene.add(this.particleMesh);

    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.82, 1, 48),
        new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      );
      m.visible = false;
      this.scene.add(m);
      this.rings.push({ mesh: m, age: 99 });
    }

    this.trail = new THREE.InstancedMesh(
      new THREE.SphereGeometry(BR, 12, 8),
      new THREE.MeshBasicMaterial({ color: "#fff3d6", transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
      14,
    );
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    // CPU brain overlay
    const cyan = new THREE.Color("#6ef0ff");
    const glow = (opacity = 1) =>
      new THREE.MeshBasicMaterial({ color: cyan, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    this.brainDots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.035, 10, 6), glow(0.9), 90);
    this.brainDots.frustumCulled = false;
    this.brainMeet = new THREE.Mesh(new THREE.TorusGeometry(BR + 0.08, 0.018, 8, 40), glow());
    this.brainTarget = new THREE.Group();
    const tRing = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.38, 40), glow(0.9));
    tRing.rotation.x = -Math.PI / 2;
    tRing.position.y = 0.02;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 3, 6, 1, true), glow(0.35));
    beam.position.y = 1.5;
    this.brainTarget.add(tRing, beam);
    this.brainJump = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.55, 48), glow(0.8));
    this.brainJump.rotation.x = -Math.PI / 2;
    this.brainJump.position.y = 0.025;
    this.scene.add(this.brainDots, this.brainMeet, this.brainTarget, this.brainJump);
    this.setBrain(null, 0);

    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  // ---------------------------------------------------------------- scene building

  private buildLights() {
    this.scene.add(new THREE.HemisphereLight("#bfe3ff", "#e9c08a", 1.1));
    const key = new THREE.DirectionalLight("#fff1dd", 2.4);
    key.position.set(-4, 10, 8);
    key.target.position.set(4, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -3; sc.right = 11; sc.top = 7; sc.bottom = -3; sc.near = 1; sc.far = 30;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key, key.target);
    // warm rim light from the low sun behind the court
    const rim = new THREE.DirectionalLight("#ffb27a", 1.6);
    rim.position.copy(SUN_DIR).multiplyScalar(20).add(new THREE.Vector3(4, 0, 0));
    this.scene.add(rim);
  }

  private buildSky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: SKY.top }, mid: { value: SKY.mid }, horizon: { value: SKY.horizon }, sunDir: { value: SUN_DIR },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform vec3 top, mid, horizon, sunDir; varying vec3 vDir;
        void main(){
          float h = vDir.y;
          vec3 c = mix(horizon, mid, smoothstep(-0.02, 0.22, h));
          c = mix(c, top, smoothstep(0.22, 0.85, h));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          c += vec3(1.0, 0.78, 0.5) * (pow(s, 900.0) * 3.0 + pow(s, 60.0) * 0.45 + pow(s, 6.0) * 0.18);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), mat);
    sky.position.x = 4;
    this.scene.add(sky);

    // puffy clouds made of squashed spheres
    const cloudMat = new THREE.MeshLambertMaterial({ color: "#fff4ea", emissive: "#ffd9c0", emissiveIntensity: 0.35, fog: false });
    const ball = new THREE.SphereGeometry(1, 14, 10);
    for (let i = 0; i < 9; i++) {
      const g = new THREE.Group();
      const n = 4 + Math.floor(Math.random() * 4);
      for (let k = 0; k < n; k++) {
        const m = new THREE.Mesh(ball, cloudMat);
        const s = 2 + Math.random() * 2.5;
        m.scale.set(s * 1.3, s * 0.7, s);
        m.position.set(k * 2.6 - n * 1.3 + Math.random(), Math.random() * 1.2, Math.random() * 2);
        g.add(m);
      }
      g.position.set(-80 + i * 22 + Math.random() * 10, 22 + Math.random() * 18, -150 - Math.random() * 40);
      this.scene.add(g);
      this.clouds.push(g);
    }
  }

  private buildSea() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { t: { value: 0 }, horizon: { value: SKY.horizon }, sunDir: { value: SUN_DIR } },
      vertexShader: `
        uniform float t; varying vec3 vW;
        void main(){
          vec4 w = modelMatrix * vec4(position, 1.0);
          w.y += sin(w.x * 0.35 + t * 0.9) * 0.05 + sin(w.z * 0.6 - t * 1.3) * 0.04;
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `
        uniform float t; uniform vec3 horizon, sunDir; varying vec3 vW;
        void main(){
          float far = smoothstep(-10.0, -120.0, vW.z);
          vec3 shallow = vec3(0.18, 0.78, 0.78), deep = vec3(0.07, 0.36, 0.62);
          vec3 c = mix(shallow, deep, smoothstep(-9.0, -35.0, vW.z));
          float w = sin(vW.x * 0.9 + t * 0.7 + sin(vW.z * 0.4)) * sin(vW.z * 1.7 - t * 1.4);
          // sun glitter path
          vec3 toSun = normalize(sunDir);
          float path = exp(-pow((vW.x - 4.0 - (-vW.z) * toSun.x / -toSun.z) * 0.08, 2.0));
          c += vec3(1.0, 0.85, 0.6) * smoothstep(0.7, 1.0, w) * (0.25 + path * 1.4) * (1.0 - far * 0.5);
          // foam where it meets the sand
          float shore = -9.1 + sin(vW.x * 0.45 + t * 0.8) * 0.35;
          float foam = smoothstep(0.55, 0.0, abs(vW.z - shore)) * (0.6 + 0.4 * sin(vW.x * 3.0 + t * 2.0));
          c = mix(c, vec3(0.98, 0.98, 0.95), clamp(foam, 0.0, 1.0) * 0.85);
          c = mix(c, horizon, far * 0.85);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(600, 300, 120, 60), mat);
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(4, -0.06, -159);
    this.scene.add(sea);
    return mat;
  }

  private buildSand() {
    const geo = new THREE.PlaneGeometry(220, 40, 220, 40);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(p.count * 3);
    const dry = new THREE.Color("#f2d6a2"), wet = new THREE.Color("#c9a873"), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + 4, z = p.getZ(i) + 10;
      const court = Math.max(Math.abs(x - 4) - 5.5, Math.abs(z) - 3);
      const dune = (Math.sin(x * 0.21) * Math.cos(z * 0.33) + Math.sin(x * 0.07 + z * 0.12)) * 0.35;
      const y = dune * THREE.MathUtils.smoothstep(court, 0, 6);
      p.setY(i, z < -8 ? Math.min(y, (z + 8) * 0.12) : y); // slope down into the sea
      c.copy(dry).lerp(wet, THREE.MathUtils.smoothstep(z, -5.5, -8.8));
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const tex = noiseTexture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(70, 14);
    const sand = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, roughness: 1 }));
    sand.position.set(4, 0, 10);
    sand.receiveShadow = true;
    this.scene.add(sand);
  }

  private buildCourt() {
    const lineMat = new THREE.MeshStandardMaterial({ color: "#fffdf6", roughness: 0.8, emissive: "#fff", emissiveIntensity: 0.12 });
    const line = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, d), lineMat);
      m.position.set(x, 0.006, z);
      m.receiveShadow = true;
      this.scene.add(m);
    };
    line(W, 0.06, W / 2, DEPTH);
    line(W, 0.06, W / 2, -DEPTH);
    line(0.06, DEPTH * 2, 0, 0);
    line(0.06, DEPTH * 2, W, 0);

    // Glass side walls: the ball really bounces off these, so make them visible.
    for (const x of [0, W]) {
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: { flash: { value: 0 }, hitY: { value: 1 }, t: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform float flash, hitY, t; varying vec2 vUv;
          void main(){
            float edge = smoothstep(0.035, 0.0, min(vUv.x, 1.0 - vUv.x)) + smoothstep(0.02, 0.0, vUv.y);
            float fade = 1.0 - smoothstep(0.35, 1.0, vUv.y);
            float scan = 0.5 + 0.5 * sin(vUv.y * 60.0 - t * 2.0);
            float d = distance(vec2(vUv.x * 0.8, vUv.y * 5.0), vec2(0.4, hitY / 1.0));
            float ripple = flash * smoothstep(0.6, 0.0, abs(d - (1.0 - flash) * 1.6)) ;
            float a = (0.05 + edge * 0.35 + scan * 0.02) * fade + ripple * 0.8;
            gl_FragColor = vec4(vec3(0.75, 0.95, 1.0) * a, a);
          }`,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(DEPTH * 2, 5), mat);
      m.rotation.y = Math.PI / 2;
      m.position.set(x, 2.5, 0);
      this.scene.add(m);
      this.walls.push(mat);
    }
  }

  private buildNet() {
    const postMat = new THREE.MeshStandardMaterial({ color: "#fdf6e8", roughness: 0.5 });
    for (const z of [-DEPTH - 0.05, DEPTH + 0.05]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, NET_H + 0.25, 16), postMat);
      post.position.set(NET_X * S, (NET_H + 0.25) / 2, z);
      post.castShadow = true;
      this.scene.add(post);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 10), new THREE.MeshStandardMaterial({ color: COLORS[z < 0 ? 0 : 1] }));
      cap.position.set(NET_X * S, NET_H + 0.26, z);
      this.scene.add(cap);
    }
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, DEPTH * 2 + 0.1), new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.6 }));
    band.position.set(NET_X * S, NET_H - 0.045, 0);
    band.castShadow = true;
    this.scene.add(band);

    const geo = new THREE.PlaneGeometry(DEPTH * 2, NET_H - 0.08, 36, 16);
    const tex = netTexture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(18, 8);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.9, color: "#20304f" }),
    );
    mesh.rotation.y = Math.PI / 2;
    mesh.position.set(NET_X * S, (NET_H - 0.08) / 2, 0);
    mesh.castShadow = true;
    this.scene.add(mesh);
    const base = Float32Array.from((geo.attributes.position as THREE.BufferAttribute).array as Float32Array);
    return { mesh, base, hitY: 1, age: 99, amp: 0 };
  }

  private buildBall() {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 256;
    const g = c.getContext("2d")!;
    const gores = ["#ffffff", "#ff5d73", "#ffd23f", "#3ddc97", "#ffffff", "#4d9de0", "#ff8c42", "#b388eb"];
    gores.forEach((col, i) => {
      g.fillStyle = col;
      g.fillRect((i * 512) / gores.length, 0, 512 / gores.length + 1, 256);
    });
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 512, 22);
    g.fillRect(0, 234, 512, 22);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(BR, 40, 28),
      new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.2 }),
    );
    ball.castShadow = true;
    ball.rotation.x = 0.5;
    this.scene.add(ball);
    return ball;
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- per frame

  /** Draw `cur`, interpolated from `prev` by `alpha` (0..1). */
  render(prev: State, cur: State, alpha: number, dt: number) {
    this.time += dt;
    const t = this.time;
    const lerp = (a: number, b: number) => (a + (b - a) * alpha) * S;

    // ball (no interpolation across teleports such as a new serve)
    const pb = prev.ball, cb = cur.ball;
    const jump = Math.abs(pb.x - cb.x) + Math.abs(pb.y - cb.y) > 60 * FP;
    const bx = jump ? cb.x * S : lerp(pb.x, cb.x);
    const by = jump ? cb.y * S : lerp(pb.y, cb.y);
    this.ballPos.set(bx, by, 0);
    this.ball.position.copy(this.ballPos);
    this.ballSpin -= ((cb.vx * S * 60) / BR) * dt * 0.6;
    this.ball.rotation.set(0.5, this.ballSpin * 0.3, this.ballSpin);
    const sh = THREE.MathUtils.clamp(1 - (by - BR) / 6, 0.15, 1);
    this.ballShadow.position.x = bx;
    this.ballShadow.scale.setScalar(BR * 2.6 * (1.6 - sh * 0.6));
    (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = 0.55 * sh;

    // trail when the ball is moving fast
    const speed = Math.hypot(cb.vx, cb.vy) / FP;
    this.trailPts.unshift(this.ballPos.clone());
    this.trailPts.length = Math.min(this.trailPts.length, 14);
    const tm = this.trail.material as THREE.MeshBasicMaterial;
    tm.opacity = this.camMode === "replay" ? 0 : THREE.MathUtils.clamp((speed - 12) / 10, 0, 1) * 0.25;
    for (let i = 0; i < 14; i++) {
      const p = this.trailPts[Math.min(i, this.trailPts.length - 1)];
      this.tmp.position.copy(p);
      this.tmp.scale.setScalar(Math.max(0.05, 1 - i / 14));
      this.tmp.updateMatrix();
      this.trail.setMatrixAt(i, this.tmp.matrix);
    }
    this.trail.instanceMatrix.needsUpdate = true;

    // goos
    for (let i = 0; i < 2; i++) {
      const a = prev.goos[i], b = cur.goos[i];
      const teleport = Math.abs(a.x - b.x) > 60 * FP;
      const x = teleport ? b.x * S : lerp(a.x, b.x);
      const y = (teleport ? b.y * S : lerp(a.y, b.y)) - GR;
      this.goos[i].update(dt, t, x, y, b.vx * S * 60, b.vy * S * 60, this.ballPos);
      const s = this.gooShadows[i];
      s.position.x = x;
      s.scale.setScalar(GR * 3.2 * (1 + y * 0.25));
      (s.material as THREE.MeshBasicMaterial).opacity = 0.5 / (1 + y * 1.4);
    }

    this.animateWorld(dt);
    this.updateCamera(dt, cur);
    this.renderer.render(this.scene, this.camera);
  }

  private animateWorld(dt: number) {
    const t = this.time;
    this.sea.uniforms.t.value = t;
    for (const w of this.walls) {
      w.uniforms.t.value = t;
      w.uniforms.flash.value = Math.max(0, w.uniforms.flash.value - dt * 2.2);
    }
    for (const c of this.clouds) c.position.x = ((c.position.x + dt * 0.6 + 100) % 200) - 100;

    // net ripple
    const n = this.net;
    n.age += dt;
    if (n.age < 2) {
      const pos = n.mesh.geometry.attributes.position as THREE.BufferAttribute;
      const k = n.amp * Math.exp(-n.age * 3.5);
      for (let i = 0; i < pos.count; i++) {
        const u = n.base[i * 3], v = n.base[i * 3 + 1] + (NET_H - 0.08) / 2;
        const d = Math.hypot(u, v - n.hitY);
        pos.setZ(i, k * Math.exp(-d * 1.6) * Math.sin(d * 9 - n.age * 22));
      }
      pos.needsUpdate = true;
    }

    // particles
    let alive = 0;
    const pm = this.particleMesh;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.max || alive >= 600) {
        this.particles.splice(i, 1);
        continue;
      }
      p.v.y -= p.grav * dt;
      p.p.addScaledVector(p.v, dt);
      if (p.p.y < 0.02) {
        p.p.y = 0.02;
        p.v.multiplyScalar(0.4);
      }
      const s = p.size * (1 - p.life / p.max);
      this.tmp.position.copy(p.p);
      this.tmp.rotation.set(p.life * 5, p.life * 3, 0);
      this.tmp.scale.setScalar(s);
      this.tmp.updateMatrix();
      pm.setMatrixAt(alive, this.tmp.matrix);
      pm.setColorAt(alive, p.color);
      alive++;
    }
    pm.count = alive;
    pm.instanceMatrix.needsUpdate = true;
    if (pm.instanceColor) pm.instanceColor.needsUpdate = true;

    for (const r of this.rings) {
      if (r.age > 0.45) {
        r.mesh.visible = false;
        continue;
      }
      r.age += dt;
      const k = r.age / 0.45;
      r.mesh.visible = true;
      r.mesh.scale.setScalar(0.25 + k * 0.9);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
      r.mesh.lookAt(this.camera.position);
    }
  }

  private updateCamera(dt: number, s: State) {
    const want = new THREE.Vector3(), look = new THREE.Vector3();
    const aspect = this.camera.aspect;
    const fit = 4.9 / (Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * Math.max(aspect, 0.45));
    const dist = THREE.MathUtils.clamp(fit, 8.6, 24);
    let k = 3;

    if (this.camMode === "menu") {
      const a = Math.sin(this.time * 0.12) * 0.55;
      want.set(4 + Math.sin(a) * (dist + 2), 3.4, Math.cos(a) * (dist + 2));
      look.set(4, 1.3, 0);
      k = 1.5;
    } else if (this.camMode === "replay") {
      this.replayT += dt;
      // frame the ball but keep the court and both goos in the shot
      const aim = this.ballPos.clone().lerp(new THREE.Vector3(4, 0.9, 0), 0.4);
      this.replayFocus.lerp(aim, 1 - Math.exp(-dt * 4));
      const a = -0.75 + this.replayT * 0.22;
      const f = this.replayFocus;
      const r = 6.6;
      want.set(f.x + Math.sin(a) * r, 1.2 + f.y * 0.35, Math.cos(a) * r);
      look.set(f.x, Math.max(0.6, f.y * 0.75 + 0.15), 0);
      k = this.replayT < 0.1 ? 30 : 6;
    } else {
      const bx = s.ball.x * S;
      const by = s.ball.y * S;
      const cx = 4 + (bx - 4) * 0.12;
      want.set(cx, 2.35 + Math.min(by, 6) * 0.06, dist);
      look.set(cx, 1.55 + Math.min(by, 6) * 0.05, 0);
      k = 4;
    }
    const f = 1 - Math.exp(-dt * k);
    this.camPos.lerp(want, f);
    this.camLook.lerp(look, f);
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const sh = this.shake * this.shake;
    this.camera.position.copy(this.camPos).add(
      new THREE.Vector3((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, 0),
    );
    this.camera.lookAt(this.camLook);
  }

  setCameraMode(m: CamMode) {
    if (m === "replay") {
      this.replayT = 0;
      this.replayFocus.copy(this.ballPos).lerp(new THREE.Vector3(4, 0.9, 0), 0.4);
    }
    this.camMode = m;
  }

  // ---------------------------------------------------------------- effects

  fx(e: GameEvent) {
    const x = e.x * S, y = e.y * S;
    const side = e.side as 0 | 1;
    switch (e.type) {
      case "hit": {
        this.goos[side].kick("hit", e.power);
        this.ring(x, y, COLORS[side]);
        this.burst(x, y, 6 + e.power, COLORS[side], 2.5 + e.power * 0.12, 0.2, 0.035);
        if (e.power >= 18) this.shake = Math.max(this.shake, 0.55);
        break;
      }
      case "jump":
        this.goos[side].kick("jump");
        this.sand(x, 8, 1.6);
        break;
      case "land":
        this.goos[side].kick("land", e.power);
        this.sand(x, 6 + e.power, 1.2 + e.power * 0.08);
        break;
      case "ground":
        this.sand(x, 22 + e.power * 2, 2 + e.power * 0.15);
        this.shake = Math.max(this.shake, 0.4 + e.power * 0.02);
        break;
      case "wall": {
        const w = this.walls[side].uniforms;
        w.flash.value = 1;
        w.hitY.value = y;
        break;
      }
      case "net":
        this.net.age = 0;
        this.net.hitY = y;
        this.net.amp = Math.min(0.18, 0.04 + e.power * 0.012) * (x < NET_X * S ? -1 : 1);
        break;
      case "point":
        this.goos[side].setMood(1);
        this.goos[1 - side].setMood(-1);
        break;
      case "serve":
        this.goos[0].setMood(0);
        this.goos[1].setMood(0);
        break;
      case "win":
        this.goos[side].setMood(1);
        for (let i = 0; i < 4; i++) this.burst(W * (0.2 + i * 0.2), 3.5, 40, COLORS[i % 2], 5, 0.6, 0.05, 2.5);
        break;
    }
  }

  private sand(x: number, n: number, speed: number) {
    const cols = ["#e8c88f", "#f6dfb3", "#d9b57a"].map((c) => new THREE.Color(c));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI;
      this.particles.push({
        p: new THREE.Vector3(x + (Math.random() - 0.5) * 0.4, 0.04, (Math.random() - 0.5) * 0.5),
        v: new THREE.Vector3(Math.cos(a) * speed, Math.sin(a) * speed * 0.9 + 0.5, (Math.random() - 0.5) * speed),
        life: 0, max: 0.5 + Math.random() * 0.5, size: 0.025 + Math.random() * 0.03, grav: 9, color: cols[i % 3],
      });
    }
  }

  private burst(x: number, y: number, n: number, color: string, speed: number, maxLife: number, size: number, grav = 4) {
    const c = new THREE.Color(color), w = new THREE.Color("#ffffff");
    for (let i = 0; i < n; i++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      this.particles.push({
        p: new THREE.Vector3(x, y, 0),
        v: d.multiplyScalar(speed * (0.4 + Math.random() * 0.6)),
        life: 0, max: maxLife + Math.random() * maxLife, size: size * (0.6 + Math.random()), grav,
        color: i % 3 === 0 ? w : c,
      });
    }
  }

  private ring(x: number, y: number, color: string) {
    const r = this.rings.find((r) => r.age > 0.45) ?? this.rings[0];
    r.age = 0;
    r.mesh.position.set(x, y, 0.05);
    (r.mesh.material as THREE.MeshBasicMaterial).color.set(color);
  }

  // ---------------------------------------------------------------- CPU brain overlay

  setBrain(b: Brain | null, side: number, gooX = 0) {
    const on = !!b && b.mode !== "idle";
    this.brainDots.visible = this.brainMeet.visible = this.brainTarget.visible = on;
    this.brainJump.visible = on && !!b && b.jumpIn >= 0;
    if (!b || !on) return;

    const n = Math.min(90, Math.floor(b.path.length / 2 / 2));
    for (let i = 0; i < n; i++) {
      const k = i * 2;
      this.tmp.position.set(b.path[k * 2] * S, b.path[k * 2 + 1] * S, 0.02);
      this.tmp.rotation.set(0, 0, 0);
      this.tmp.scale.setScalar(1 - (i / n) * 0.5);
      this.tmp.updateMatrix();
      this.brainDots.setMatrixAt(i, this.tmp.matrix);
    }
    this.brainDots.count = n;
    this.brainDots.instanceMatrix.needsUpdate = true;

    if (b.meetX !== null && b.meetY !== null) {
      this.brainMeet.position.set(b.meetX * S, b.meetY * S, 0);
      this.brainMeet.scale.setScalar(1 + Math.sin(this.time * 10) * 0.12);
      this.brainMeet.lookAt(this.camera.position);
    } else this.brainMeet.visible = false;

    this.brainTarget.position.set(b.targetX * S, 0, 0);
    if (b.jumpIn >= 0) {
      this.brainJump.position.x = gooX;
      this.brainJump.scale.setScalar(0.6 + Math.min(b.jumpIn, 40) / 25);
    }
    void side;
  }

  /** Screen position (CSS px) of a world point, for HTML labels. */
  toScreen(v: THREE.Vector3): { x: number; y: number } {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * innerWidth, y: (-p.y * 0.5 + 0.5) * innerHeight };
  }
}

// ---------------------------------------------------------------- procedural textures

function radialTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.5)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function noiseTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 215 + Math.random() * 40;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function netTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.strokeStyle = "#fff";
  g.lineWidth = 3;
  g.strokeRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}
