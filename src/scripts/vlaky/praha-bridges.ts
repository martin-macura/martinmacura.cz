// The bridges of Prague. A street over the water used to be a slab at the height of the water; here it is a deck that
// rises from the quay and arches over the river on piers, with a parapet and lamps. A deck is found once from the
// raster of praha.dat (a street over water, which the baking calls a bridge): its height is the bank plus a rise that
// grows with the distance from the nearest dry cell. The streets as lines then run on it, and so do the cars.
import { clamp } from "./util";
import { inChunk, type RoadNet, walkSegment, WIDTH } from "./praha-roads";
// a bridge over the water is where a street runs over water: the raster of the cells says so, and so do the lines of the
// streets, which do not follow the raster to the cell

type Add = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry?: number) => void;

const CH = 32;
const DECK = 0xb4ab98; // concrete, a little warm
const PARAPET = 0xd2cbb8;
const PIER = 0x8d8472;
const SHADOW = 0x1f56cc; // what the water looks like under a bridge, a dark blue
const FOAM = 0xd6e8ff;
const ASPHALT = 0x2b2b2b;
const DARK = 0x14161c;
const LIT = 0xffd56b;
const BED = -0.3; // the river bed, where the piers stand
/** a pier every so many units along a bridge */
export const PIER_EVERY = 4.5;

export interface Decks {
	/** the top of the deck of the cell (x, z) is in, NaN where it is not a bridge over water */
	cellAt(x: number, z: number): number;
	/** the same, smooth from cell to cell and in steps of 0.05, so that a car can drive on it; NaN away from the bridges */
	at(x: number, z: number): number;
	/** a bridge has a cell in chunk (cx, cz) */
	inChunk(cx: number, cz: number): boolean;
}

/**
 * the decks of all the bridges over water in the grid: `cells` is the raster (bit 0 water, bits 1-2 road), `hill` the
 * height of the land, `skip` the cells to leave out (Charles Bridge has its own)
 */
