// Prague: the land is the real one. The river, the streets, the parks, the hills and some 230,000 houses come from
// OpenStreetMap and the terrain model of ČÚZK, baked by scripts/praha/bake.py into public/vlaky/praha.dat. The trains,
// the trams, the city buses and the metro (where it is out in the open) run on their real routes by the PID timetable
// (praha-trams.ts); the cars are made up (praha-traffic.ts), and so are the white and red trucks of Siegl round their
// yard in Kyje (praha-siegl.ts).
// Data: (c) OpenStreetMap contributors (ODbL). Terrain: DMR 4G (c) ČÚZK. Timetables: PID (CC BY 4.0).
import type { Scene } from "three";
import { type Bridges, makeBridges } from "./praha-bridges";
import { CHARLES, LANDMARKS, project } from "./praha-landmarks";
import { parseRoads, type RoadNet, roadBoxes } from "./praha-roads";
import { ACCIDENT, createAccident } from "./praha-accident";
import { createRapper, RAPPER } from "./praha-rapper";
import { createYard } from "./praha-siegl";
import { createTraffic } from "./praha-traffic";
import { BUS, createTrams, lineBoxes, METRO, nearTrack, parseTrams, railProfile, TRAIN, TRAM, type TramData } from "./praha-trams";
import { type Box, clamp, COLORS, hash2, lightMaterial, meshFromBoxes } from "./util";
import type { Chunk, Extras, World } from "./world";

const CH = 32;
/** a flat roof: tar, concrete, gravel */
const FLAT_ROOFS = [0x6e737a, 0x7d8189, 0x8b8f95];
const STEP = 1.5 / 6; // the terrain comes in metres; a unit is 6 m across, the hills raised half again to be seen

const WALLS = [0xe8dcc0, 0xd9b36a, 0xe0a38a, 0xa9c4d9, 0xb7cfa0, 0xf0ebe0, 0xd8c7a3, 0xc9a98c, 0xe8dcc0, 0xf0ebe0];
const ROOFS = [0xb5482f, 0xa03e2a, 0xc4623a, 0xb5482f, 0xa03e2a, 0xc4623a, 0xb5482f, 0x8a3a2a, 0x5b3a2e, 0x4a5560];
const LEAVES = [0x2f8f4a, 0x3fae5c, 0x4fbf6a];
const EARTH = [0xb7aa8c, 0xaea283];
const CHARLES_LEN = Math.hypot(CHARLES.to[0] - CHARLES.from[0], CHARLES.to[1] - CHARLES.from[1]);

/** within `r` units (6 by default) of Charles Bridge, which is stone */
const nearCharles = (x: number, z: number, r = 6) => {
	const [x1, z1] = CHARLES.from;
	const dx = CHARLES.to[0] - x1;
	const dz = CHARLES.to[1] - z1;
	const t = Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / (dx * dx + dz * dz)));
	return Math.hypot(x1 + dx * t - x, z1 + dz * t - z) < r;
};

/** how tall the walls of a house stand, in units, from its height in metres and its kind */
const wallHeight = (metres: number, kind: number) => {
	const h = clamp(metres / 5.2, 1, 11);
	return kind & 1 ? Math.max(h, 2.6) : h;
};
/** a flat roof is a slab; a pitched one has three steps of this height (a bigger house rises more) */
const roofRise = (depth: number) => (depth > 3 ? 0.4 : 0.3);
const FLAT_SLAB = 0.14;

const shade = (color: number, f: number) => (Math.round(((color >> 16) & 255) * f) << 16) | (Math.round(((color >> 8) & 255) * f) << 8) | Math.round((color & 255) * f);

interface Data {
gw: number;
gh: number;
x0: number; // where the first cell is in the world
z0: number;
	cells: Uint8Array;
	steps: Uint8Array;
	houses: Int16Array; // x, z, w, d, angle, metres, kind
	byChunk: Map<number, number[]>;
}

const gunzip = async (url: string) => {
	const res = await fetch(url);
	if (!res.ok || !res.body) throw new Error(`${url} missing`);
	return new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
};

