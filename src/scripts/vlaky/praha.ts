// Prague: the land is the real one. The river, the streets, the parks, the hills and some 26,000 houses come from
// OpenStreetMap and elevation tiles, baked by scripts/praha/bake.py into public/vlaky/praha.dat; the railway is our own.
// Data: (c) OpenStreetMap contributors (ODbL). Terrain: terrain tiles built from public elevation data.
import type { Layout } from "./rails";
import { CHARLES, LANDMARKS } from "./praha-landmarks";
import { type Box, clamp, COLORS, hash2, lightMaterial, meshFromBoxes } from "./util";
import type { Chunk, World } from "./world";

const CH = 32;
const STEP = 0.8; // a step of the terrain is 8 m and 0.8 units high

/** the railway of Prague: the same edges as on the fictional island, laid along the river */
export const PRAHA_LAYOUT: Layout = {
	ring: [
		[-112, -18], [-104, -62], [-66, -92], [-8, -92], [72, -86], [118, -78], [170, -46],
		[186, 8], [166, 54], [118, 74], [52, 66], [-42, 66], [-84, 58], [-104, 26],
	],
	inner: [[-66, -14], [-58, -50], [-22, -66], [56, -50], [100, -30], [110, 12], [84, 40], [46, 30], [-42, 36], [-68, 14]],
	connectors: [
		["c1", "R", 2, "I", 2, [-50, -88], [-36, -76]],
		["c2", "I", 3, "R", 5, [74, -58], [96, -70]],
		["c3", "R", 9, "I", 7, [88, 58], [64, 42]],
		["c4", "I", 8, "R", 12, [-56, 42], [-70, 50]],
	],
	stations: [
		["HLAVNI", "r4", 0.5, 1, true],
		["MUZEUM", "r7", 0.5, 1, false],
		["MUSTEK", "r8", 0.5, 1, false],
		["NARODNI", "r9", 0.5, 1, true],
		["UJEZD", "r12", 0.5, 1, false],
		["PODHRADI", "r0", 0.5, 1, false],
		["KAMPA", "i1", 0.5, 1, true],
		["PAVLOVA", "i5", 0.5, 1, false],
		["ZOFIN", "i6", 0.5, 1, false],
		["LORETA", "i9", 0.5, 1, false],
	],
	tunnels: [
		["r1", 9, 27],
		["r13", 14, 34],
	],
};

const WALLS = [0xe8dcc0, 0xd9b36a, 0xe0a38a, 0xa9c4d9, 0xb7cfa0, 0xf0ebe0, 0xd8c7a3, 0xc9a98c, 0xe8dcc0, 0xf0ebe0];
const ROOFS = [0xb5482f, 0xa03e2a, 0xc4623a, 0xb5482f, 0xa03e2a, 0xc4623a, 0xb5482f, 0x8a3a2a, 0x5b3a2e, 0x4a5560];
const LEAVES = [0x2f8f4a, 0x3fae5c, 0x4fbf6a];
const EARTH = [0xb7aa8c, 0xaea283];
const CHARLES_LEN = Math.hypot(CHARLES.to[0] - CHARLES.from[0], CHARLES.to[1] - CHARLES.from[1]);

const shade = (color: number, f: number) => (Math.round(((color >> 16) & 255) * f) << 16) | (Math.round(((color >> 8) & 255) * f) << 8) | Math.round((color & 255) * f);

interface Data {
	gw: number;
	gh: number;
	cells: Uint8Array;
	steps: Uint8Array;
	houses: Int16Array; // x, z, w, d, angle, metres, kind
	byChunk: Map<number, number[]>;
}

export async function loadPraha(url: string): Promise<World> {
	const res = await fetch(url);
	if (!res.ok || !res.body) throw new Error("praha.dat missing");
	const buf = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
	return makePraha(buf);
}