export function findDecks(gw: number, gh: number, x0: number, z0: number, cells: Uint8Array, hill: (x: number, z: number) => number, skip: (x: number, z: number) => boolean, net: RoadNet | null): Decks {
	const bridge = new Map<number, number>(); // cell -> its deck
	const chunks = new Set<number>();
	const xy = (i: number): [number, number] => [(i % gw) + x0, Math.floor(i / gw) + z0];
	const cell = (x: number, z: number) => (z - z0) * gw + (x - x0);
	const inside = (x: number, z: number) => x >= x0 && z >= z0 && x < x0 + gw && z < z0 + gh;

	const members: number[] = [];
	for (let i = 0; i < cells.length; i++) {
		const c = cells[i];
		if (c & 1 && c & 6) {
			const [x, z] = xy(i);
			if (!skip(x + 0.5, z + 0.5)) members.push(i);
		}
	}
	const isMember = new Set(members);
	// the streets as lines can run over water cells that have no street in the raster
	if (net) {
		for (let e = 0; e < net.ea.length; e++) {
			for (let i = net.start[e]; i < net.start[e + 1] - 1; i++) {
				const len = Math.hypot(net.px[i + 1] - net.px[i], net.pz[i + 1] - net.pz[i]);
				const n = Math.max(1, Math.ceil(len / 0.5));
				for (let k = 0; k <= n; k++) {
					const x = Math.floor(net.px[i] + ((net.px[i + 1] - net.px[i]) * k) / n);
					const z = Math.floor(net.pz[i] + ((net.pz[i + 1] - net.pz[i]) * k) / n);
					if (!inside(x, z)) continue;
					const j = cell(x, z);
					if (cells[j] & 1 && !isMember.has(j) && !skip(x + 0.5, z + 0.5)) {
						isMember.add(j);
						members.push(j);
					}
				}
			}
		}
	}
	// the distance to the nearest dry cell, and the bank there: a breadth first search from the cells next to land
	const dist = new Map<number, number>();
	const bank = new Map<number, number>();
	let front: number[] = [];
	for (const i of members) {
		const [x, z] = xy(i);
		let land = -1;
		for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			if (inside(x + dx, z + dz) && !(cells[cell(x + dx, z + dz)] & 1)) land = Math.max(land, hill(x + dx + 0.5, z + dz + 0.5));
		}
		if (land >= 0) {
			dist.set(i, 1);
			bank.set(i, land);
			front.push(i);
		}
	}
	while (front.length) {
		const next: number[] = [];
		for (const i of front) {
			const [x, z] = xy(i);
			for (let dx = -1; dx <= 1; dx++) {
				for (let dz = -1; dz <= 1; dz++) {
					if (!inside(x + dx, z + dz)) continue;
					const j = cell(x + dx, z + dz);
					if (!isMember.has(j) || dist.has(j)) continue;
					dist.set(j, dist.get(i)! + 1);
					bank.set(j, bank.get(i)!);
					next.push(j);
				}
			}
		}
		front = next;
	}
	// a bridge is a run of cells that touch: its longest reach from the banks says how high it arches
	const seen = new Set<number>();
	for (const start of members) {
		if (seen.has(start)) continue;
		const part = [start];
		seen.add(start);
		for (let k = 0; k < part.length; k++) {
			const [x, z] = xy(part[k]);
			for (let dx = -1; dx <= 1; dx++) {
				for (let dz = -1; dz <= 1; dz++) {
					if (!inside(x + dx, z + dz)) continue;
					const j = cell(x + dx, z + dz);
					if (isMember.has(j) && !seen.has(j)) {
						seen.add(j);
						part.push(j);
					}
				}
			}
		}
		const reach = Math.max(...part.map((i) => dist.get(i) ?? 1));
		const rise = clamp(0.15 + 0.16 * reach, 0.3, 1.5);
		const ramp = Math.min(reach - 1, 6); // cells over which the deck climbs
		for (const i of part) {
			const f = ramp > 0 ? clamp(((dist.get(i) ?? 1) - 1) / ramp, 0, 1) : 0;
			const top = (bank.get(i) ?? 0) + 0.1 + rise * f * f * (3 - 2 * f);
			bridge.set(i, Math.round(top * 20) / 20);
			const [x, z] = xy(i);
			chunks.add(Math.floor(x / CH) * 1000 + Math.floor(z / CH));
		}
	}

	const cellAt = (x: number, z: number) => {
		const ix = Math.floor(x);
		const iz = Math.floor(z);
		return inside(ix, iz) ? (bridge.get(cell(ix, iz)) ?? NaN) : NaN;
	};
	return {
		cellAt,
		inChunk: (cx, cz) => chunks.has(cx * 1000 + cz),
		at(x, z) {
			if (Number.isNaN(cellAt(x, z))) return NaN;
			const u = x - 0.5;
			const v = z - 0.5;
			const ix = Math.floor(u);
			const iz = Math.floor(v);
			const fx = u - ix;
			const fz = v - iz;
			const h = [cellAt(ix + 0.5, iz + 0.5), cellAt(ix + 1.5, iz + 0.5), cellAt(ix + 0.5, iz + 1.5), cellAt(ix + 1.5, iz + 1.5)];
			const known = h.filter((n) => !Number.isNaN(n));
			if (!known.length) return NaN;
			const mean = known.reduce((a, b) => a + b, 0) / known.length;
			const [a, b, c, d] = h.map((n) => (Number.isNaN(n) ? mean : n));
			return Math.round(((a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz) * 20) / 20;
		},
	};
}

/**
 * the decks of the streets of chunk (cx, cz) as lines: a slab with its asphalt, a parapet on each side, lamps on the
 * deck and piers in the water below it
 */
