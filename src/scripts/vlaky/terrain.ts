// The land: a river with tributaries, lakes, hills, and a town that is built in chunks, only where the camera looks.
// Everything is a pure function of the coordinates, so a chunk comes out the same whenever it is (re)built.
import type { Chunk, World } from "./world";
import { type Box, clamp, COLORS, fbm, hash2, lightMaterial, meshFromBoxes, type Pt, rng, smooth, spline } from "./util";

export const ISLE_X = 640; // half the size of the island
export const ISLE_Z = 400;
export const CH = 32; // a chunk is CH x CH

// ---------------------------------------------------------------------------------------------
// water: a raster with one cell per unit, because bridges, roads and buildings all need to ask "is this wet?"

const GW = ISLE_X * 2;
const GH = ISLE_Z * 2;
const water = new Uint8Array(GW * GH);

export const isWater = (x: number, z: number) => {
	const ix = Math.floor(x) + ISLE_X;
	const iz = Math.floor(z) + ISLE_Z;
	return ix >= 0 && iz >= 0 && ix < GW && iz < GH && water[iz * GW + ix] === 1;
};

function stamp(x: number, z: number, r: number, value = 1) {
	for (let iz = Math.floor(z - r); iz <= Math.ceil(z + r); iz++) {
		for (let ix = Math.floor(x - r); ix <= Math.ceil(x + r); ix++) {
			const gx = ix + ISLE_X;
			const gz = iz + ISLE_Z;
			if (gx < 0 || gz < 0 || gx >= GW || gz >= GH) continue;
			if (Math.hypot(ix + 0.5 - x, iz + 0.5 - z) <= r) water[gz * GW + gx] = value;
		}
	}
}

// the main river, north to south; it passes between the stations of the railway
const RIVER: Pt[] = [
	[60, -400], [30, -320], [-30, -250], [-10, -180], [-5, -120], [2, -64], [7, -36], [6, -6], [-2, 14],
	[-13, 31], [-10, 48], [-7, 62], [4, 90], [25, 140], [-5, 200], [-40, 270], [-10, 340], [30, 400],
];
// a brook through the middle of the town, into the river
const BROOK: Pt[] = [[150, -20], [122, -18], [100, -16], [82, -14], [62, -2], [40, 6], [22, -7], [9, -2]];
const LAKES: [number, number, number][] = [
	[170, 85, 34],
	[-210, -50, 48],
	[250, -170, 40],
	[-120, 190, 30],
	[60, 250, 36],
];

export function initWater(carves: [number, number, number][]) {
	water.fill(0);
	const river = spline(RIVER, false, 0.8).pts;
	river.forEach(([x, z], i) => stamp(x, z, 1.7 + 0.8 * smooth(i * 0.035, 5), 1));
	for (const [x, z] of spline(BROOK, false, 0.8).pts) stamp(x, z, 0.9);

	// tributaries: from the river outwards, meandering
	for (let j = 0; j < 16; j++) {
		const start = river[Math.floor((0.04 + 0.058 * j) * river.length)];
		if (Math.abs(start[1]) < 115) continue;
		const sign = j % 2 ? 1 : -1;
		let heading = (sign > 0 ? 0 : Math.PI) + (smooth(j * 3.1, 2) - 0.5) * 1.2;
		const pts: Pt[] = [start];
		const steps = 40 + Math.floor(smooth(j * 1.7, 9) * 70);
		for (let k = 0; k < steps; k++) {
			heading += (smooth(k * 0.11 + j * 31, j * 5) - 0.5) * 0.9;
			const [px, pz] = pts[pts.length - 1];
			pts.push([px + Math.cos(heading) * 3.2, pz + Math.sin(heading) * 3.2]);
		}
		for (const [x, z] of spline(pts, false, 0.8).pts) stamp(x, z, 0.85);
	}

	// lakes with a ragged shore, each with a stream running into it
	LAKES.forEach(([cx, cz, r], n) => {
		for (let iz = Math.floor(cz - r * 1.4); iz <= Math.ceil(cz + r * 1.4); iz++) {
			for (let ix = Math.floor(cx - r * 1.4); ix <= Math.ceil(cx + r * 1.4); ix++) {
				const a = Math.atan2(iz - cz, ix - cx);
				const rr = r * (0.7 + 0.6 * smooth(cx * 0.01 + Math.cos(a) * 1.6 + 50, cz * 0.01 + Math.sin(a) * 1.6 + 50));
				const gx = ix + ISLE_X;
				const gz = iz + ISLE_Z;
				if (gx >= 0 && gz >= 0 && gx < GW && gz < GH && Math.hypot(ix - cx, iz - cz) < rr) water[gz * GW + gx] = 1;
			}
		}
		let heading = smooth(n * 4.4, 1) * Math.PI * 2;
		const pts: Pt[] = [[cx + Math.cos(heading) * r * 0.8, cz + Math.sin(heading) * r * 0.8]];
		for (let k = 0; k < 50; k++) {
			heading += (smooth(k * 0.1 + n * 17, 4) - 0.5) * 0.8;
			const [px, pz] = pts[pts.length - 1];
			pts.push([px + Math.cos(heading) * 3.2, pz + Math.sin(heading) * 3.2]);
		}
		for (const [x, z] of spline(pts, false, 0.8).pts) stamp(x, z, 0.85);
	});

	for (const [x, z, r] of carves) stamp(x, z, r, 0); // dry land under the stations and switches
}