function makePraha(buf: ArrayBuffer): World {
	const dv = new DataView(buf);
	const gw = dv.getUint16(0, true);
	const gh = dv.getUint16(2, true);
	const isleX = gw / 2;
	const isleZ = gh / 2;
	const cells = new Uint8Array(buf, 4, gw * gh).slice();
	const steps = new Uint8Array(buf, 4 + gw * gh, (gw / 2) * (gh / 2));
	const at = 4 + gw * gh + (gw / 2) * (gh / 2);
	const count = dv.getUint32(at, true);
	const houses = new Int16Array(count * 7);
	const byChunk = new Map<number, number[]>();
	for (let i = 0; i < count; i++) {
		const o = at + 4 + i * 10;
		const x = dv.getInt16(o, true) / 4;
		const z = dv.getInt16(o + 2, true) / 4;
		houses.set([dv.getInt16(o, true), dv.getInt16(o + 2, true), dv.getUint8(o + 4), dv.getUint8(o + 5), dv.getUint8(o + 6), dv.getUint8(o + 7), dv.getUint8(o + 8)], i * 7);
		const key = Math.floor(x / CH) * 1000 + Math.floor(z / CH);
		const list = byChunk.get(key);
		if (list) list.push(i);
		else byChunk.set(key, [i]);
	}
	const data: Data = { gw, gh, cells, steps, houses, byChunk };

	const cellAt = (x: number, z: number) => {
		const ix = Math.floor(x) + isleX;
		const iz = Math.floor(z) + isleZ;
		return ix >= 0 && iz >= 0 && ix < gw && iz < gh ? data.cells[iz * gw + ix] : 0;
	};
	const isWater = (x: number, z: number) => (cellAt(x, z) & 1) === 1;
	const roadAt = (x: number, z: number) => ((cellAt(x, z) >> 1) & 3) > 0;
	const stepAt = (x: number, z: number) => {
		const ix = Math.floor(x + isleX) >> 1;
		const iz = Math.floor(z + isleZ) >> 1;
		return ix >= 0 && iz >= 0 && ix < gw / 2 && iz < gh / 2 ? data.steps[iz * (gw / 2) + ix] : 0;
	};
	const hillHeight = (x: number, z: number) => stepAt(x, z) * STEP;

	function initWater(carves: [number, number, number][]) {
		for (const [cx, cz, r] of carves) {
			for (let iz = Math.floor(cz - r); iz <= Math.ceil(cz + r); iz++) {
				for (let ix = Math.floor(cx - r); ix <= Math.ceil(cx + r); ix++) {
					const gx = ix + isleX;
					const gz = iz + isleZ;
					if (gx < 0 || gz < 0 || gx >= gw || gz >= gh) continue;
					if (Math.hypot(ix + 0.5 - cx, iz + 0.5 - cz) <= r) data.cells[gz * gw + gx] &= ~1;
				}
			}
		}
	}

	function createChunkBuilder(railDist: (x: number, z: number) => number, roadOK: (x: number, z: number) => boolean) {
		/** the terrain in columns of 2 x 2, flattened where the railway runs */
		const columnH = (x: number, z: number) => {
			const mx = Math.floor(x / 2) * 2 + 1;
			const mz = Math.floor(z / 2) * 2 + 1;
			const s = stepAt(mx, mz);
			if (s === 0) return 0;
			const f = clamp((railDist(mx, mz) - 6) / 7, 0, 1);
			return Math.floor(s * f + 1e-6) * STEP;
		};

		return function build(cx: number, cz: number): Chunk {
			const x0 = cx * CH;
			const z0 = cz * CH;
			const list: Box[] = [];
			const lamps: Box[] = [];
			const add = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry = 0) => list.push([w, h, d, color, x, y, z, ry]);
			const lamp = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry = 0) => lamps.push([w, h, d, color, x, y, z, ry]);

			// --- the ground, row by row, in runs of equal cells
			type Kind = 1 | 2 | 3 | 4 | 5 | 6 | 7;
			for (let iz = 0; iz < CH; iz++) {
				let runKind = 0;
				let runH = 0;
				let runStart = 0;
				const flush = (end: number) => {
					if (!runKind) return;
					const len = end - runStart;
					const cxr = x0 + runStart + len / 2;
					const z = z0 + iz + 0.5;
					switch (runKind as Kind) {
						case 1:
							add(len, 0.05, 1, COLORS.water, cxr, 0.015, z);
							break;
						case 2:
							add(len, 0.03, 1, 0x6fae5e, cxr, runH + 0.015, z);
							break;
						case 3:
							add(len, 0.03, 1, 0x3c7a45, cxr, runH + 0.015, z);
							break;
						case 4:
							add(len, 0.05, 1, 0x2b2b2b, cxr, runH + 0.035, z);
							break;
						case 5:
							add(len, 0.06, 1, 0x2b2b2b, cxr, runH + 0.04, z);
							break;
						case 6: // a bridge
							add(len, 0.3, 1, COLORS.stone, cxr, 0.25, z);
							break;
						case 7:
							add(len, 0.06, 1, 0x1f1f1f, cxr, runH + 0.04, z);
							break;
					}
				};
				for (let ix = 0; ix <= CH; ix++) {
					let kind = 0;
					let h = 0;
					if (ix < CH) {
						const x = x0 + ix + 0.5;
						const z = z0 + iz + 0.5;
						const c = cellAt(x, z);
						h = columnH(x, z);
						const road = (c >> 1) & 3;
						if (road && c & 1) kind = 6;
						else if (c & 1) kind = 1;
						else if (road && roadOK(x, z)) kind = road === 1 ? 4 : road === 2 ? 5 : 7;
						else if (!road && ((c >> 4) & 3) === 1 && h === 0) kind = 2;
						else if (!road && ((c >> 4) & 3) === 2 && h === 0) kind = 3;
						if (kind === 4 || kind === 5 || kind === 7) {
							if (hash2(Math.floor(x), Math.floor(z)) % 29 === 0 && railDist(x, z) > 2.5) {
								add(0.1, 1.3, 0.1, COLORS.dark, x + 0.4, h + 0.65, z + 0.4);
								lamp(0.26, 0.26, 0.26, COLORS.lit, x + 0.4, h + 1.4, z + 0.4);
							}
						}
					}
					if (kind !== runKind || h !== runH) {
						flush(ix);
						runKind = kind;
						runH = h;
						runStart = ix;
					}
				}
			}
			// the piers of the bridges
			for (let iz = 0; iz < CH; iz += 2) {
				for (let ix = 0; ix < CH; ix += 2) {
					const x = x0 + ix + 0.5;
					const z = z0 + iz + 0.5;
					const c = cellAt(x, z);
					if (c & 8 && c & 1 && hash2(Math.floor(x / 2), Math.floor(z / 2)) % 2 === 0) add(0.9, 0.5, 0.9, 0x7d7463, x, 0, z);
				}
			}

			// --- hills: columns of 2 x 2
			const conifer = (x: number, z: number, y: number) => {
				add(0.2, 0.4, 0.2, COLORS.wood, x, y + 0.2, z);
				add(1.1, 0.55, 1.1, 0x1f5a34, x, y + 0.65, z);
				add(0.8, 0.5, 0.8, 0x24683c, x, y + 1.15, z);
				add(0.45, 0.45, 0.45, 0x2a7545, x, y + 1.6, z);
			};
			const tree = (x: number, z: number, y: number, k: number) => {
				add(0.16, 0.45, 0.16, COLORS.wood, x, y + 0.22, z);
				add(0.75, 0.75, 0.75, LEAVES[k % 3], x, y + 0.8, z);
				if (k % 2) add(0.5, 0.5, 0.5, LEAVES[(k >>> 2) % 3], x, y + 1.35, z);
			};
			for (let iz = 0; iz < CH; iz += 2) {
				for (let ix = 0; ix < CH; ix += 2) {
					const x = x0 + ix + 1;
					const z = z0 + iz + 1;
					if (Math.abs(x) > isleX - 1 || Math.abs(z) > isleZ - 1) continue;
					const h = columnH(x, z);
					if (h < STEP) continue;
					const g = (cellAt(x - 0.5, z - 0.5) >> 4) & 3;
					const k = hash2(Math.floor(x), Math.floor(z));
					const color = g === 2 ? (k % 3 ? 0x2f6b3c : 0x3a7a44) : g === 1 ? (k % 3 ? 0x5a9a58 : 0x6fae5e) : h > 6 ? 0x9a8d74 : EARTH[k % 2];
					// contour bands, so that the eye can read the slope
					const band = [1, 0.94, 0.88][Math.round(h / STEP) % 3];
					add(2, h, 2, shade(color, band), x, h / 2, z);
				}
			}

			// --- trees: parks and woods
			for (let iz = 0; iz < CH; iz++) {
				for (let ix = 0; ix < CH; ix++) {
					const x = x0 + ix + 0.5;
					const z = z0 + iz + 0.5;
					const c = cellAt(x, z);
					const g = (c >> 4) & 3;
					if (!g || c & 14) continue;
					const k = hash2(Math.floor(x) * 7 + 3, Math.floor(z) * 13 + 1);
					const h = columnH(x, z);
					if (g === 2 && k % 3 === 0) {
						if (k % 5 < 2) conifer(x + (k % 7) / 14 - 0.25, z + (k % 11) / 22 - 0.25, h);
						else tree(x, z, h, k >>> 4);
					} else if (g === 1 && k % 8 === 0) tree(x, z, h, k >>> 4);
				}
			}

			// --- the sights
			const landmarks = LANDMARKS.filter((l) => Math.floor(l.x / CH) === cx && Math.floor(l.z / CH) === cz);
			for (const l of landmarks) {
				const c = Math.cos(l.rot);
				const s = Math.sin(l.rot);
				const y = stepAt(l.x, l.z) * STEP;
				const place = (out: Box[]) => (w: number, h: number, d: number, color: number, lx: number, ly: number, lz: number, ry = 0) =>
					out.push([w, h, d, color, l.x + lx * c + lz * s, ly, l.z - lx * s + lz * c, l.rot + ry]);
				l.build(place(list), place(lamps), y);
			}
			if (Math.floor((CHARLES.from[0] + CHARLES.to[0]) / 2 / CH) === cx && Math.floor((CHARLES.from[1] + CHARLES.to[1]) / 2 / CH) === cz) charlesBridge(add, lamp);

			// --- the houses
			const farFromSights = (x: number, z: number) => {
				for (const l of LANDMARKS) if (Math.hypot(x - l.x, z - l.z) < l.clear) return false;
				return true;
			};
			for (const i of data.byChunk.get(cx * 1000 + cz) ?? []) {
				const o = i * 7;
				const x = data.houses[o] / 4;
				const z = data.houses[o + 1] / 4;
				const w = Math.max(0.9, data.houses[o + 2] / 8);
				const d = Math.max(0.9, data.houses[o + 3] / 8);
				const ang = (data.houses[o + 4] / 256) * Math.PI;
				const metres = data.houses[o + 5];
				const kind = data.houses[o + 6];
				if (!farFromSights(x, z)) continue;
				const ca = Math.cos(ang);
				const sa = Math.sin(ang);
				let gmax = 0;
				let gmin = Infinity;
				let ok = true;
				for (const [lx, lz] of [[0, 0], [w / 2, d / 2], [-w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]]) {
					const px = x + lx * ca - lz * sa;
					const pz = z + lx * sa + lz * ca;
					if (isWater(px, pz) || railDist(px, pz) < (lx || lz ? 2.4 : 3)) {
						ok = false;
						break;
					}
					const g = columnH(px, pz);
					gmax = Math.max(gmax, g);
					gmin = Math.min(gmin, g);
				}
				if (!ok || gmax - gmin > 2.5) continue;
				const k = hash2(Math.round(x * 4), Math.round(z * 4));
				const wall = WALLS[k % WALLS.length];
				const roof = ROOFS[(k >>> 5) % ROOFS.length];
				const ry = -ang;
				const place = (lx: number, lz: number): [number, number] => [x + lx * ca - lz * sa, z + lx * sa + lz * ca];
				let h = clamp(metres / 5.2, 1, 11);
				if (kind & 1) h = Math.max(h, 2.6);
				if (gmax > gmin + 0.05) add(w, gmax - gmin, d, wall, x, (gmax + gmin) / 2, z, ry);
				add(w, h, d, wall, x, gmax + h / 2, z, ry);
				const flat = kind & 2 || h > 7.5;
				if (flat) {
					add(w + 0.1, 0.14, d + 0.1, COLORS.dark, x, gmax + h + 0.07, z, ry);
				} else {
					const rise = d > 3 ? 0.4 : 0.3;
					add(w + 0.12, rise, d + 0.12, roof, x, gmax + h + rise / 2, z, ry);
					add(w + 0.12, rise, d * 0.64, roof, x, gmax + h + rise * 1.5, z, ry);
					add(w + 0.12, rise, d * 0.28, roof, x, gmax + h + rise * 2.5, z, ry);
				}
				if (kind & 1 && w > 1.4) {
					const [tx, tz] = place(w / 2 - 0.6, 0);
					add(1.1, h * 1.7, 1.1, wall, tx, gmax + (h * 1.7) / 2, tz, ry);
					for (let t = 0; t < 4; t++) add(1.2 - t * 0.28, 0.6, 1.2 - t * 0.28, 0x4a5560, tx, gmax + h * 1.7 + 0.3 + t * 0.6, tz, ry);
				}
				// windows on the long sides: dark by day, lit at night
				if (h >= 1.3) {
					const cols = clamp(Math.floor(w / 1.8), 1, 4);
					const rows = clamp(Math.floor((h - 0.4) / 1.1), 1, 3);
					for (let row = 0; row < rows; row++) {
						for (let col = 0; col < cols; col++) {
							for (const side of [1, -1]) {
								const lx = (col - (cols - 1) / 2) * (w / cols);
								const ly = gmax + 0.75 + row * 1.1;
								const [wx, wz] = place(lx, side * (d / 2));
								add(0.22, 0.3, 0.06, 0x3a4a66, wx, ly, wz, ry);
								if (hash2(col * 31 + row, k + side) % 10 < 6) lamp(0.22, 0.3, 0.09, COLORS.lit, wx, ly, wz, ry);
							}
						}
					}
				}
			}

			return { main: meshFromBoxes(list), lights: lamps.length ? meshFromBoxes(lamps, lightMaterial) : null };
		};
	}

	/** Charles Bridge: a stone deck on piers with a parapet, statues and the three towers */
	function charlesBridge(add: (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry?: number) => void, lamp: typeof add) {
		const [x1, z1] = CHARLES.from;
		const [x2, z2] = CHARLES.to;
		const dx = (x2 - x1) / CHARLES_LEN;
		const dz = (z2 - z1) / CHARLES_LEN;
		const ry = -Math.atan2(dz, dx);
		const along = (t: number, lat: number): [number, number] => [x1 + dx * t - dz * lat, z1 + dz * t + dx * lat];
		for (let t = 0.5; t < CHARLES_LEN; t += 1) {
			const [x, z] = along(t, 0);
			add(1.2, 0.3, 1.25, 0x9a8f7a, x, 0.4, z, ry);
			for (const side of [-0.6, 0.6]) {
				const [px, pz] = along(t, side);
				add(0.12, 0.3, 1.25, 0x7d7463, px, 0.7, pz, ry);
			}
			if (Math.floor(t) % 5 === 2) {
				for (const side of [-0.6, 0.6]) {
					const [px, pz] = along(t, side);
					add(0.22, 0.75, 0.22, 0x2a2a2e, px, 1.0, pz);
				}
			}
			if (Math.floor(t) % 4 === 0) {
				const [px, pz] = along(t, 0);
				add(0.9, 0.6, 1.1, 0x7d7463, px, 0.05, pz, ry);
			}
		}
		const tower = (t: number, w: number, h: number, roof: number) => {
			const [x, z] = along(t, 0);
			add(w, h, 2.3, 0xbcb3a0, x, h / 2, z, ry);
			add(w + 0.2, 0.3, 2.5, 0x8a8170, x, h + 0.15, z, ry);
			for (let i = 0; i < 4; i++) add(w * (1 - i * 0.22), 0.6, 2.2 * (1 - i * 0.3), roof, x, h + 0.6 + i * 0.6, z, ry);
			lamp(0.3, 0.5, 0.1, COLORS.lit, x, h * 0.6, z);
		};
		tower(CHARLES_LEN - 1.2, 2.6, 6.4, 0x4a4540); // the Old Town tower
		tower(CHARLES_LEN * 0.27, 2.4, 5.4, 0x6b3f2e); // the Lesser Town towers
		tower(CHARLES_LEN * 0.27 - 4.4, 2.2, 3.8, 0x6b3f2e);
	}

	return {
		isleX,
		isleZ,
		fit: { x: 40, z: -10, hx: 160, hz: 100 },
		layout: PRAHA_LAYOUT,
		ground: 0xb3ab97,
		isWater,
		hillHeight,
		roadAt,
		initWater,
		createChunkBuilder,
	};
}