export function bridgeBoxes(net: RoadNet, decks: Decks, cx: number, cz: number, add: Add, lamp: Add, isWater: (x: number, z: number) => boolean) {
	if (!decks.inChunk(cx, cz)) return;
	const segs = net.byChunk.get(cx * 1000 + cz);
	if (!segs) return;
	let last = -2;
	let walked = 0; // along the water, to put the piers and the lamps at regular distances
	let lamps = 0;
	for (const i of segs) {
		const w = WIDTH[net.cls[net.segEdge[i]]];
		const x1 = net.px[i];
		const z1 = net.pz[i];
		const x2 = net.px[i + 1];
		const z2 = net.pz[i + 1];
		const len = Math.hypot(x2 - x1, z2 - z1);
		if (len < 1e-4) continue;
		const ux = (x2 - x1) / len;
		const uz = (z2 - z1) / len;
		const ry = -Math.atan2(uz, ux);
		const over = (x: number, z: number) => !Number.isNaN(decks.cellAt(x, z));
		if (i !== last + 1) walked = PIER_EVERY / 2;
		last = i;
		walkSegment(x1, z1, x2, z2, cx, cz, (x, z) => decks.at(x, z), (x, z) => !over(x, z), (x, z, l, h) => {
			// the shadow on the water, where the sun is (DAY in index.ts) and the deck is high enough to throw one
			if (h > 0.3 && isWater(x + (h - 0.15) * 0.57, z - (h - 0.15) * 0.71)) add(l + 0.02, 0.012, w + 0.7, SHADOW, x + (h - 0.15) * 0.57, 0.046, z - (h - 0.15) * 0.71, ry);
			add(l + 0.02, 0.4, w + 0.7, DECK, x, h + 0.02 - 0.2, z, ry);
			add(l + 0.02, 0.04, w, ASPHALT, x, h + 0.04, z, ry);
			for (const side of [-1, 1]) {
				const ox = uz * side * (w / 2 + 0.28); // across the street
				const oz = -ux * side * (w / 2 + 0.28);
				add(l + 0.02, 0.2, 0.13, PARAPET, x + ox, h + 0.12, z + oz, ry);
			}
		});
		// the piers and the lamps, along the segment
		const n = Math.max(1, Math.ceil(len / 0.5));
		for (let k = 0; k < n; k++) {
			const t = ((k + 0.5) * len) / n;
			const x = x1 + ux * t;
			const z = z1 + uz * t;
			if (!over(x, z)) {
				walked = PIER_EVERY / 2;
				continue;
			}
			const before = walked;
			walked += len / n;
			if (!inChunk(x, z, cx, cz)) continue;
			const h = decks.at(x, z);
			if (Math.floor(before / PIER_EVERY) !== Math.floor(walked / PIER_EVERY) && h > 0.3) {
				const bottom = h - 0.38;
				add(0.7, bottom - BED, w + 0.6, PIER, x, (bottom + BED) / 2, z, ry);
				add(0.82, 0.1, w + 0.74, DECK, x, bottom - 0.05, z, ry);
				add(1.15, 0.012, w + 1.1, FOAM, x, 0.05, z, ry); // the water breaking on the pier
			}
			if (Math.floor(before / 3.3) !== Math.floor(walked / 3.3)) {
				const side = lamps++ % 2 ? 1 : -1;
				const px = x + uz * side * (w / 2 + 0.28);
				const pz = z - ux * side * (w / 2 + 0.28);
				add(0.08, 0.7, 0.08, DARK, px, h + 0.37, pz, ry);
				lamp(0.18, 0.13, 0.18, LIT, px, h + 0.75, pz, ry);
			}
		}
	}
}

/** a bridge seen from afar, where the streets are not lines: the deck of a run of cells `len` long, with its asphalt */
export function cellDeckBoxes(len: number, top: number, x: number, z: number, add: Add) {
	add(len, 0.4, 1, DECK, x, top + 0.02 - 0.2, z);
	add(len, 0.04, 1, ASPHALT, x, top + 0.04, z);
}
