/**
 * The Assets page's orbit viewer for a stored `.glb` (Marmoset/ArtStation-like: drag to turn, scroll to zoom, Lit /
 * Clay / Wireframe, turntable). three.js is loaded only here, when a model is opened, and everything it made is
 * disposed on close: renderer and its WebGL context, geometries, materials and their textures.
 *
 * A `.glb` holds its own buffers and pictures. Anything it would load from elsewhere (an external URI) is never
 * fetched: the loader gets an empty answer instead.
 */
import type * as THREE_NS from 'three';

type Three = typeof THREE_NS;
export type ViewMode = 'lit' | 'clay' | 'wire';
export interface Viewer { mode(m: ViewMode): void; spin(on: boolean): void; dispose(): void }

const loadThree = () => Promise.all([
  import('three'),
  import('three/addons/loaders/GLTFLoader.js'),
  import('three/addons/controls/OrbitControls.js'),
]);

/** Every texture a material holds (maps of any kind). */
function texturesOf(T: Three, m: THREE_NS.Material): THREE_NS.Texture[] {
  return Object.values(m).filter((v): v is THREE_NS.Texture => v instanceof T.Texture);
}

/** Disposes what a scene holds: geometries, materials, textures. */
function disposeScene(T: Three, root: THREE_NS.Object3D, extra: THREE_NS.Material[] = []): void {
  const mats = new Set<THREE_NS.Material>(extra);
  root.traverse((o) => {
    const mesh = o as THREE_NS.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const m = mesh.material;
    if (Array.isArray(m)) m.forEach((x) => mats.add(x)); else if (m) mats.add(m);
  });
  for (const m of mats) {
    for (const t of texturesOf(T, m)) {
      // The loader decodes embedded pictures to ImageBitmaps: close them, or the decoded pixels stay until GC.
      const data = t.source?.data as { close?: () => void } | undefined;
      if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) data.close();
      t.dispose();
    }
    m.dispose();
  }
}

/** The model parsed from its bytes, with external URIs answered empty. */
async function parse(glb: ArrayBuffer): Promise<{ T: Three; model: THREE_NS.Group; Orbit: typeof import('three/addons/controls/OrbitControls.js').OrbitControls }> {
  const [T, { GLTFLoader }, { OrbitControls }] = await loadThree();
  const manager = new T.LoadingManager();
  manager.setURLModifier((url) => (/^(data|blob):/.test(url) ? url : 'data:application/octet-stream;base64,'));
  const loader = new GLTFLoader(manager);
  const gltf = await new Promise<{ scene: THREE_NS.Group }>((ok, no) => loader.parse(glb, '', ok as any, no));
  return { T, model: gltf.scene, Orbit: OrbitControls };
}

interface Stage { scene: THREE_NS.Scene; camera: THREE_NS.PerspectiveCamera; center: THREE_NS.Vector3; ground: THREE_NS.Mesh; radius: number }

/** Lights, a ground disc under the model, and a camera that frames it. */
function stage(T: Three, model: THREE_NS.Object3D, bg: string, aspect: number): Stage {
  const scene = new T.Scene();
  scene.background = new T.Color(bg);
  scene.add(model);
  const box = new T.Box3().setFromObject(model);
  const center = box.getCenter(new T.Vector3());
  const radius = Math.max(box.getSize(new T.Vector3()).length() / 2, 1e-3);
  scene.add(new T.HemisphereLight('#ffe9cf', '#2a2118', 1.2));
  const sun = new T.DirectionalLight('#ffffff', 2);
  sun.position.set(center.x + radius * 2, center.y + radius * 3, center.z + radius);
  scene.add(sun);
  const rim = new T.DirectionalLight('#8fb2ff', 0.8);
  rim.position.set(center.x - radius * 2, center.y + radius, center.z - radius * 2);
  scene.add(rim);
  const ground = new T.Mesh(new T.CircleGeometry(radius * 1.6, 64), new T.MeshStandardMaterial({ color: '#2a241e', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center.x, box.min.y - radius * 0.002, center.z);
  scene.add(ground);
  const camera = new T.PerspectiveCamera(35, aspect, radius / 100, radius * 100);
  // Far enough that the bounding sphere fits the narrower side of the view, from a little above and to the side.
  const half = T.MathUtils.degToRad(35 / 2);
  const fit = radius / Math.sin(Math.min(half, Math.atan(Math.tan(half) * aspect))) * 1.1;
  camera.position.copy(center).addScaledVector(new T.Vector3(1.6, 0.9, 2.2).normalize(), fit);
  camera.lookAt(center);
  return { scene, camera, center, ground, radius };
}

/** Opens the viewer in `host` (filled by the canvas). `bg` is the stage colour. */
export async function openViewer(host: HTMLElement, glb: ArrayBuffer, bg: string): Promise<Viewer> {
  const { T, model, Orbit } = await parse(glb);
  const w = Math.max(host.clientWidth, 1), h = Math.max(host.clientHeight, 1);
  const renderer = new T.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(w, h);
  host.appendChild(renderer.domElement);
  const s = stage(T, model, bg, w / h);
  const controls = new Orbit(s.camera, renderer.domElement);
  controls.target.copy(s.center);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.6;
  controls.minDistance = s.radius * 0.3;
  controls.maxDistance = s.radius * 8;
  controls.update();

  // Lit: the model's own materials. Clay and wireframe swap in one shared material per mode.
  const own = new Map<THREE_NS.Mesh, THREE_NS.Material | THREE_NS.Material[]>();
  model.traverse((o) => { const m = o as THREE_NS.Mesh; if (m.isMesh) own.set(m, m.material); });
  const clay = new T.MeshStandardMaterial({ color: '#b9b2a6', roughness: 0.85, metalness: 0 });
  const wire = new T.MeshBasicMaterial({ color: '#ec8219', wireframe: true });

  let raf = 0;
  const loop = () => { controls.update(); renderer.render(s.scene, s.camera); raf = requestAnimationFrame(loop); };
  loop();
  const ro = new ResizeObserver(() => {
    const W = host.clientWidth, H = host.clientHeight;
    if (!W || !H) return;
    renderer.setSize(W, H);
    s.camera.aspect = W / H;
    s.camera.updateProjectionMatrix();
  });
  ro.observe(host);

  let disposed = false;
  return {
    mode(md) {
      for (const [mesh, m] of own) mesh.material = md === 'clay' ? clay : md === 'wire' ? wire : m;
    },
    spin(on) { controls.autoRotate = on; },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      for (const [mesh, m] of own) mesh.material = m; // so the walk below finds the model's own materials
      disposeScene(T, s.scene, [clay, wire]);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      own.clear();
    },
  };
}

/** A still picture of the model (PNG, `size` px square) for the gallery; everything is disposed afterwards. */
export async function renderThumbnail(glb: ArrayBuffer, size = 512): Promise<Blob> {
  const { T, model } = await parse(glb);
  const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    const s = stage(T, model, '#1a1714', 1);
    renderer.render(s.scene, s.camera);
    const blob = await new Promise<Blob | null>((ok) => renderer.domElement.toBlob(ok, 'image/png'));
    disposeScene(T, s.scene);
    if (!blob) throw new Error('no picture');
    return blob;
  } finally {
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
