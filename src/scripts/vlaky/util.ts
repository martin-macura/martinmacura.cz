import { BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, Scene, Uint32BufferAttribute } from "three";

export const mod = (a: number, n: number) => ((a % n) + n) % n;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function rng(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const hash2 = (a: number, b: number) => {
	let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return (h ^ (h >>> 16)) >>> 0;
};
const rnd2 = (a: number, b: number) => hash2(a, b) / 4294967296;

/** value noise, 0..1, one feature per unit */
export function smooth(x: number, z: number) {
	const ix = Math.floor(x);
	const iz = Math.floor(z);
	const fx = x - ix;
	const fz = z - iz;
	const sx = fx * fx * (3 - 2 * fx);
	const sz = fz * fz * (3 - 2 * fz);
	const a = rnd2(ix, iz);
	const b = rnd2(ix + 1, iz);
	const c = rnd2(ix, iz + 1);
	const d = rnd2(ix + 1, iz + 1);
	return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

export function fbm(x: number, z: number, octaves = 3) {
	let v = 0;
	let amp = 0.5;
	let freq = 1;
	let norm = 0;
	for (let i = 0; i < octaves; i++) {
		v += amp * smooth(x * freq + i * 17.3, z * freq + i * 9.1);
		norm += amp;
		amp *= 0.5;
		freq *= 2;
	}
	return v / norm;
}

export const COLORS = {
	grass: 0x4d8c48,
	grassLight: 0x58a052,
	soil: 0x6a4a32,
	water: 0x2b6cff,
	water2: 0x3a7bff,
	ballast: 0x3a3a3a,
	steel: 0x8f9aa8,
	rock: 0x6b6b6b,
	road: 0x2b2b2b,
	roadLine: 0x8a8a8a,
	stone: 0x9a8f7a,
	paving: 0xb9b09c,
	platform: 0x8a8a8a,
	dark: 0x14161c,
	white: 0xf2f2f2,
	red: 0xff5c4d,
	yellow: 0xffcf33,
	blue: 0x3d7bff,
	green: 0x2fd487,
	pink: 0xff7ab8,
	wood: 0x5a4330,
	lit: 0xffd56b,
};

export const unit = new BoxGeometry(1, 1, 1);
const materials = new Map<number, MeshLambertMaterial>();
export const material = (color: number) => {
	let m = materials.get(color);
	if (!m) materials.set(color, (m = new MeshLambertMaterial({ color })));
	return m;
};
export function box(parent: Group | Scene, w: number, h: number, d: number, color: number, x: number, y: number, z: number) {
	const m = new Mesh(unit, material(color));
	m.scale.set(w, h, d);
	m.position.set(x, y, z);
	parent.add(m);
	return m;
}

/** w, h, d, colour, x, y (middle), z, turn around the vertical axis */
export type Box = [number, number, number, number, number, number, number, number];

export const vertexMaterial = new MeshLambertMaterial({ vertexColors: true });
/** lit windows and street lamps: drawn only at night */
export const lightMaterial = new MeshBasicMaterial({ vertexColors: true });
/** windows of the trains, lamp heads, signal heads: they glow at night */
export const glass = new MeshLambertMaterial({ color: 0x1c2232, emissive: 0x000000 });
/** headlights and lamp heads */
export const glow = new MeshLambertMaterial({ color: 0xffcf33, emissive: 0x000000 });
const tmpColor = new Color();
/** thousands of boxes become one mesh with a colour per vertex: one draw call for a whole chunk of city */
export function meshFromBoxes(list: Box[], mat: MeshLambertMaterial | MeshBasicMaterial = vertexMaterial) {
	const n = list.length;
	const pos = new Float32Array(n * 72);
	const nor = new Float32Array(n * 72);
	const col = new Float32Array(n * 72);
	const idx = new Uint32Array(n * 36);
	const up = unit.getAttribute("position").array;
	const un = unit.getAttribute("normal").array;
	const ui = unit.index!.array;
	for (let i = 0; i < n; i++) {
		const [w, h, d, color, px, py, pz, ry] = list[i];
		const c = Math.cos(ry);
		const s = Math.sin(ry);
		tmpColor.setHex(color);
		for (let v = 0; v < 24; v++) {
			const x = up[v * 3] * w;
			const y = up[v * 3 + 1] * h;
			const z = up[v * 3 + 2] * d;
			const o = i * 72 + v * 3;
			pos[o] = x * c + z * s + px;
			pos[o + 1] = y + py;
			pos[o + 2] = -x * s + z * c + pz;
			const nx = un[v * 3];
			const nz = un[v * 3 + 2];
			nor[o] = nx * c + nz * s;
			nor[o + 1] = un[v * 3 + 1];
			nor[o + 2] = -nx * s + nz * c;
			col[o] = tmpColor.r;
			col[o + 1] = tmpColor.g;
			col[o + 2] = tmpColor.b;
		}
		for (let k = 0; k < 36; k++) idx[i * 36 + k] = ui[k] + i * 24;
	}
	const geo = new BufferGeometry();
	geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
	geo.setAttribute("normal", new Float32BufferAttribute(nor, 3));
	geo.setAttribute("color", new Float32BufferAttribute(col, 3));
	geo.setIndex(new Uint32BufferAttribute(idx, 1));
	geo.computeBoundingSphere();
	return new Mesh(geo, mat);
}

export type Pt = [number, number];

/**
 * Centripetal Catmull-Rom through the points, sampled about every `step` units. `at[k]` is the sample where control
 * point k sits. A closed spline does not repeat its first sample at the end.
 */
export function spline(points: Pt[], closed: boolean, step = 1) {
	const n = points.length;
	const get = (i: number): Pt => {
		if (closed) return points[mod(i, n)];
		if (i < 0) return [2 * points[0][0] - points[1][0], 2 * points[0][1] - points[1][1]];
		if (i >= n) return [2 * points[n - 1][0] - points[n - 2][0], 2 * points[n - 1][1] - points[n - 2][1]];
		return points[i];
	};
	const out: Pt[] = [];
	const at: number[] = [];
	const segments = closed ? n : n - 1;
	for (let i = 0; i < segments; i++) {
		const p0 = get(i - 1);
		const p1 = get(i);
		const p2 = get(i + 1);
		const p3 = get(i + 2);
		const t0 = 0;
		const t1 = t0 + Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) ** 0.5;
		const t2 = t1 + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) ** 0.5;
		const t3 = t2 + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]) ** 0.5;
		const count = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
		at.push(out.length);
		for (let k = 0; k < count; k++) {
			const t = t1 + ((t2 - t1) * k) / count;
			const mix = (a: Pt, b: Pt, ta: number, tb: number): Pt => {
				const u = (t - ta) / (tb - ta);
				return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
			};
			const a1 = mix(p0, p1, t0, t1);
			const a2 = mix(p1, p2, t1, t2);
			const a3 = mix(p2, p3, t2, t3);
			const b1 = mix(a1, a2, t0, t2);
			const b2 = mix(a2, a3, t1, t3);
			out.push(mix(b1, b2, t1, t2));
		}
	}
	if (!closed) {
		at.push(out.length);
		out.push(points[n - 1]);
	}
	return { pts: out, at };
}
