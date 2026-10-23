// The bridges of Prague: every street the map calls a bridge, where it touches water, is a deck of its own instead of a
// strip of the raster. The deck starts at the height of the street at each bank and rises towards the middle of the
// river; it is a thick girder with a pavement and a parapet at each side, lamps, piers in the water and a shadow on it.
// The cars, the trams and the buses ride on it (deckAt), the trams' rails are laid on it (lineBoxes) and the Charles
// Bridge puts its towers and statues on it (frame). A bridge over land (a viaduct, Nuselský most) is the same deck on
// piers, straight between its ends, where the land falls away under it; only the cars drive on that one.
import { COLOR, inChunk, type RoadNet, WIDTH } from "./praha-roads";
import { COLORS, hash2 } from "./util";

type Add = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry?: number) => void;

const STEP = 0.5; // between the samples along a bridge, units
const RAMP = 12; // from the bank so far the deck climbs; it is at its full height beyond
const HUMP = 1.6; // by this much higher than the banks (a unit on the screen is only a few pixels, a thin deck reads flat)
const GIRDER = 0.7; // how deep the girder under the roadway is
const SIDE = 0.4; // a pavement beside the roadway
const PIER_GAP = 6; // between the piers
const LAMP_GAP = 7;
const CLEAR = 0.25; // no piers where the girder is this close to what is under it
const SHADOW = 0x1f55d6; // the deck on the water, where the sun of the scene throws it: (-8, 14, 10), by (0.57, -0.71) a unit up
const QUANT = 0.025; // heights come in these steps, so that a flat deck is one box and a slope still makes runs
const CELL = 4; // the grid of the lookup of a point
const COVER = 1.6; // the raster leaves out its strip this far beyond the deck
const VIADUCT = 1.0; // a bridge over land is a deck only where the land is at least this far under it somewhere

/** stone, steel, concrete: a light girder, so that it shows against the dark road and the water */
const STYLES = [
	{ slab: 0xcfc8b6, rail: 0xe0dac8, pier: 0x6f6858 },
	{ slab: 0xaab4c2, rail: 0xc3ccd8, pier: 0x6f7884 },
	{ slab: 0xd6d3ca, rail: 0xe6e3da, pier: 0x7a776c },
];

interface Pier {
	x: number;
	z: number;
	ry: number;
	top: number; // under the girder
	base: number;
}

interface Span {
	n: number;
	x: Float32Array; // samples along the street, STEP apart
	z: Float32Array;
	s: Float32Array; // how far along from its start
	h: Float32Array; // the height of the roadway there
	half: number; // half the width of the deck
	cls: number;
	style: number;
	dry: boolean; // a viaduct over land, not a bridge over water
	piers: Pier[];
	/** between two piers: the arch under the girder, as steps */
	arches: { ax: number; az: number; bx: number; bz: number; ry: number; top: number; base: number }[];
	lamps: { x: number; z: number; h: number; ux: number; uz: number; side: number }[];
}

export interface Bridges {
	/** the height of the roadway of a bridge over water at (x, z), NaN where none stands; `viaducts` takes the ones over land too (only a car knows that it is on one, not under it) */
	deckAt(x: number, z: number, viaducts?: boolean): number;
	/** whether (x, z) lies on or close beside a deck over water, where the raster must not draw its own strip of bridge */
	covers(x: number, z: number): boolean;
	/** where the deck nearest to (x, z) is, if one is within a few units: the point on its middle line, its heading and its height */
	frame(x: number, z: number): { x: number; z: number; ux: number; uz: number; h: number } | null;
	/** the decks, the piers and the lamps of chunk (cx, cz); `far` is the coarse version */
	boxes(cx: number, cz: number, far: boolean, add: Add, lamp: Add): void;
}

/**
 * `ground` is the height of the street on the land, `stone` marks where a bridge is of stone (Charles Bridge). Bridges are the streets flagged as bridges that touch water,
 * together with the flagged streets joined to them; the flagged streets that touch no water are viaducts where the land falls away under them.
 */
