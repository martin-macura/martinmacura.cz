// The streets of Prague as lines (scripts/praha/bake_roads.py): drawn straight up close, where the raster of
// praha.dat would show its stairs, and a graph of junctions and edges for the cars to drive on.
const CH = 32;

export interface RoadNet {
	nx: Float32Array; // the nodes
	nz: Float32Array;
	/** per edge: its first and last node, class (1 street, 2 avenue, 3 motorway), one way, a bridge */
	ea: Uint32Array;
	eb: Uint32Array;
	cls: Uint8Array;
	oneway: Uint8Array;
	/** per edge: 1 when it is on a bridge or a viaduct (over water or over land) */
	bridge: Uint8Array;
	/** the points of edge e, ends included, are px/pz[start[e] .. start[e + 1]) */
	start: Uint32Array;
	px: Float32Array;
	pz: Float32Array;
	/** chunk key -> the segments that touch it, as the index of their first point */
	byChunk: Map<number, number[]>;
	/** the segment starting at point i belongs to edge segEdge[i] */
	segEdge: Uint32Array;
}

export function parseRoads(buf: ArrayBuffer): RoadNet {
	const b = new Uint8Array(buf);
	let o = 0;
	const uv = () => {
		let v = 0;
		let mul = 1;
		for (;;) {
			const byte = b[o++];
			v += (byte & 0x7f) * mul;
			if (byte < 0x80) return v;
			mul *= 128;
		}
	};
	const sv = () => {
		const v = uv();
		return v % 2 ? -(v + 1) / 2 : v / 2;
	};
	const nn = uv();
	const nx = new Float32Array(nn);
	const nz = new Float32Array(nn);
	let x = 0;
	let z = 0;
	for (let i = 0; i < nn; i++) {
		x += sv();
		z += sv();
		nx[i] = x / 4;
		nz[i] = z / 4;
	}
	const ne = uv();
	const ea = new Uint32Array(ne);
	const eb = new Uint32Array(ne);
	const cls = new Uint8Array(ne);
	const oneway = new Uint8Array(ne);
	const bridge = new Uint8Array(ne);
	const start = new Uint32Array(ne + 1);
	const xs: number[] = [];
	const zs: number[] = [];
	let a = 0;
	for (let e = 0; e < ne; e++) {
		const f = uv();
		a += uv();
		const bb = a + sv();
		const n = uv();
		ea[e] = a;
		eb[e] = bb;
		cls[e] = f & 3;
		oneway[e] = (f >> 2) & 1;
		bridge[e] = (f >> 3) & 1;
		start[e] = xs.length;
		let lx = nx[a] * 4;
		let lz = nz[a] * 4;
		xs.push(nx[a]);
		zs.push(nz[a]);
		for (let i = 0; i < n; i++) {
			lx += sv();
			lz += sv();
			xs.push(lx / 4);
			zs.push(lz / 4);
		}
		xs.push(nx[bb]);
		zs.push(nz[bb]);
	}
	start[ne] = xs.length;
	const px = Float32Array.from(xs);
	const pz = Float32Array.from(zs);
	const segEdge = new Uint32Array(px.length);
	const byChunk = new Map<number, number[]>();
	for (let e = 0; e < ne; e++) {
		const pad = WIDTH[cls[e]] / 2;
		for (let i = start[e]; i < start[e + 1] - 1; i++) {
			segEdge[i] = e;
			const cx0 = Math.floor((Math.min(px[i], px[i + 1]) - pad) / CH);
			const cx1 = Math.floor((Math.max(px[i], px[i + 1]) + pad) / CH);
			const cz0 = Math.floor((Math.min(pz[i], pz[i + 1]) - pad) / CH);
			const cz1 = Math.floor((Math.max(pz[i], pz[i + 1]) + pad) / CH);
			for (let cx = cx0; cx <= cx1; cx++) {
				for (let cz = cz0; cz <= cz1; cz++) {
					const key = cx * 1000 + cz;
					const list = byChunk.get(key);
					if (list) list.push(i);
					else byChunk.set(key, [i]);
				}
			}
		}
	}
	return { nx, nz, ea, eb, cls, oneway, bridge, start, px, pz, byChunk, segEdge };
}

