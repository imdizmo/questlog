/**
 * Home's background: four gradients, drawn in the page (no image files, nothing fetched), each a diagonal blend with
 * one soft glow, a vignette and a darker band behind the welcome text. Each person picks one (the first by default);
 * web/src/views/Home.tsx repaints it when the page changes size. Real pictures come later (the user's call, 19 Nov).
 */
type Rgb = [number, number, number];
export interface Picture {
  key: PicKey;
  name: string;
  /** The diagonal blend, top left to bottom right: [position 0..1, colour]. */
  stops: [number, Rgb][];
  /** One soft light: x, y (0..1 of the page), radius (of the longer side), colour, strength. */
  glow: [number, number, number, Rgb, number];
}
export type PicKey = 'ember' | 'fog' | 'night' | 'moss';

export const PICS: Picture[] = [
  { key: 'ember', name: 'Ember', stops: [[0, [20, 14, 9]], [0.55, [52, 30, 14]], [1, [96, 46, 18]]], glow: [0.72, 0.7, 0.32, [236, 150, 60], 0.32] },
  { key: 'fog', name: 'Sea fog', stops: [[0, [10, 16, 20]], [0.55, [26, 46, 54]], [1, [58, 86, 92]]], glow: [0.74, 0.3, 0.3, [190, 214, 212], 0.22] },
  { key: 'night', name: 'Night', stops: [[0, [12, 10, 22]], [0.55, [30, 24, 58]], [1, [70, 40, 92]]], glow: [0.8, 0.2, 0.26, [170, 160, 240], 0.25] },
  { key: 'moss', name: 'Moss', stops: [[0, [9, 15, 10]], [0.55, [24, 42, 24]], [1, [58, 80, 38]]], glow: [0.62, 0.3, 0.3, [200, 220, 140], 0.22] },
];
export const PIC_KEYS = PICS.map((p) => p.key);
export const picOf = (key: string): Picture => PICS.find((p) => p.key === key) ?? PICS[0];

const rgb = (a: Rgb, al: number) => `rgba(${a[0]},${a[1]},${a[2]},${al})`;

/** Paints `key` over the whole canvas at `w`×`h` CSS pixels (sharp up to twice the pixel density). */
export function paintScene(cv: HTMLCanvasElement, key: PicKey, w: number, h: number): void {
  const pic = picOf(key);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (cv.width !== w * dpr) cv.width = w * dpr;
  if (cv.height !== h * dpr) cv.height = h * dpr;
  const c = cv.getContext('2d');
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const D = Math.max(w, h);
  const bg = c.createLinearGradient(0, 0, w, h);
  for (const [at, col] of pic.stops) bg.addColorStop(at, rgb(col, 1));
  c.fillStyle = bg;
  c.fillRect(0, 0, w, h);
  const [x, y, r, col, al] = pic.glow;
  const g = c.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * D);
  g.addColorStop(0, rgb(col, al)); g.addColorStop(0.5, rgb(col, al * 0.35)); g.addColorStop(1, rgb(col, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  const v = c.createRadialGradient(w * 0.55, h * 0.5, D * 0.2, w * 0.55, h * 0.5, D * 0.75); // vignette
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.6)');
  c.fillStyle = v;
  c.fillRect(0, 0, w, h);
  const l = c.createLinearGradient(0, 0, Math.min(520, w * 0.5), 0); // darker behind the welcome text
  l.addColorStop(0, 'rgba(0,0,0,.45)'); l.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = l;
  c.fillRect(0, 0, w, h);
}