// ---------------------------------------------------------------------------------------------
// hills, streets

// a few hills close to the railway, so that there is one to look at from the first view
const BUMPS: [number, number, number, number][] = [
	[-150, -96, 58, 9],
	[152, -108, 52, 8],
	[-30, 122, 46, 7],
	[205, -5, 52, 9],
	[-178, 48, 50, 8],
	[88, 116, 40, 6],
	[-70, -130, 40, 7],
];

export function hillHeight(x: number, z: number) {
	let h = (fbm(x / 150 + 11, z / 150 + 23, 3) - 0.57) * 42;
	for (const [bx, bz, r, top] of BUMPS) {
		const reach = r * (0.75 + 0.5 * smooth(x / 28 + bx, z / 28 + bz));
		const d = Math.hypot(x - bx, z - bz);
		if (d < reach) h = Math.max(h, top * (1 - d / reach) * 1.1);
	}
	return h <= 0 ? 0 : Math.min(9.6, h);
}

/** the direction the streets run in; it turns slowly from district to district */
export const roadAngle = (x: number, z: number) => 0.35 + 1.1 * smooth(x / 260 + 3, z / 260 + 8);

const isPark = (x: number, z: number) => smooth(x / 60 + 40, z / 60 + 10) > 0.86;

/** a distorted grid of streets: blocks of varying size, wider avenues now and then */
export function roadAt(x: number, z: number) {
	if (isPark(x, z)) return false;
	const th = roadAngle(x, z);
	const c = Math.cos(th);
	const s = Math.sin(th);
	const u = x * c + z * s + 10 * (smooth(x / 48 + 1, z / 48 + 5) - 0.5) * 2;
	const v = -x * s + z * c + 10 * (smooth(x / 52 + 9, z / 52 + 2) - 0.5) * 2;
	const pu = 26 + 10 * smooth(x / 300 + 5, z / 300);
	const pv = 32 + 10 * smooth(x / 280 + 15, z / 280 + 4);
	const fu = u / pu;
	const fv = v / pv;
	const du = Math.min(fu - Math.floor(fu), Math.ceil(fu) - fu) * pu;
	const dv = Math.min(fv - Math.floor(fv), Math.ceil(fv) - fv) * pv;
	return du < (Math.round(fu) % 4 === 0 ? 1.25 : 0.75) || dv < (Math.round(fv) % 4 === 0 ? 1.25 : 0.75);
}

// ---------------------------------------------------------------------------------------------
// chunks