/** how wide a street of each class is, in units of 6 m */
export const WIDTH = [0, 1, 1.7, 2.4];
const COLOR = [0, 0x2b2b2b, 0x2b2b2b, 0x1f1f1f];
const THICK = [0, 0.05, 0.06, 0.06];
const LIFT = [0, 0.035, 0.04, 0.04];

/**
 * walks the segment (x1, z1) - (x2, z2) in short steps and hands over the part of it inside chunk (cx, cz) as runs:
 * one run for as long as the ground under it stays at one height and nothing says to skip it
 */
export function walkSegment(
	x1: number,
	z1: number,
	x2: number,
	z2: number,
	cx: number,
	cz: number,
	ground: (x: number, z: number) => number,
	skip: (x: number, z: number) => boolean,
	run: (x: number, z: number, len: number, h: number, ry: number) => void,
) {
	const dx = x2 - x1;
	const dz = z2 - z1;
	const len = Math.hypot(dx, dz);
	if (len < 1e-4) return;
	const ux = dx / len;
	const uz = dz / len;
	const ry = -Math.atan2(uz, ux);
	const n = Math.max(1, Math.ceil(len / 0.5));
	const step = len / n;
	let runFrom = -1;
	let runH = 0;
	const flush = (to: number) => {
		if (runFrom < 0) return;
		const m = ((runFrom + to) / 2) * step;
		run(x1 + ux * m, z1 + uz * m, (to - runFrom) * step, runH, ry);
		runFrom = -1;
	};
	for (let k = 0; k < n; k++) {
		const t = (k + 0.5) * step;
		const x = x1 + ux * t;
		const z = z1 + uz * t;
		if (!inChunk(x, z, cx, cz) || skip(x, z)) {
			flush(k);
			continue;
		}
		const h = ground(x, z);
		if (runFrom >= 0 && h !== runH) flush(k);
		if (runFrom < 0) {
			runFrom = k;
			runH = h;
		}
	}
	flush(n);
}

export const inChunk = (x: number, z: number, cx: number, cz: number) => Math.floor(x / CH) === cx && Math.floor(z / CH) === cz;

/** the streets of chunk (cx, cz) as boxes along the lines, with a square at every bend to close the joint */
export function roadBoxes(
	net: RoadNet,
	cx: number,
	cz: number,
	ground: (x: number, z: number) => number,
	skip: (x: number, z: number) => boolean,
	add: (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry?: number) => void,
	/** the land under the street, where the street runs higher than it (up a ramp): the street stands on it */
	base: (x: number, z: number) => number = ground,
) {
	const segs = net.byChunk.get(cx * 1000 + cz);
	if (!segs) return;
	for (const i of segs) {
		const c = net.cls[net.segEdge[i]];
		const w = WIDTH[c];
		const x1 = net.px[i];
		const z1 = net.pz[i];
		const x2 = net.px[i + 1];
		const z2 = net.pz[i + 1];
		// the top of the street at h, its bottom down on the land under it
		const slab = (l: number, d: number, x: number, z: number, h: number, ry: number) => {
			const top = h + LIFT[c] + THICK[c] / 2;
			const bottom = Math.min(top - THICK[c], base(x, z));
			add(l, top - bottom, d, COLOR[c], x, (top + bottom) / 2, z, ry);
		};
		walkSegment(x1, z1, x2, z2, cx, cz, ground, skip, (x, z, len, h, ry) => slab(len, w, x, z, h, ry));
		const ry = -Math.atan2(z2 - z1, x2 - x1);
		// the joint at the start of the segment (the ends of the edges are joints too)
		if (inChunk(x1, z1, cx, cz) && !skip(x1, z1)) slab(w, w, x1, z1, ground(x1, z1), ry);
		if (i + 2 === net.start[net.segEdge[i] + 1] && inChunk(x2, z2, cx, cz) && !skip(x2, z2)) slab(w, w, x2, z2, ground(x2, z2), ry);
	}
}