export function makeBridges(net: RoadNet, isWater: (x: number, z: number) => boolean, ground: (x: number, z: number) => number, stone: (x: number, z: number) => boolean): Bridges {
	const ne = net.ea.length;
	const nn = net.nx.length;

	/** edge e as points STEP apart, its corners among them, and how far along each is */
	const sample = (e: number) => {
		const xs: number[] = [];
		const zs: number[] = [];
		const ss: number[] = [];
		let acc = 0;
		for (let i = net.start[e]; i < net.start[e + 1] - 1; i++) {
			const x1 = net.px[i];
			const z1 = net.pz[i];
			const len = Math.hypot(net.px[i + 1] - x1, net.pz[i + 1] - z1);
			const n = Math.max(1, Math.ceil(len / STEP));
			for (let k = 0; k < n; k++) {
				xs.push(x1 + ((net.px[i + 1] - x1) * k) / n);
				zs.push(z1 + ((net.pz[i + 1] - z1) * k) / n);
				ss.push(acc + (len * k) / n);
			}
			acc += len;
		}
		const last = net.start[e + 1] - 1;
		xs.push(net.px[last]);
		zs.push(net.pz[last]);
		ss.push(acc);
		return { x: xs, z: zs, s: ss };
	};

	// the streets flagged as bridges, in groups that touch at a junction; a group that touches water is a bridge over it, any other a viaduct if the land falls away
	const parent = Int32Array.from({ length: nn }, (_, i) => i);
	const find = (a: number): number => {
		while (parent[a] !== a) a = parent[a] = parent[parent[a]];
		return a;
	};
	const cand = new Map<number, ReturnType<typeof sample>>();
	const wetRoot = new Set<number>();
	for (let e = 0; e < ne; e++) {
		if (!net.bridge[e]) continue;
		cand.set(e, sample(e));
	}
	for (const e of cand.keys()) parent[find(net.ea[e])] = find(net.eb[e]);
	for (const [e, sm] of cand) if (sm.x.some((x, k) => isWater(x, sm.z[k]))) wetRoot.add(find(net.ea[e]));
	const groups = new Map<number, number[]>(); // the group (by its root node) -> its edges
	for (const e of cand.keys()) {
		const r = find(net.ea[e]);
		const list = groups.get(r);
		if (list) list.push(e);
		else groups.set(r, [e]);
	}

	const degAll = new Uint16Array(nn);
	const degLifted = new Uint16Array(nn);
	for (let e = 0; e < ne; e++) {
		degAll[net.ea[e]]++;
		degAll[net.eb[e]]++;
	}
	for (const edges of groups.values()) {
		for (const e of edges) {
			degLifted[net.ea[e]]++;
			degLifted[net.eb[e]]++;
		}
	}

	/** the height of the land at the end of a viaduct: the mean round it, so that the two roadways side by side start at one height */
	const bankAt = (x: number, z: number) => {
		let sum = 0;
		for (const dz of [-2, 0, 2]) for (const dx of [-2, 0, 2]) sum += ground(x + dx, z + dz);
		return sum / 9;
	};

	const spans: Span[] = [];
	for (const [root, edges] of groups) {
		const dry = !wetRoot.has(root);
		// the nodes of the group and the lengths between them
		const local = new Map<number, number>();
		const nodes: number[] = [];
		const at = (v: number) => {
			let i = local.get(v);
			if (i === undefined) {
				i = nodes.length;
				local.set(v, i);
				nodes.push(v);
			}
			return i;
		};
		const adj: [number, number][][] = [];
		for (const e of edges) {
			const sm = cand.get(e)!;
			const a = at(net.ea[e]);
			const b = at(net.eb[e]);
			const len = sm.s[sm.s.length - 1];
			(adj[a] ??= []).push([b, len]);
			(adj[b] ??= []).push([a, len]);
		}
		// the ends: where the street goes on as a street (or ends)
		const sources = nodes.map((v, i) => [v, i] as const).filter(([v]) => degLifted[v] < degAll[v] || degLifted[v] === 1);
		if (!sources.length) continue;
		// how far every node is from every end, along the bridge
		const dist = sources.map(([, from]) => {
			const d = new Float64Array(nodes.length).fill(Infinity);
			d[from] = 0;
			const queue = [from];
			for (let q = 0; q < queue.length; q++) {
				const u = queue[q];
				for (const [v, len] of adj[u] ?? []) {
					if (d[u] + len < d[v] - 1e-9) {
						d[v] = d[u] + len;
						queue.push(v);
					}
				}
			}
			return d;
		});
		const bank = sources.map(([v]) => (dry ? bankAt(net.nx[v], net.nz[v]) : ground(net.nx[v], net.nz[v])));
		const style = dry ? 2 : edges.some((e) => cand.get(e)!.x.some((x, k) => stone(x, cand.get(e)!.z[k]))) ? 0 : hash2(root, 3) % 3;

		// the height of the roadway at every sample; a viaduct is straight between its ends
		const heights = new Map<number, Float32Array>();
		let over = 0; // how far over the land the deck is, at most
		for (const e of edges) {
			const sm = cand.get(e)!;
			const n = sm.x.length;
			const la = local.get(net.ea[e])!;
			const lb = local.get(net.eb[e])!;
			const total = sm.s[n - 1];
			const h = new Float32Array(n);
			for (let k = 0; k < n; k++) {
				let num = 0;
				let den = 0;
				let dmin = Infinity;
				let pinned = NaN;
				for (let j = 0; j < sources.length; j++) {
					const d = Math.min(dist[j][la] + sm.s[k], dist[j][lb] + total - sm.s[k]);
					if (d < dmin) dmin = d;
					if (d < 1e-3) pinned = bank[j];
					else if (d < Infinity) {
						num += bank[j] / d;
						den += 1 / d;
					}
				}
				const base = Number.isNaN(pinned) ? (den ? num / den : 0) : pinned;
				const u = Math.min(1, dmin / RAMP);
				let d = base + (dry ? 0 : HUMP) * u * u * (3 - 2 * u);
				d = isWater(sm.x[k], sm.z[k]) ? Math.max(d, 0.12) : Math.max(d, ground(sm.x[k], sm.z[k]));
				h[k] = Math.round(d / QUANT) * QUANT;
				if (dry) over = Math.max(over, h[k] - ground(sm.x[k], sm.z[k]));
			}
			heights.set(e, h);
		}
		if (dry && over < VIADUCT) continue;

		for (const e of edges) {
			const sm = cand.get(e)!;
			const n = sm.x.length;
			const total = sm.s[n - 1];
			const h = heights.get(e)!;
			const cls = net.cls[e];
			const span: Span = {
				n,
				x: Float32Array.from(sm.x),
				z: Float32Array.from(sm.z),
				s: Float32Array.from(sm.s),
				h,
				half: WIDTH[cls] / 2 + SIDE,
				cls,
				style: cls === 3 ? 2 : style,
				dry,
				piers: [],
				arches: [],
				lamps: [],
			};
			// piers under the stretches where the girder is high over the water (or the land)
			const clear = (k: number) => h[k] - GIRDER - (isWater(sm.x[k], sm.z[k]) ? 0 : ground(sm.x[k], sm.z[k]));
			const pier = (k0: number, k1: number, t: number): Pier | null => {
				const k = Math.max(0, Math.min(n - 2, Math.floor(k0 + (k1 - k0) * t)));
				const f = k0 + (k1 - k0) * t - k;
				const x = span.x[k] + (span.x[k + 1] - span.x[k]) * f;
				const z = span.z[k] + (span.z[k + 1] - span.z[k]) * f;
				const top = h[k] + (h[k + 1] - h[k]) * f - GIRDER;
				const base = isWater(x, z) ? 0 : ground(x, z);
				if (top - base <= CLEAR) return null;
				const p = { x, z, ry: -Math.atan2(span.z[k + 1] - span.z[k], span.x[k + 1] - span.x[k]), top, base };
				span.piers.push(p);
				return p;
			};
			for (let k = 0; k < n; ) {
				if (clear(k) <= CLEAR) {
					k++;
					continue;
				}
				let end = k;
				while (end + 1 < n && clear(end + 1) > CLEAR) end++;
				const len = sm.s[end] - sm.s[k];
				if (len > 2) {
					const parts = Math.max(1, Math.round(len / PIER_GAP));
					let prev: Pier | null = null;
					for (let i = 0; i <= parts; i++) {
						// the ends stand at the bank, in the water, the others between
						if ((i === 0 && !isWater(sm.x[k], sm.z[k])) || (i === parts && !isWater(sm.x[end], sm.z[end]))) continue;
						const p = pier(k, end, i / parts);
						// a stone bridge has an arch between its piers
						if (p && prev && span.style === 0) span.arches.push({ ax: prev.x, az: prev.z, bx: p.x, bz: p.z, ry: p.ry, top: Math.min(prev.top, p.top), base: Math.max(prev.base, p.base) });
						prev = p;
					}
				}
				k = end + 1;
			}
			// lamps, one side then the other
			for (let m = 0, s = 3; s < total - 2; m++, s += LAMP_GAP) {
				let k = 0;
				while (k < n - 2 && sm.s[k + 1] < s) k++;
				const f = (s - sm.s[k]) / Math.max(1e-6, sm.s[k + 1] - sm.s[k]);
				const dx = span.x[k + 1] - span.x[k];
				const dz = span.z[k + 1] - span.z[k];
				const l = Math.hypot(dx, dz) || 1;
				span.lamps.push({ x: span.x[k] + dx * f, z: span.z[k] + dz * f, h: h[k] + (h[k + 1] - h[k]) * f, ux: dx / l, uz: dz / l, side: m % 2 ? 1 : -1 });
			}
			spans.push(span);
			net.lifted[e] = 1;
		}
	}

	// a lookup of the decks by place: the segments between the samples, in a grid of CELL
	const segs: { span: number; k: number }[] = [];
	const grid = new Map<number, number[]>();
	const byChunk = new Map<number, number[]>();
	spans.forEach((sp, si) => {
		const reach = sp.half + 3.2; // as far as `frame` looks
		let x0 = Infinity;
		let x1 = -Infinity;
		let z0 = Infinity;
		let z1 = -Infinity;
		for (let k = 0; k < sp.n - 1; k++) {
			const id = segs.length;
			segs.push({ span: si, k });
			const ax = Math.min(sp.x[k], sp.x[k + 1]) - reach;
			const bx = Math.max(sp.x[k], sp.x[k + 1]) + reach;
			const az = Math.min(sp.z[k], sp.z[k + 1]) - reach;
			const bz = Math.max(sp.z[k], sp.z[k + 1]) + reach;
			x0 = Math.min(x0, ax);
			x1 = Math.max(x1, bx);
			z0 = Math.min(z0, az);
			z1 = Math.max(z1, bz);
			for (let gx = Math.floor(ax / CELL); gx <= Math.floor(bx / CELL); gx++) {
				for (let gz = Math.floor(az / CELL); gz <= Math.floor(bz / CELL); gz++) {
					const key = gx * 100000 + gz;
					const list = grid.get(key);
					if (list) list.push(id);
					else grid.set(key, [id]);
				}
			}
		}
		for (let cx = Math.floor((x0 - 1) / 32); cx <= Math.floor((x1 + 1) / 32); cx++) {
			for (let cz = Math.floor((z0 - 1) / 32); cz <= Math.floor((z1 + 1) / 32); cz++) {
				const key = cx * 1000 + cz;
				const list = byChunk.get(key);
				if (list) list.push(si);
				else byChunk.set(key, [si]);
			}
		}
	});

	/** the nearest segment within `extra` beyond the half width of its deck: its height there, or NaN; `found` says which */
	const found = { span: -1, k: 0, t: 0 };
	function look(x: number, z: number, extra: number, viaducts = false) {
		const list = grid.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL));
		found.span = -1;
		if (!list) return NaN;
		let best = Infinity;
		let h = NaN;
		for (const id of list) {
			const { span, k } = segs[id];
			const sp = spans[span];
			if (sp.dry && !viaducts) continue;
			const ax = sp.x[k];
			const az = sp.z[k];
			const dx = sp.x[k + 1] - ax;
			const dz = sp.z[k + 1] - az;
			const l2 = dx * dx + dz * dz || 1;
			const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
			const d = Math.hypot(ax + dx * t - x, az + dz * t - z) - sp.half;
			if (d < extra && d < best) {
				best = d;
				h = sp.h[k] + (sp.h[k + 1] - sp.h[k]) * t;
				found.span = span;
				found.k = k;
				found.t = t;
			}
		}
		return h;
	}

	/** whether (x, z) is on the deck of another span than `self` (the parapet between two roadways side by side is left out) */
	function inside(x: number, z: number, self: number) {
		const list = grid.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL));
		if (!list) return false;
		for (const id of list) {
			const { span, k } = segs[id];
			if (span === self) continue;
			const sp = spans[span];
			const ax = sp.x[k];
			const az = sp.z[k];
			const dx = sp.x[k + 1] - ax;
			const dz = sp.z[k + 1] - az;
			const l2 = dx * dx + dz * dz || 1;
			const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
			if (Math.hypot(ax + dx * t - x, az + dz * t - z) < sp.half - 0.1) return true;
		}
		return false;
	}

	function drawSpan(sp: Span, si: number, cx: number, cz: number, far: boolean, add: Add, lamp: Add) {
		const st = STYLES[sp.style];
		const road = WIDTH[sp.cls];
		const wd = sp.half * 2;
		const seg = (k: number) => {
			const dx = sp.x[k + 1] - sp.x[k];
			const dz = sp.z[k + 1] - sp.z[k];
			const l = Math.hypot(dx, dz) || 1;
			return { ux: dx / l, uz: dz / l, h: Math.round((sp.h[k] + sp.h[k + 1]) / 2 / QUANT) * QUANT, in: inChunk((sp.x[k] + sp.x[k + 1]) / 2, (sp.z[k] + sp.z[k + 1]) / 2, cx, cz) };
		};
		for (let k = 0; k < sp.n - 1; ) {
			const a = seg(k);
			if (!a.in) {
				k++;
				continue;
			}
			// along as far as it runs straight at one height
			let e = k + 1;
			while (e < sp.n - 1) {
				const b = seg(e);
				if (!b.in || b.h !== a.h || b.ux * a.ux + b.uz * a.uz < 0.9995) break;
				e++;
			}
			const dx = sp.x[e] - sp.x[k];
			const dz = sp.z[e] - sp.z[k];
			const len = Math.hypot(dx, dz) + 0.05;
			const mx = (sp.x[e] + sp.x[k]) / 2;
			const mz = (sp.z[e] + sp.z[k]) / 2;
			const ry = -Math.atan2(dz, dx);
			const D = a.h;
			const bottom = Math.max(0.02, D - GIRDER);
			add(len, D + 0.015 - bottom, wd, st.slab, mx, (D + 0.015 + bottom) / 2, mz, ry);
			add(len, 0.05, road, COLOR[sp.cls], mx, D + 0.035, mz, ry);
			if (!far) {
				const pieces = Math.max(1, Math.ceil(len / 1.5));
				for (const o of [-1, 1]) {
					const off = o * (sp.half - 0.08);
					for (let q = 0; q < pieces; q++) {
						const t = ((q + 0.5) / pieces - 0.5) * len;
						const px = mx + a.ux * t - a.uz * off;
						const pz = mz + a.uz * t + a.ux * off;
						if (!inside(px, pz, si)) add(len / pieces + 0.02, 0.3, 0.16, st.rail, px, D + 0.15, pz, ry);
					}
				}
				// the shadow of the girder on the water
				const lift = D - GIRDER / 2;
				const sx = mx + lift * 0.57;
				const sz = mz - lift * 0.71;
				if (lift > 0.1 && isWater(mx, mz) && isWater(sx, sz)) add(len, 0.02, wd, SHADOW, sx, 0.05, sz, ry);
			}
			k = e;
		}
		if (far) return;
		for (const p of sp.piers) {
			if (!inChunk(p.x, p.z, cx, cz)) continue;
			const hp = p.top - p.base;
			add(1.0, hp, wd + 0.5, st.pier, p.x, p.base + hp / 2, p.z, p.ry);
		}
		for (const a of sp.arches) {
			const mx = (a.ax + a.bx) / 2;
			const mz = (a.az + a.bz) / 2;
			if (!inChunk(mx, mz, cx, cz)) continue;
			const G = Math.hypot(a.bx - a.ax, a.bz - a.az);
			const g = G - 1.0; // between the faces of the piers
			const rise = Math.min(a.top - a.base - 0.05, g * 0.45);
			if (rise < 0.3) continue;
			const ux = (a.bx - a.ax) / G;
			const uz = (a.bz - a.az) / G;
			const steps = 3;
			const t = rise / steps;
			for (let k = 0; k < steps; k++) {
				// the opening of the arch at this depth under the girder; the rest is stone, reaching in from each pier
				const open = g * Math.sqrt(Math.max(0, 1 - ((rise - k * t) / rise) ** 2));
				const reach = (g - open) / 2;
				if (reach < 0.05) continue;
				const y = a.top - (k + 0.5) * t;
				add(reach, t, wd - 0.1, st.pier, a.ax + ux * (0.5 + reach / 2), y, a.az + uz * (0.5 + reach / 2), a.ry);
				add(reach, t, wd - 0.1, st.pier, a.bx - ux * (0.5 + reach / 2), y, a.bz - uz * (0.5 + reach / 2), a.ry);
			}
		}
		for (const l of sp.lamps) {
			if (!inChunk(l.x, l.z, cx, cz)) continue;
			// the post stands on the edge of the pavement
			const off = l.side * (sp.half - 0.08);
			const px = l.x - l.uz * off;
			const pz = l.z + l.ux * off;
			if (inside(px, pz, si)) continue;
			add(0.09, 1.0, 0.09, COLORS.dark, px, l.h + 0.5, pz);
			lamp(0.24, 0.24, 0.24, COLORS.lit, px, l.h + 1.08, pz);
		}
	}

	return {
		deckAt: (x, z, viaducts = false) => look(x, z, 0.1, viaducts),
		covers: (x, z) => !Number.isNaN(look(x, z, COVER)),
		frame(x, z) {
			if (Number.isNaN(look(x, z, 3))) return null;
			const sp = spans[found.span];
			const { k, t } = found;
			const dx = sp.x[k + 1] - sp.x[k];
			const dz = sp.z[k + 1] - sp.z[k];
			const l = Math.hypot(dx, dz) || 1;
			return { x: sp.x[k] + dx * t, z: sp.z[k] + dz * t, ux: dx / l, uz: dz / l, h: sp.h[k] + (sp.h[k + 1] - sp.h[k]) * t };
		},
		boxes(cx, cz, far, add, lamp) {
			for (const si of byChunk.get(cx * 1000 + cz) ?? []) drawSpan(spans[si], si, cx, cz, far, add, lamp);
		},
	};
}