export async function loadPraha(url: string): Promise<World> {
	// the streets as lines, the trams and the trains are a bonus: without the lines the raster draws the streets
	const [buf, roads, ...lines] = await Promise.all([
		gunzip(url),
		gunzip(url.replace(/\.dat$/, "-roads.dat")).catch(() => null),
		...["tram", "rail", "bus", "metro"].map((k) => gunzip(url.replace(/\.dat$/, `-${k}.dat`)).catch(() => null)),
	]);
	const [trams, trains, buses, metro] = lines.map((b) => (b ? parseTrams(b) : null));
	return makePraha(buf, roads ? parseRoads(roads) : null, trams, trains, buses, metro);
}

function makePraha(buf: ArrayBuffer, roads: RoadNet | null, trams: TramData | null, trains: TramData | null, buses: TramData | null, metro: TramData | null): World {
	const dv = new DataView(buf);
	// a map of the whole city says where its grid lies (and starts with 0); the older one is centred on (0, 0)
	// version 1: the terrain comes as the difference from the row above (it packs smaller)
	const version = dv.getUint16(0, true);
	const placed = version <= 1;
	const o = placed ? 2 : 0;
	const gw = dv.getUint16(o, true);
	const gh = dv.getUint16(o + 2, true);
	const x0 = placed ? dv.getInt16(o + 4, true) : -gw / 2;
	const z0 = placed ? dv.getInt16(o + 6, true) : -gh / 2;
	const head = o + (placed ? 8 : 4);
	// the older map reaches further than the island, which shows the middle of it
	const isleX = placed ? Math.ceil(Math.max(-x0, x0 + gw) / CH) * CH : 480;
	const isleZ = placed ? Math.ceil(Math.max(-z0, z0 + gh) / CH) * CH : 416;
	const cells = new Uint8Array(buf, head, gw * gh); // the buffer is ours to change
	const steps = new Uint8Array(buf, head + gw * gh, (gw / 2) * (gh / 2));
	if (version === 1) for (let i = gw / 2; i < steps.length; i++) steps[i] = (steps[i] + steps[i - gw / 2]) & 255;
	const at = head + gw * gh + (gw / 2) * (gh / 2);
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
	const data: Data = { gw, gh, x0, z0, cells, steps, houses, byChunk };

	const cellAt = (x: number, z: number) => {
		const ix = Math.floor(x) - x0;
		const iz = Math.floor(z) - z0;
		return ix >= 0 && iz >= 0 && ix < gw && iz < gh ? data.cells[iz * gw + ix] : 0;
	};
	const isWater = (x: number, z: number) => (cellAt(x, z) & 1) === 1;
	const roadAt = (x: number, z: number) => ((cellAt(x, z) >> 1) & 3) > 0;
	// a railway tunnel runs under here: the hill stays over it and the train is out of sight
	const tunnelAt = (x: number, z: number) => (cellAt(x, z) & 64) === 64;
	const stepAt = (x: number, z: number) => {
		const ix = (Math.floor(x) - x0) >> 1;
		const iz = (Math.floor(z) - z0) >> 1;
		return ix >= 0 && iz >= 0 && ix < gw / 2 && iz < gh / 2 ? data.steps[iz * (gw / 2) + ix] : 0;
	};
	const hillHeight = (x: number, z: number) => stepAt(x, z) * STEP;
	// the railway runs at a height of its own, smooth where the terrain goes in steps
	const bed = trains ? railProfile(trains, hillHeight, (x, z) => isWater(x, z), tunnelAt) : undefined;
	// the metro, where it comes out of the ground: a railway of its own
	const metroBed = metro ? railProfile(metro, hillHeight, (x, z) => isWater(x, z)) : undefined;
	const metroSeen = metro ? nearTrack(metro) : () => false;

	function initWater(carves: [number, number, number][]) {
		for (const [cx, cz, r] of carves) {
			for (let iz = Math.floor(cz - r); iz <= Math.ceil(cz + r); iz++) {
				for (let ix = Math.floor(cx - r); ix <= Math.ceil(cx + r); ix++) {
					const gx = ix - x0;
					const gz = iz - z0;
					if (gx < 0 || gz < 0 || gx >= gw || gz >= gh) continue;
					if (Math.hypot(ix + 0.5 - cx, iz + 0.5 - cz) <= r) data.cells[gz * gw + gx] &= ~1;
				}
			}
		}
	}

	/** the terrain in columns of 2 x 2, flattened where the railway runs */
	const columns = (railDist: (x: number, z: number) => number) => (x: number, z: number) => {
		const mx = Math.floor(x / 2) * 2 + 1;
		const mz = Math.floor(z / 2) * 2 + 1;
		const s = stepAt(mx, mz);
		if (s === 0) return 0;
		const f = clamp((railDist(mx, mz) - 6) / 7, 0, 1);
		const h = Math.floor(s * f + 1e-6) * STEP;
		// the land a little above the bed of the railway (an embankment the terrain model has kept, a cutting) is dug
		// down to it; a real hill is left for the tunnel through it
		const b = bed ? bed(mx, mz) : NaN;
		if (b > 0 && h > b && h < b + 4 && !tunnelAt(mx, mz)) return Math.floor(b / STEP + 1e-6) * STEP;
		return h;
	};

	// the bridges over the water, made once the first caller knows the height of the land
	let bridgesMade: Bridges | null | undefined;
	const bridgesOf = (columnH: (x: number, z: number) => number) => {
		if (bridgesMade === undefined) bridgesMade = roads ? makeBridges(roads, isWater, columnH, nearCharles) : null;
		return bridgesMade;
	};

	function createChunkBuilder(railDist: (x: number, z: number) => number, roadOK: (x: number, z: number) => boolean) {
		const columnH = columns(railDist);
		const bridges = bridgesOf(columnH);

		return function build(cx: number, cz: number, far: boolean, coarse = false): Chunk {
			const x0 = cx * CH;
			const z0 = cz * CH;
			const list: Box[] = [];
			const lamps: Box[] = [];
			const add = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry = 0) => list.push([w, h, d, color, x, y, z, ry]);
			const lamp = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry = 0) => lamps.push([w, h, d, color, x, y, z, ry]);
			const lines = roads !== null && !far;

			// zoomed far out a block of 4 x 4 cells is one column, as low as the lowest cut of the railway near it, and
			// there are no trees: a pixel is then about a cell
			const cs = coarse ? 4 : 2;
			const blocks = new Float32Array((CH / 4) ** 2).fill(NaN);
			const blockAt = (bx: number, bz: number) => {
				let lo = Infinity;
				let sum = 0;
				for (const [ox, oz] of [[1, 1], [3, 1], [1, 3], [3, 3]]) {
					const h = columnH(bx + ox, bz + oz);
					lo = Math.min(lo, h);
					sum += h;
				}
				return railDist(bx + 2, bz + 2) < 16 ? lo : Math.round(sum / 4 / STEP) * STEP;
			};
			const blockH = (x: number, z: number) => {
				const gx = Math.floor((x - x0) / 4);
				const gz = Math.floor((z - z0) / 4);
				const bx = x0 + gx * 4;
				const bz = z0 + gz * 4;
				// a house near the edge of the chunk may reach into the next one
				if (gx < 0 || gz < 0 || gx >= CH / 4 || gz >= CH / 4) return blockAt(bx, bz);
				const bi = gz * (CH / 4) + gx;
				if (Number.isNaN(blocks[bi])) blocks[bi] = blockAt(bx, bz);
				return blocks[bi];
			};
			const colH = coarse ? blockH : columnH;

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
						h = colH(x, z);
						const road = (c >> 1) & 3;
						// a bridge deck has its own boxes; the raster strip stays only where none stands (a quay the map calls a bridge)
						if (road && c & 1) kind = bridges?.covers(x, z) ? 1 : 6;
						else if (c & 1) kind = 1;
						else if (road && roadOK(x, z)) kind = road === 1 ? 4 : road === 2 ? 5 : 7;
						else if (!road && ((c >> 4) & 3) === 1 && h === 0) kind = 2;
						else if (!road && ((c >> 4) & 3) === 2 && h === 0) kind = 3;
						const lampOK = kind === 4 || kind === 5 || kind === 7;
						if (lampOK && lines) kind = 0; // up close the lines draw the streets
						if (lampOK) {
							if (!far && hash2(Math.floor(x), Math.floor(z)) % 29 === 0 && railDist(x, z) > 2.5) {
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
			// the streets as lines, where they are not on a bridge over the water or cut by the railway
			if (lines) roadBoxes(roads, cx, cz, columnH, (x, z) => isWater(x, z) || !roadOK(x, z), add);
			// the bridges, from afar too
			bridges?.boxes(cx, cz, far, add, lamp);
			// the tram rails and stops, up close
			if (trams) lineBoxes(trams, TRAM, cx, cz, far, colH, isWater, (x, z) => !roadOK(x, z), add, undefined, bridges?.deckAt);
			// the railway, from afar too
			if (trains) lineBoxes(trains, TRAIN, cx, cz, far, colH, isWater, tunnelAt, add, bed);
			if (metro) lineBoxes(metro, METRO, cx, cz, far, colH, isWater, (x, z) => !metroSeen(x, z), add, metroBed);

			// the piers of the bridges
			for (let iz = 0; iz < CH; iz += 2) {
				for (let ix = 0; ix < CH; ix += 2) {
					const x = x0 + ix + 0.5;
					const z = z0 + iz + 0.5;
					const c = cellAt(x, z);
					if (c & 8 && c & 1 && hash2(Math.floor(x / 2), Math.floor(z / 2)) % 2 === 0 && !bridges?.covers(x, z)) add(0.9, 0.5, 0.9, 0x7d7463, x, 0, z);
				}
			}

			// --- hills: columns of 2 x 2
			const conifer = (x: number, z: number, y: number) => {
			if (far) {
				add(1, 1.3, 1, 0x24683c, x, y + 0.65, z);
				return;
			}
			add(0.2, 0.4, 0.2, COLORS.wood, x, y + 0.2, z);
				add(1.1, 0.55, 1.1, 0x1f5a34, x, y + 0.65, z);
				add(0.8, 0.5, 0.8, 0x24683c, x, y + 1.15, z);
				add(0.45, 0.45, 0.45, 0x2a7545, x, y + 1.6, z);
			};
			const tree = (x: number, z: number, y: number, k: number) => {
			if (far) {
				add(0.75, 0.9, 0.75, LEAVES[k % 3], x, y + 0.6, z);
				return;
			}
			add(0.16, 0.45, 0.16, COLORS.wood, x, y + 0.22, z);
				add(0.75, 0.75, 0.75, LEAVES[k % 3], x, y + 0.8, z);
				if (k % 2) add(0.5, 0.5, 0.5, LEAVES[(k >>> 2) % 3], x, y + 1.35, z);
			};
			for (let iz = 0; iz < CH; iz += cs) {
				for (let ix = 0; ix < CH; ix += cs) {
					const x = x0 + ix + cs / 2;
					const z = z0 + iz + cs / 2;
					if (Math.abs(x) > isleX - 1 || Math.abs(z) > isleZ - 1) continue;
					const h = colH(x, z);
					if (h <= 0) continue;
					const g = (cellAt(x - 0.5, z - 0.5) >> 4) & 3;
					const k = hash2(Math.floor(x), Math.floor(z));
					const color = g === 2 ? (k % 3 ? 0x2f6b3c : 0x3a7a44) : g === 1 ? (k % 3 ? 0x5a9a58 : 0x6fae5e) : h > 60 * STEP ? 0x9a8d74 : EARTH[k % 2]; // bare rock above some 60 m
					// contour bands, so that the eye can read the slope
					const band = [1, 0.94, 0.88][Math.floor(h / (8 * STEP)) % 3]; // every 8 m
					add(cs, h, cs, shade(color, band), x, h / 2, z);
				}
			}

			// --- trees: parks and woods
			for (let iz = 0; iz < (coarse ? 0 : CH); iz++) {
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
			if (Math.floor((CHARLES.from[0] + CHARLES.to[0]) / 2 / CH) === cx && Math.floor((CHARLES.from[1] + CHARLES.to[1]) / 2 / CH) === cz) charlesBridge(bridges, add, lamp);

			// --- the houses, out of the way of the trams and the trains: a footprint drawn too big must not swallow their
			// track. A house goes when a tram track runs well inside it (one that only touches it stays), when it stands
			// on the ballast of a railway, or on the platforms of a station.
			const near: { xs: Float32Array; zs: Float32Array; segs: number[]; margin: number }[] = [];
			if (trams) near.push({ xs: trams.tx, zs: trams.tz, segs: trams.trackByChunk.get(cx * 1000 + cz) ?? [], margin: -0.2 });
			if (metro) near.push({ xs: metro.tx, zs: metro.tz, segs: metro.trackByChunk.get(cx * 1000 + cz) ?? [], margin: 0.6 });
			if (trains) {
				near.push({ xs: trains.tx, zs: trains.tz, segs: trains.trackByChunk.get(cx * 1000 + cz) ?? [], margin: 0.6 });
				// the platforms, as their middle lines
				const px: number[] = [];
				const pz: number[] = [];
				const segs: number[] = [];
				for (const i of trains.stopsByChunk.get(cx * 1000 + cz) ?? []) {
					const st = trains.stops[i];
					const c = Math.cos(st.heading);
					const sn = Math.sin(st.heading);
					for (const o of [-1.55, 1.55]) {
						segs.push(px.length);
						px.push(st.x - sn * o - c * 7, st.x - sn * o + c * 7);
						pz.push(st.z + c * o - sn * 7, st.z + c * o + sn * 7);
					}
				}
				near.push({ xs: Float32Array.from(px), zs: Float32Array.from(pz), segs, margin: 0.7 });
			}
			const onTrack = (x: number, z: number, w: number, d: number, ang: number) => {
				const ca = Math.cos(ang);
				const sa = Math.sin(ang);
				for (const { xs, zs, segs, margin } of near) {
					for (const i of segs) {
						const ax = xs[i] - x;
						const az = zs[i] - z;
						const bx = xs[i + 1] - x;
						const bz = zs[i + 1] - z;
						const r = (w + d) / 2 + 2;
						if (Math.min(ax, bx) > r || Math.max(ax, bx) < -r || Math.min(az, bz) > r || Math.max(az, bz) < -r) continue;
						const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
						for (let k = 0; k <= n; k++) {
							const px = ax + ((bx - ax) * k) / n;
							const pz = az + ((bz - az) * k) / n;
							// into the frame of the house
							if (Math.abs(px * ca + pz * sa) < w / 2 + margin && Math.abs(-px * sa + pz * ca) < d / 2 + margin) return true;
						}
					}
				}
				return false;
			};
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
				if ((coarse && w * d < 8) || !farFromSights(x, z) || onTrack(x, z, w, d, ang)) continue;
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
					const g = colH(px, pz);
					gmax = Math.max(gmax, g);
					gmin = Math.min(gmin, g);
				}
				// a house on too steep a slope is left out; a big one may stand on a plinth that much higher
				if (!ok || gmax - gmin > Math.max(6, Math.max(w, d) * 0.75)) continue;
				const k = hash2(Math.round(x * 4), Math.round(z * 4));
				const wall = WALLS[k % WALLS.length];
				const roof = ROOFS[(k >>> 5) % ROOFS.length];
				const ry = -ang;
				const place = (lx: number, lz: number): [number, number] => [x + lx * ca - lz * sa, z + lx * sa + lz * ca];
				let h = clamp(metres / 5.2, 1, 11);
				if (kind & 1) h = Math.max(h, 2.6);
				// from afar a house is only its roof on the ground, like on a map; a church keeps its tower to find the way by
				if (far && !(kind & 1)) {
					add(w, 0.3, d, kind & 2 || h > 7.5 ? 0x8a8f96 : roof, x, gmax + 0.15, z, ry);
					continue;
				}
				if (gmax > gmin + 0.05) add(w, gmax - gmin, d, wall, x, (gmax + gmin) / 2, z, ry);
				add(w, h, d, wall, x, gmax + h / 2, z, ry);
				const flat = kind & 2 || h > 7.5;
				if (flat) {
					add(w + 0.1, 0.14, d + 0.1, FLAT_ROOFS[(k >>> 9) % FLAT_ROOFS.length], x, gmax + h + 0.07, z, ry);
				} else {
					const rise = d > 3 ? 0.4 : 0.3;
					add(w + 0.12, rise, d + 0.12, roof, x, gmax + h + rise / 2, z, ry);
					if (!far) {
						add(w + 0.12, rise, d * 0.64, roof, x, gmax + h + rise * 1.5, z, ry);
						add(w + 0.12, rise, d * 0.28, roof, x, gmax + h + rise * 2.5, z, ry);
					}
				}
				if (kind & 1 && w > 1.4) {
					const [tx, tz] = place(w / 2 - 0.6, 0);
					add(1.1, h * 1.7, 1.1, wall, tx, gmax + (h * 1.7) / 2, tz, ry);
					for (let t = 0; t < (far ? 1 : 4); t++) add(1.2 - t * 0.28, far ? 1.2 : 0.6, 1.2 - t * 0.28, 0x4a5560, tx, gmax + h * 1.7 + (far ? 0.6 : 0.3 + t * 0.6), tz, ry);
				}
				// windows on the long sides: dark by day, lit at night
				if (!far && h >= 1.3) {
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

	/** the house nearest to (x, z), if one stands within `reach` of it: where its roof tops out as the chunks build it, and the turn of its long side */
	function roofAt(x: number, z: number, reach: number, groundH: (x: number, z: number) => number) {
		let best = -1;
		let bestDist = reach * reach;
		for (let dx = -1; dx <= 1; dx++) {
			for (let dz = -1; dz <= 1; dz++) {
				for (const i of data.byChunk.get((Math.floor(x / CH) + dx) * 1000 + Math.floor(z / CH) + dz) ?? []) {
					const dist = (data.houses[i * 7] / 4 - x) ** 2 + (data.houses[i * 7 + 1] / 4 - z) ** 2;
					if (dist < bestDist) {
						bestDist = dist;
						best = i;
					}
				}
			}
		}
		if (best < 0) return null;
		const o = best * 7;
		const hx = data.houses[o] / 4;
		const hz = data.houses[o + 1] / 4;
		const w = Math.max(0.9, data.houses[o + 2] / 8);
		const d = Math.max(0.9, data.houses[o + 3] / 8);
		const ang = (data.houses[o + 4] / 256) * Math.PI;
		const ca = Math.cos(ang);
		const sa = Math.sin(ang);
		let gmax = 0;
		for (const [lx, lz] of [[0, 0], [w / 2, d / 2], [-w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]]) gmax = Math.max(gmax, groundH(hx + lx * ca - lz * sa, hz + lx * sa + lz * ca));
		const h = wallHeight(data.houses[o + 5], data.houses[o + 6]);
		const flat = data.houses[o + 6] & 2 || h > 7.5;
		return { x: hx, z: hz, ang, top: gmax + h + (flat ? FLAT_SLAB : roofRise(d) * 3) };
	}

	/** Charles Bridge: its deck and piers are those of praha-bridges.ts (the old strip of stone where the streets did not come), here are the statues and the three towers */
	function charlesBridge(bridges: Bridges | null, add: (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry?: number) => void, lamp: typeof add) {
		const [x1, z1] = CHARLES.from;
		const [x2, z2] = CHARLES.to;
		const dx = (x2 - x1) / CHARLES_LEN;
		const dz = (z2 - z1) / CHARLES_LEN;
		/** the point `t` along the bridge and `lat` to the side, on the deck where there is one: its height and heading */
		const on = (t: number, lat: number) => {
			const f = bridges?.frame(x1 + dx * t, z1 + dz * t);
			const ux = f ? f.ux : dx;
			const uz = f ? f.uz : dz;
			return { x: (f ? f.x : x1 + dx * t) - uz * lat, z: (f ? f.z : z1 + dz * t) + ux * lat, h: f ? f.h : 0.4, ry: -Math.atan2(uz, ux) };
		};
		for (let t = 0.5; t < CHARLES_LEN; t += 1) {
			if (!bridges) {
				const p = on(t, 0);
				add(1.2, 0.3, 1.25, 0x9a8f7a, p.x, 0.4, p.z, p.ry);
				for (const side of [-0.6, 0.6]) {
					const q = on(t, side);
					add(0.12, 0.3, 1.25, 0x7d7463, q.x, 0.7, q.z, q.ry);
				}
				if (Math.floor(t) % 4 === 0) add(0.9, 0.6, 1.1, 0x7d7463, p.x, 0.05, p.z, p.ry);
			}
			if (Math.floor(t) % 5 === 2) {
				for (const side of [-0.6, 0.6]) {
					const q = on(t, side);
					add(0.22, 0.75, 0.22, 0x2a2a2e, q.x, q.h + 0.4, q.z);
				}
			}
		}
		const tower = (t: number, w: number, h: number, roof: number) => {
			const p = on(t, 0);
			const H = p.h + h; // it stands on the ground, the deck passes through it
			add(w, H, 2.3, 0xbcb3a0, p.x, H / 2, p.z, p.ry);
			add(w + 0.2, 0.3, 2.5, 0x8a8170, p.x, H + 0.15, p.z, p.ry);
			for (let i = 0; i < 4; i++) add(w * (1 - i * 0.22), 0.6, 2.2 * (1 - i * 0.3), roof, p.x, H + 0.6 + i * 0.6, p.z, p.ry);
			lamp(0.3, 0.5, 0.1, COLORS.lit, p.x, H * 0.6, p.z);
		};
		tower(CHARLES_LEN - 1.2, 2.6, 6.4, 0x4a4540); // the Old Town tower
		tower(CHARLES_LEN * 0.27, 2.4, 5.4, 0x6b3f2e); // the Lesser Town towers
		tower(CHARLES_LEN * 0.27 - 4.4, 2.2, 3.8, 0x6b3f2e);
	}

	/** cars on the streets, when the streets came as lines, and the trams and the trains by the timetable */
	function createExtras(scene: Scene, railDist: (x: number, z: number) => number, roadOK: (x: number, z: number) => boolean): Extras {
		const columnH = columns(railDist);
		const bridges = bridgesOf(columnH);
		// on the road, or on the deck of a bridge over the water; a car says whether it is on a bridge, one on a street
		// under a bridge stays on the ground, and only a car rides on a viaduct (the trams and the buses leave `onBridge` out)
		const groundAt = (x: number, z: number, onBridge?: boolean) => {
			const deck = bridges && onBridge !== false ? bridges.deckAt(x, z, onBridge === true) : NaN;
			if (!Number.isNaN(deck)) return deck + 0.07;
			return isWater(x, z) ? 0.4 : columnH(x, z) + 0.07;
		};
		const all: Extras[] = [];
		if (roads) {
			// the streets into the crossing in Vysočany are closed: the police are there; and Charles Bridge is for walking
			const open = (x: number, z: number) => (x - ACCIDENT.x) ** 2 + (z - ACCIDENT.z) ** 2 > ACCIDENT.r ** 2 && !nearCharles(x, z, 2);
			all.push(createTraffic(scene, roads, groundAt, (x, z) => open(x, z) && (isWater(x, z) || roadOK(x, z))));
			all.push(createAccident(scene, roads, groundAt));
			all.push(createYard(scene, groundAt));
		}
		// the rapper stands on the ridge of Saratovská 17, looking out of the front of the house, where its address point is
		const [rx, rz] = project(RAPPER.lat, RAPPER.lon);
		const home = roofAt(rx, rz, 3, columnH);
		if (home) {
			const side = Math.cos(home.ang - Math.PI / 2) * (rx - home.x) + Math.sin(home.ang - Math.PI / 2) * (rz - home.z) > 0 ? -1 : 1;
			all.push(createRapper(scene, { x: home.x, z: home.z, y: home.top, facing: home.ang + (side * Math.PI) / 2 }));
		}
		if (trams) all.push(createTrams(scene, trams, TRAM, groundAt));
		if (buses) all.push(createTrams(scene, buses, BUS, groundAt));
		if (metro) {
			all.push(
				createTrams(scene, metro, METRO, (x, z) => {
					const h = metroBed ? metroBed(x, z) : NaN;
					return Number.isNaN(h) ? columnH(x, z) : h;
				}),
			);
		}
		if (trains) {
			all.push(
				createTrams(
					scene,
					trains,
					TRAIN,
					(x, z) => {
						const h = bed ? bed(x, z) : NaN;
						return Number.isNaN(h) ? (isWater(x, z) ? 0.4 : columnH(x, z)) : h;
					},
					(x, z) => !tunnelAt(x, z),
				),
			);
		}
		return {
			simulate: (dt, focus) => all.forEach((e) => e.simulate(dt, focus)),
			pose: () => all.forEach((e) => e.pose()),
			// a click picks the nearest tram or train of all of them
			pick(toScreen, px, py) {
				let best: ReturnType<NonNullable<Extras["pick"]>> = null;
				for (const e of all) {
					const hit = e.pick?.(toScreen, px, py) ?? null;
					if (hit && (!best || hit.dist < best.dist)) best = hit;
				}
				if (!best) return null;
				const chosen = best;
				return {
					dist: chosen.dist,
					select() {
						for (const e of all) e.unselect?.();
						chosen.select();
					},
				};
			},
			card: () => {
				for (const e of all) {
					const c = e.card?.();
					if (c) return c;
				}
				return null;
			},
			unselect: () => all.forEach((e) => e.unselect?.()),
			places: () => all.flatMap((e) => e.places?.() ?? []),
		};
	}

	return {
		isleX,
		isleZ,
		fit: { x: 40, z: -10, hx: 160, hz: 100 },
		kMax: placed ? 6 : undefined,
		coarseK: 3.2,
		railway: false,
		ground: 0xb3ab97,
		isWater,
		hillHeight,
		roadAt,
		initWater,
		createChunkBuilder,
		createExtras,
	};
}