const WALLS = [0xe8dcc0, 0xd9b36a, 0xe0a38a, 0xa9c4d9, 0xb7cfa0, 0xf0ebe0, 0xd8c7a3, 0xc9a98c];
const ROOFS = [0xb5482f, 0xa03e2a, 0x5b3a2e, 0x4a5560, 0xc4623a];
const HILL_TOPS = [0x3f7a42, 0x4a8a4c, 0x55964f];
const LEAVES = [0x2f8f4a, 0x3fae5c, 0x4fbf6a];

export type { Chunk };

export function createChunkBuilder(railDist: (x: number, z: number) => number, roadOK: (x: number, z: number) => boolean) {
	const hillAt = (x: number, z: number) => {
		const d = railDist(x, z);
		if (d < 7) return 0;
		return hillHeight(x, z) * clamp((d - 7) / 6, 0, 1);
	};
	const onHill = (x: number, z: number) => hillAt(x, z) >= 0.8;

	return function build(cx: number, cz: number): Chunk {
		const x0 = cx * CH;
		const z0 = cz * CH;
		const list: Box[] = [];
		const lamps: Box[] = [];
		const add = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry = 0) => list.push([w, h, d, color, x, y, z, ry]);
		const r = rng(hash2(cx * 31 + 7, cz * 17 + 3));

		for (let i = 0; i < 4; i++) add(1 + r() * 3, 0.02, 1 + r() * 3, COLORS.grassLight, x0 + r() * CH, 0.005 + i * 0.0001, z0 + r() * CH);

		// --- a town square with a church, now and then
		let hub: { x: number; z: number } | null = null;
		if (r() < 0.3) {
			const hx = x0 + 9 + r() * (CH - 18);
			const hz = z0 + 9 + r() * (CH - 18);
			let ok = !isWater(hx, hz) && !onHill(hx, hz) && railDist(hx, hz) > 8;
			for (let k = 0; ok && k < 8; k++) {
				const px = hx + Math.cos((k * Math.PI) / 4) * 7;
				const pz = hz + Math.sin((k * Math.PI) / 4) * 7;
				ok = !isWater(px, pz) && !onHill(px, pz) && railDist(px, pz) > 6;
			}
			if (ok) {
				hub = { x: hx, z: hz };
				for (let iz = -6; iz <= 6; iz++) {
					for (let ix = -6; ix <= 6; ix++) if (Math.hypot(ix, iz) <= 5.6) add(1, 0.06, 1, COLORS.paving, Math.round(hx) + ix + 0.5, 0.03, Math.round(hz) + iz + 0.5);
				}
				// church: nave, red roof, tower with a spire
				const nx = hx;
				const nz = hz - 3.4;
				add(3.4, 3.2, 5.6, 0xe8dcc0, nx, 1.6, nz);
				add(3.7, 0.4, 5.9, ROOFS[0], nx, 3.4, nz);
				add(2.4, 0.4, 5.9, ROOFS[0], nx, 3.8, nz);
				add(1.0, 0.4, 5.9, ROOFS[0], nx, 4.2, nz);
				add(1.7, 7.2, 1.7, 0xe8dcc0, nx, 3.6, nz + 3.6);
				for (let t = 0; t < 4; t++) add(1.9 - t * 0.45, 0.6, 1.9 - t * 0.45, 0x4a5560, nx, 7.5 + t * 0.6, nz + 3.6);
				add(0.12, 0.8, 0.12, COLORS.yellow, nx, 10.3, nz + 3.6);
				lamps.push([0.3, 0.45, 0.1, COLORS.lit, nx, 6.2, nz + 4.47, 0]);
				// fountain
				add(1.8, 0.35, 1.8, COLORS.rock, hx, 0.2, hz + 1.4);
				add(1.3, 0.1, 1.3, COLORS.water, hx, 0.4, hz + 1.4);
				add(0.3, 0.9, 0.3, COLORS.rock, hx, 0.65, hz + 1.4);
			}
		}
		const inHub = (x: number, z: number) => hub !== null && Math.hypot(x - hub.x, z - hub.z) < 6.6;

		// --- ground, one unit at a time: water, streets, bridges, street lamps
		for (let iz = 0; iz < CH; iz++) {
			for (let ix = 0; ix < CH; ix++) {
				const x = x0 + ix + 0.5;
				const z = z0 + iz + 0.5;
				if (Math.abs(x) > ISLE_X || Math.abs(z) > ISLE_Z) continue;
				const wet = isWater(x, z);
				// a road may cross a stream on a bridge, but not go out over the middle of a lake
				const open = wet && isWater(x - 4, z) && isWater(x + 4, z) && isWater(x, z - 4) && isWater(x, z + 4) && isWater(x - 3, z - 3) && isWater(x + 3, z + 3);
				const road = roadAt(x, z) && !onHill(x, z) && !inHub(x, z) && !open && roadOK(x, z);
				if (wet) {
					if (road) add(1, 0.1, 1, COLORS.stone, x, 0.05, z);
					else add(1, 0.05, 1, (ix + iz) % 3 === 0 ? COLORS.water2 : COLORS.water, x, 0.015, z);
				} else if (road) {
					add(1, 0.05, 1, COLORS.road, x, 0.035, z);
					if (hash2(Math.floor(x), Math.floor(z)) % 41 === 0 && railDist(x, z) > 2.5) {
						add(0.1, 1.3, 0.1, COLORS.dark, x + 0.4, 0.65, z + 0.4);
						lamps.push([0.26, 0.26, 0.26, COLORS.lit, x + 0.4, 1.4, z + 0.4, 0]);
					}
				}
			}
		}

		// --- hills, in steps of 0.8 and 2 x 2 units
		const conifer = (x: number, z: number, y: number) => {
			add(0.2, 0.4, 0.2, COLORS.wood, x, y + 0.2, z);
			add(1.1, 0.55, 1.1, 0x1f5a34, x, y + 0.65, z);
			add(0.8, 0.5, 0.8, 0x24683c, x, y + 1.15, z);
			add(0.45, 0.45, 0.45, 0x2a7545, x, y + 1.6, z);
		};
		for (let iz = 0; iz < CH; iz += 2) {
			for (let ix = 0; ix < CH; ix += 2) {
				const x = x0 + ix + 1;
				const z = z0 + iz + 1;
				if (Math.abs(x) > ISLE_X - 1 || Math.abs(z) > ISLE_Z - 1) continue;
				const h = Math.floor(hillAt(x, z) / 0.8) * 0.8;
				if (h < 0.8) continue;
				if (isWater(x - 0.5, z - 0.5) || isWater(x + 0.5, z - 0.5) || isWater(x - 0.5, z + 0.5) || isWater(x + 0.5, z + 0.5)) continue;
				const k = hash2(Math.floor(x), Math.floor(z));
				const color = h < 1.7 ? HILL_TOPS[k % 3] : h < 3.3 ? 0x4a8a4c : h < 5 ? 0x5a9a58 : h < 7.4 ? COLORS.rock : h < 8.6 ? 0x8a8a8a : 0xe2e2e2;
				add(2, h, 2, color, x, h / 2, z);
				if (h < 5 && k % 100 < 34) conifer(x, z, h);
			}
		}

		// --- houses, trees
		const CELL = 2.4;
		const clear = (x: number, z: number, w: number, d: number, ang: number) => {
			const c = Math.cos(ang);
			const s = Math.sin(ang);
			for (const [lx, lz] of [[0, 0], [w / 2, d / 2], [-w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]]) {
				const px = x + lx * c + lz * s;
				const pz = z - lx * s + lz * c;
				if (isWater(px, pz) || roadAt(px, pz) || onHill(px, pz) || railDist(px, pz) < 2.9 || inHub(px, pz)) return false;
			}
			return true;
		};
		const tree = (x: number, z: number, cr: () => number) => {
			add(0.16, 0.45, 0.16, COLORS.wood, x, 0.22, z);
			add(0.75, 0.75, 0.75, LEAVES[Math.floor(cr() * 3)], x, 0.8, z);
			if (cr() < 0.5) add(0.5, 0.5, 0.5, LEAVES[Math.floor(cr() * 3)], x, 1.35, z);
		};
		for (let ix = Math.ceil(x0 / CELL); ix * CELL < x0 + CH; ix++) {
			for (let iz = Math.ceil(z0 / CELL); iz * CELL < z0 + CH; iz++) {
				const cr = rng(hash2(ix * 7 + 1, iz * 13 + 5));
				const x = ix * CELL + (cr() - 0.5) * 0.7;
				const z = iz * CELL + (cr() - 0.5) * 0.7;
				if (Math.abs(x) > ISLE_X - 1.5 || Math.abs(z) > ISLE_Z - 1.5) continue;
				const p = cr();
				const park = isPark(x, z);
				const town = fbm(x / 110 + 5, z / 110 + 77, 2);
				if (park || p < 0.06) {
					// a grove; parks are full of them
					if (park && p < 0.55) {
						if (clear(x, z, 0.8, 0.8, 0)) tree(x, z, cr);
					} else if (!park && clear(x, z, 0.8, 0.8, 0)) {
						tree(x, z, cr);
					}
					continue;
				}
				if (p > (town > 0.46 ? 0.94 : 0.72)) continue;
				const ang = roadAngle(x, z) + (cr() < 0.5 ? 0 : Math.PI / 2);
				const w = 1.2 + cr() * 0.9;
				const d = 1.2 + cr() * 1.0;
				if (!clear(x, z, w + 0.3, d + 0.3, ang)) continue;
				const urban = town > 0.46;
				const h = 1 + cr() * cr() * (urban ? 3.6 : 1.4) + (urban ? (town - 0.46) * 5 : 0);
				const wall = WALLS[Math.floor(cr() * WALLS.length)];
				const roof = ROOFS[Math.floor(cr() * ROOFS.length)];
				add(w, h, d, wall, x, h / 2, z, ang);
				const c = Math.cos(ang);
				const s = Math.sin(ang);
				if (h > 3.4) {
					add(w + 0.1, 0.14, d + 0.1, COLORS.dark, x, h + 0.07, z, ang);
				} else {
					// the roof, in steps
					add(w + 0.12, 0.3, d + 0.12, roof, x, h + 0.15, z, ang);
					add(w * 0.64, 0.3, d + 0.12, roof, x, h + 0.45, z, ang);
					add(w * 0.28, 0.3, d + 0.12, roof, x, h + 0.75, z, ang);
					if (cr() < 0.5) add(0.22, 0.5, 0.22, 0x6b4a3a, x + (0.3 * w * c), h + 0.85, z - 0.3 * w * s, ang);
				}
				// windows: dark by day, lit at night
				const rows = Math.max(1, Math.floor((h - 0.4) / 0.9));
				for (let row = 0; row < rows; row++) {
					for (const lx of [-w * 0.25, w * 0.25]) {
						for (const side of [1, -1]) {
							const ly = 0.75 + row * 0.9;
							if (ly > h - 0.3) continue;
							const lz = side * (d / 2);
							const wx = x + lx * c + lz * s;
							const wz = z - lx * s + lz * c;
							add(0.22, 0.3, 0.06, 0x3a4a66, wx, ly, wz, ang);
							if (cr() < 0.6) lamps.push([0.22, 0.3, 0.09, COLORS.lit, wx, ly, wz, ang]);
						}
					}
				}
			}
		}

		return { main: meshFromBoxes(list), lights: lamps.length ? meshFromBoxes(lamps, lightMaterial) : null };
	};
}

export const fictionWorld: World = { isleX: ISLE_X, isleZ: ISLE_Z, fit: { x: 0, z: 0, hx: 80, hz: 48 }, isWater, hillHeight, roadAt, initWater, createChunkBuilder };