const TRUSS = 0x7b8696;

/**
 * a piece of a railway bridge: a steel girder under the bed, a truss along each side, and its shadow on the water.
 * (x, z) is the middle of the piece, `len` its length along `ry`, `h` the height of the bed.
 */
export function railDeck(add: Add, isWater: (x: number, z: number) => boolean, x: number, z: number, len: number, h: number, ry: number, far: boolean) {
	add(len + 0.05, 0.5, 2.0, COLORS.steel, x, h + 0.03 - 0.25, z, ry);
	if (far) return;
	const ux = Math.cos(-ry);
	const uz = Math.sin(-ry);
	const lift = h - 0.2;
	if (lift > 0.1 && isWater(x + lift * 0.57, z - lift * 0.71)) add(len + 0.05, 0.02, 2.2, SHADOW, x + lift * 0.57, 0.05, z - lift * 0.71, ry);
	for (const side of [-0.95, 0.95]) {
		const gx = x - uz * side;
		const gz = z + ux * side;
		add(len + 0.05, 0.12, 0.14, TRUSS, gx, h + 0.1, gz, ry); // the lower chord, beside the rails
		add(len + 0.05, 0.1, 0.16, TRUSS, gx, h + 0.75, gz, ry); // the upper one
		const n = Math.max(1, Math.round(len / 1.1));
		for (let k = 0; k < n; k++) {
			const t = (k + 0.5) * (len / n) - len / 2;
			add(0.09, 0.7, 0.12, TRUSS, gx + ux * t, h + 0.4, gz + uz * t, ry); // the posts
		}
	}
}

/** how far apart the stone piers of a railway bridge stand */
export const RAIL_PIER_GAP = 6;

/** a stone pier under the girder of a railway bridge, at (x, z), the bed being `h` high */
export function railPier(add: Add, x: number, z: number, h: number, ry: number) {
	const top = h - 0.47;
	if (top > 0.15) add(1.1, top, 2.6, STYLES[0].pier, x, top / 2, z, ry);
}
