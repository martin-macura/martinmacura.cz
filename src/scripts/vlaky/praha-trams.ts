// The trams and the trains of Prague by the real timetable (scripts/praha/bake_trams.py -> praha-tram.dat and
// praha-rail.dat): every one that runs now, by the clock of Prague, is where the timetable puts it, on the line it
// runs on. Nothing is live: it is the plan, so a late tram in the street is on time here. The tracks, the stops and
// the stations are drawn into the chunks. Timetable: PID / ROPID (CC BY 4.0).
import { InstancedMesh, Mesh, MeshBasicMaterial, MeshLambertMaterial, Object3D, type Scene } from "three";
import { inChunk, walkSegment } from "./praha-roads";
import { createLamps } from "./praha-traffic";
import { COLORS, glass, unit } from "./util";
import type { Card, Extras, Focus, Place, ToScreen } from "./world";

const CH = 32;
const M = 6; // metres in a unit

/** what runs on the lines, and what its track looks like */
export interface LineStyle {
	rail: boolean; // a railway (ballast, sleepers, stations with names) or a tramway (rails in the street, stops)
	sections: number;
	section: number; // units
	width: number;
	height: number;
	body: number;
	roof: number;
	max: number; // at most this many at once
	title: string; // on the card of one
	places: boolean; // its stops have their names written over the scene
	hidden?: boolean; // seen only where its track is laid (the metro, out of its tunnels)
}
export const TRAM: LineStyle = { rail: false, sections: 3, section: 1.7, width: 0.46, height: 0.5, body: 0xd8322a, roof: 0xf2ead8, max: 900, title: "TRAMVAJ", places: true };
/** a CityElefant: four double-deck cars of about 20 m */
export const TRAIN: LineStyle = { rail: true, sections: 4, section: 3.3, width: 0.62, height: 0.78, body: 0x2f62c8, roof: 0xf2f2f2, max: 300, title: "VLAK", places: true };
/** an articulated bus of 18 m, in the streets with the cars */
export const BUS: LineStyle = { rail: false, sections: 2, section: 1.5, width: 0.44, height: 0.5, body: 0xb8262c, roof: 0xd9dde2, max: 1500, title: "AUTOBUS", places: false };
/** a train of five cars of the metro, silver and blue, seen where it comes out of the ground */
export const METRO: LineStyle = { rail: true, sections: 5, section: 3.2, width: 0.6, height: 0.62, body: 0xa9b4bf, roof: 0x2f4a7a, max: 80, title: "METRO", places: true, hidden: true };

/** whether (x, z) is within `r` of a track of the line */
export function nearTrack(data: TramData, r = 1) {
	const { tx, tz, trackByChunk } = data;
	return (x: number, z: number) => {
		for (const i of trackByChunk.get(Math.floor(x / CH) * 1000 + Math.floor(z / CH)) ?? []) {
			const ax = tx[i];
			const az = tz[i];
			const dx = tx[i + 1] - ax;
			const dz = tz[i + 1] - az;
			const l2 = dx * dx + dz * dz || 1;
			const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
			if ((ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2 < r * r) return true;
		}
		return false;
	};
}

export interface TramData {
	routes: string[];
	/** the names of the stops and of where the trips go */
	names: string[];
	/** the rails, each street once: segments as indexes of their first point in tx/tz, by chunk */
	tx: Float32Array;
	tz: Float32Array;
	trackByChunk: Map<number, number[]>;
	stops: { x: number; z: number; heading: number; name: number }[];
	stopsByChunk: Map<number, number[]>;
	/** the names of the stations */
	labels: { x: number; z: number; name: string }[];
	/** shape s has points sx/sz/sm[shapeStart[s] .. shapeStart[s + 1]); sm is metres along it */
	shapeStart: Uint32Array;
	sx: Float32Array;
	sz: Float32Array;
	sm: Float32Array;
	/** pattern p: its route, its shape, its stops (arrival, departure in seconds after the start, metres) */
	/** pattern p: its route, its shape, where it goes, its stops (arrival, departure in seconds after the start, metres, stop + 1) */
	patterns: { route: number; shape: number; headsign: number; arr: Uint32Array; dep: Uint32Array; m: Float32Array; stop: Uint32Array }[];
	/** trips sorted by start: seconds after midnight, pattern, day mask (1 working day, 2 Saturday, 4 Sunday) */
	tripStart: Uint32Array;
	tripPattern: Uint32Array;
	tripMask: Uint8Array;
	longest: number; // the longest trip, in seconds
}

const bucket = (map: Map<number, number[]>, x0: number, z0: number, x1: number, z1: number, pad: number, i: number) => {
	for (let cx = Math.floor((Math.min(x0, x1) - pad) / CH); cx <= Math.floor((Math.max(x0, x1) + pad) / CH); cx++) {
		for (let cz = Math.floor((Math.min(z0, z1) - pad) / CH); cz <= Math.floor((Math.max(z0, z1) + pad) / CH); cz++) {
			const key = cx * 1000 + cz;
			const list = map.get(key);
			if (list) list.push(i);
			else map.set(key, [i]);
		}
	}
};

export function parseTrams(buf: ArrayBuffer): TramData {
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
	const routes: string[] = [];
	for (let n = uv(); n > 0; n--) {
		const len = uv();
		routes.push(String.fromCharCode(...b.subarray(o, o + len)));
		o += len;
	}
	const utf8 = new TextDecoder();
	const names: string[] = [];
	for (let n = uv(); n > 0; n--) {
		const len = uv();
		names.push(utf8.decode(b.subarray(o, o + len)));
		o += len;
	}
	// rails: a NaN between two tracks, so that no segment joins them
	const txs: number[] = [];
	const tzs: number[] = [];
	for (let n = uv(); n > 0; n--) {
		let x = 0;
		let z = 0;
		for (let k = uv(); k > 0; k--) {
			x += sv();
			z += sv();
			txs.push(x / 4);
			tzs.push(z / 4);
		}
		txs.push(NaN);
		tzs.push(NaN);
	}
	const tx = Float32Array.from(txs);
	const tz = Float32Array.from(tzs);
	const trackByChunk = new Map<number, number[]>();
	for (let i = 0; i < tx.length - 1; i++) if (!Number.isNaN(tx[i]) && !Number.isNaN(tx[i + 1])) bucket(trackByChunk, tx[i], tz[i], tx[i + 1], tz[i + 1], 1, i);

	const stops: TramData["stops"] = [];
	const stopsByChunk = new Map<number, number[]>();
	{
		let x = 0;
		let z = 0;
		for (let n = uv(); n > 0; n--) {
			x += sv();
			z += sv();
			const heading = (uv() / 64) * Math.PI * 2;
			const s = { x: x / 4, z: z / 4, heading, name: uv() };
			bucket(stopsByChunk, s.x, s.z, s.x, s.z, 0, stops.length);
			stops.push(s);
		}
	}

	const labels: TramData["labels"] = [];
	{
		let x = 0;
		let z = 0;
		for (let n = uv(); n > 0; n--) {
			x += sv();
			z += sv();
			const len = uv();
			labels.push({ x: x / 4, z: z / 4, name: String.fromCharCode(...b.subarray(o, o + len)) });
			o += len;
		}
	}

	const ns = uv();
	const shapeStart = new Uint32Array(ns + 1);
	const xs: number[] = [];
	const zs: number[] = [];
	const ms: number[] = [];
	for (let s = 0; s < ns; s++) {
		shapeStart[s] = xs.length;
		let x = 0;
		let z = 0;
		let m = 0;
		for (let k = uv(); k > 0; k--) {
			x += sv();
			z += sv();
			m += sv();
			xs.push(x / 4);
			zs.push(z / 4);
			ms.push(Math.max(m, ms.length > shapeStart[s] ? ms[ms.length - 1] : 0));
		}
	}
	shapeStart[ns] = xs.length;

	const patterns: TramData["patterns"] = [];
	for (let n = uv(); n > 0; n--) {
		const route = uv();
		const shape = uv();
		const headsign = uv();
		const k = uv();
		const arr = new Uint32Array(k);
		const dep = new Uint32Array(k);
		const m = new Float32Array(k);
		const stop = new Uint32Array(k);
		for (let i = 0; i < k; i++) {
			arr[i] = uv();
			dep[i] = arr[i] + uv();
			m[i] = uv();
			stop[i] = uv();
		}
		patterns.push({ route, shape, headsign, arr, dep, m, stop });
	}
	const nt = uv();
	const tripStart = new Uint32Array(nt);
	const tripPattern = new Uint32Array(nt);
	const tripMask = new Uint8Array(nt);
	let t = 0;
	let longest = 0;
	for (let i = 0; i < nt; i++) {
		t += uv();
		tripStart[i] = t;
		tripPattern[i] = uv();
		tripMask[i] = uv();
		const p = patterns[tripPattern[i]];
		longest = Math.max(longest, p.arr[p.arr.length - 1]);
	}
	return {
		routes,
		names,
		tx,
		tz,
		trackByChunk,
		stops,
		stopsByChunk,
		labels,
		shapeStart,
		sx: Float32Array.from(xs),
		sz: Float32Array.from(zs),
		sm: Float32Array.from(ms),
		patterns,
		tripStart,
		tripPattern,
		tripMask,
		longest,
	};
}

/**
 * the height of a railway: the terrain is in steps of 8 m, which a train cannot climb, so along every track the hills
 * narrower than some 1.2 km are taken away, the rest averaged over some 150 m and the grade held to 2 %; a station
 * stays on its land and a bridge above the water. Where the land then lies higher the track runs
 * in a tunnel (the hill hides it), where it lies lower on an embankment, and over the water on a bridge. Returns the
 * height of the bed near (x, z), or NaN away from the railway.
 */
export function railProfile(data: TramData, terrain: (x: number, z: number) => number, isWater: (x: number, z: number) => boolean) {
	const GRADE = 0.012; // height units per unit along: 2 %
	const WINDOW = 25; // samples to each side, for the average
	const HILL = 100; // samples to each side: a hill narrower than twice this (some 1.2 km) is gone through, not over
	const BRIDGE = 0.5; // the least height over the water
	// the stations: a train stands at one on the land, never in a tunnel
	const stations = new Map<number, [number, number][]>();
	const skey = (x: number, z: number) => Math.floor(x / 16) * 100000 + Math.floor(z / 16);
	for (const st of data.stops) {
		const k = skey(st.x, st.z);
		const list = stations.get(k);
		if (list) list.push([st.x, st.z]);
		else stations.set(k, [[st.x, st.z]]);
	}
	const atStation = (x: number, z: number) => {
		for (let a = -1; a <= 1; a++) {
			for (let b = -1; b <= 1; b++) {
				for (const [sx, sz] of stations.get(skey(x + a * 16, z + b * 16)) ?? []) if ((sx - x) ** 2 + (sz - z) ** 2 < 64) return true;
			}
		}
		return false;
	};
	/** the least or the most of `v` within `w` to each side, for every index */
	const slide = (v: number[], w: number, most: boolean) =>
		v.map((_, k) => {
			let r = most ? -Infinity : Infinity;
			for (let j = Math.max(0, k - w); j <= Math.min(v.length - 1, k + w); j++) r = most ? Math.max(r, v[j]) : Math.min(r, v[j]);
			return r;
		});
	const cells = new Map<number, number[]>(); // x, z, height of the samples in each cell of 2 x 2
	const key = (x: number, z: number) => (Math.floor(x / 2) + 5000) * 10000 + Math.floor(z / 2) + 5000;
	const { tx, tz } = data;
	let from = 0;
	for (let i = 0; i <= tx.length; i++) {
		if (i < tx.length && !Number.isNaN(tx[i])) continue;
		// one track: tx[from .. i), sampled every unit
		const xs: number[] = [];
		const zs: number[] = [];
		for (let k = from; k < i - 1; k++) {
			const len = Math.hypot(tx[k + 1] - tx[k], tz[k + 1] - tz[k]);
			const n = Math.max(1, Math.ceil(len));
			for (let j = 0; j < n; j++) {
				xs.push(tx[k] + ((tx[k + 1] - tx[k]) * j) / n);
				zs.push(tz[k] + ((tz[k + 1] - tz[k]) * j) / n);
			}
		}
		if (i - from > 0) {
			xs.push(tx[i - 1]);
			zs.push(tz[i - 1]);
		}
		from = i + 1;
		const n = xs.length;
		if (!n) continue;
		const raw = xs.map((x, k) => terrain(x, zs[k]));
		// the hills narrower than a tunnel taken away (the least land around, then the most of that: a plateau stays),
		// then a running average
		const t = slide(slide(raw, HILL, false), HILL, true);
		const pre = [0];
		for (let k = 0; k < n; k++) pre.push(pre[k] + t[k]);
		const h = t.map((_, k) => {
			const a = Math.max(0, k - WINDOW);
			const b = Math.min(n, k + WINDOW + 1);
			return (pre[b] - pre[a]) / (b - a);
		});
		// the grade held both ways
		for (let k = 1; k < n; k++) h[k] = Math.min(Math.max(h[k], h[k - 1] - GRADE), h[k - 1] + GRADE);
		for (let k = n - 2; k >= 0; k--) h[k] = Math.min(Math.max(h[k], h[k + 1] - GRADE), h[k + 1] + GRADE);
		// a station stands on its land and a bridge above the water; the track rises to them at the same grade
		for (let k = 0; k < n; k++) {
			if (isWater(xs[k], zs[k])) h[k] = Math.max(h[k], BRIDGE);
			else if (atStation(xs[k], zs[k])) h[k] = Math.max(h[k], raw[k]);
		}
		for (let k = 1; k < n; k++) h[k] = Math.max(h[k], h[k - 1] - GRADE);
		for (let k = n - 2; k >= 0; k--) h[k] = Math.max(h[k], h[k + 1] - GRADE);
		for (let k = 0; k < n; k++) {
			const c = key(xs[k], zs[k]);
			const list = cells.get(c);
			// quantized, so that the boxes along a gentle slope still merge into runs
			const v = Math.round(h[k] * 20) / 20;
			if (list) list.push(xs[k], zs[k], v);
			else cells.set(c, [xs[k], zs[k], v]);
		}
	}
	// the height at a point: the mean of the tracks within 1.5 units, so that tracks side by side (profiled each on its
	// own, some of them short) lie at one height; else the nearest within two units
	return (x: number, z: number) => {
		let best = 4;
		let v = NaN;
		let sum = 0;
		let n = 0;
		const gx = Math.floor(x / 2);
		const gz = Math.floor(z / 2);
		for (let a = -1; a <= 1; a++) {
			for (let b = -1; b <= 1; b++) {
				const list = cells.get((gx + a + 5000) * 10000 + gz + b + 5000);
				if (!list) continue;
				for (let k = 0; k < list.length; k += 3) {
					const d = (list[k] - x) ** 2 + (list[k + 1] - z) ** 2;
					if (d < 2.25) {
						sum += list[k + 2];
						n++;
					}
					if (d < best) {
						best = d;
						v = list[k + 2];
					}
				}
			}
		}
		return n ? Math.round((sum / n) * 20) / 20 : v;
	};
}

/**
 * the tracks and the stops of chunk (cx, cz). A tramway is a pair of rails in the street; a railway is ballast with
 * sleepers and rails, a steel deck over the water, and a station is a platform on each side of the track. Far away
 * only the ballast is drawn, so that the railway still shows through the whole city.
 */
export function lineBoxes(
	data: TramData,
	style: LineStyle,
	cx: number,
	cz: number,
	far: boolean,
	ground: (x: number, z: number) => number,
	isWater: (x: number, z: number) => boolean,
	skip: (x: number, z: number) => boolean,
	add: (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry?: number) => void,
	/** a railway: the height of its bed (railProfile) */
	bed?: (x: number, z: number) => number,
) {
	const { tx, tz } = data;
	if (far && !style.rail) return;
	// a tramway stops at the water (the bridge carries the street); a railway crosses it on a deck of its own
	const tramSkip = (x: number, z: number) => isWater(x, z) || skip(x, z);
	const railGround = (x: number, z: number) => {
		const h = bed ? bed(x, z) : NaN;
		return Number.isNaN(h) ? ground(x, z) : h;
	};
	// in a tunnel: the hill stands well above the bed
	const railSkip = (x: number, z: number) => skip(x, z) || ground(x, z) > railGround(x, z) + 0.7;
	for (const i of data.trackByChunk.get(cx * 1000 + cz) ?? []) {
		const dx = tx[i + 1] - tx[i];
		const dz = tz[i + 1] - tz[i];
		const len = Math.hypot(dx, dz) || 1;
		const side = (o: number) => [(-dz / len) * o, (dx / len) * o];
		if (!style.rail) {
			walkSegment(tx[i], tz[i], tx[i + 1], tz[i + 1], cx, cz, ground, tramSkip, (x, z, l, h, ry) => add(l + 0.05, 0.05, 0.8, 0x4a4743, x, h + 0.05, z, ry));
			for (const o of [-0.24, 0.24]) {
				const [ox, oz] = side(o);
				walkSegment(tx[i] + ox, tz[i] + oz, tx[i + 1] + ox, tz[i + 1] + oz, cx, cz, ground, tramSkip, (x, z, l, h, ry) => add(l + 0.05, 0.03, 0.06, 0x9aa3ad, x, h + 0.09, z, ry));
			}
			continue;
		}
		walkSegment(tx[i], tz[i], tx[i + 1], tz[i + 1], cx, cz, railGround, railSkip, (x, z, l, h, ry) => {
			if (isWater(x, z)) add(l + 0.05, 0.25, 1.8, COLORS.steel, x, h - 0.1, z, ry); // the deck of a bridge
			else {
				// an embankment where the land lies lower than the bed
				const g = ground(x, z);
				if (h > g + 0.1) add(l + 0.05, h - g, far ? 2.8 : 2.2, 0x8a7a5c, x, g + (h - g) / 2, z, ry);
				// from afar a wide steel band, so that it reads among the dark streets
				if (far) add(l + 0.05, 0.14, 2.8, 0x8f9aa8, x, h + 0.07, z, ry);
				else add(l + 0.05, 0.12, 1.6, COLORS.ballast, x, h + 0.06, z, ry);
			}
			if (far) return;
			// sleepers across, about every 0.7 units
			const n = Math.max(1, Math.round(l / 0.7));
			const ux = Math.cos(-ry);
			const uz = Math.sin(-ry);
			for (let k = 0; k < n; k++) {
				const t = (k + 0.5) * (l / n) - l / 2;
				add(0.16, 0.05, 1.25, COLORS.wood, x + ux * t, h + 0.14, z + uz * t, ry);
			}
		});
		if (far) continue;
		for (const o of [-0.42, 0.42]) {
			const [ox, oz] = side(o);
			walkSegment(tx[i] + ox, tz[i] + oz, tx[i + 1] + ox, tz[i + 1] + oz, cx, cz, railGround, railSkip, (x, z, l, h, ry) => add(l + 0.05, 0.09, 0.09, COLORS.steel, x, h + 0.2, z, ry));
		}
	}
	if (far) return;
	for (const i of data.stopsByChunk.get(cx * 1000 + cz) ?? []) {
		const s = data.stops[i];
		if (!inChunk(s.x, s.z, cx, cz) || skip(s.x, s.z)) continue;
		const ry = -s.heading;
		const c = Math.cos(s.heading);
		const sn = Math.sin(s.heading);
		if (!style.rail) {
			// a platform with a shelter on it
			const h = ground(s.x, s.z);
			add(2, 0.12, 0.45, 0xb9b09c, s.x, h + 0.08, s.z, ry);
			for (const t of [-0.35, 0.35]) add(0.06, 0.55, 0.06, 0x14161c, s.x + c * t, h + 0.42, s.z + sn * t, ry);
			add(0.95, 0.06, 0.4, 0xc23b2f, s.x, h + 0.72, s.z, ry);
			continue;
		}
		// a station: a platform on each side, with a yellow edge and a roof over its middle
		for (const o of [-1.55, 1.55]) {
			const px = s.x - sn * o;
			const pz = s.z + c * o;
			const h = railGround(s.x, s.z);
			const g = ground(px, pz);
			if (h > g + 0.05) add(14, h - g, 1.3, COLORS.platform, px, g + (h - g) / 2, pz, ry);
			add(14, 0.35, 1.3, COLORS.platform, px, h + 0.17, pz, ry);
			add(14, 0.36, 0.1, COLORS.yellow, px - sn * -Math.sign(o) * 0.6, h + 0.18, pz + c * -Math.sign(o) * 0.6, ry);
			for (const t of [-3, 0, 3]) add(0.1, 1.2, 0.1, COLORS.dark, px + c * t + sn * Math.sign(o) * 0.3, h + 0.9, pz + sn * t - c * Math.sign(o) * 0.3, ry);
			add(7.5, 0.1, 1.1, 0x5a6470, px, h + 1.5, pz, ry);
		}
	}
}

/** the seconds since midnight in Prague, and what kind of day it is there (1 working day, 2 Saturday, 4 Sunday) */
const pragueClock = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Prague", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const KIND: Record<string, number> = { Mon: 1, Tue: 1, Wed: 1, Thu: 1, Fri: 1, Sat: 2, Sun: 4 };
const BEFORE: Record<string, number> = { Mon: 4, Tue: 1, Wed: 1, Thu: 1, Fri: 1, Sat: 1, Sun: 2 };
function prague(now: number) {
	const parts: Record<string, string> = {};
	for (const p of pragueClock.formatToParts(now)) parts[p.type] = p.value;
	const secs = +parts.hour * 3600 + +parts.minute * 60 + +parts.second + (now % 1000) / 1000;
	return { secs, today: KIND[parts.weekday] ?? 1, yesterday: BEFORE[parts.weekday] ?? 1 };
}

export function createTrams(scene: Scene, data: TramData, style: LineStyle, groundAt: (x: number, z: number) => number): Extras {
	const { tripStart, tripPattern, tripMask, patterns, shapeStart, sx, sz, sm } = data;

	// what runs now: looked up again every few seconds; a trip is [start, start + its length]
	let active: { trip: number; offset: number }[] = [];
	let lookedAt = -Infinity;
	function refresh(now: number) {
		const { secs, today, yesterday } = prague(now);
		active = [];
		for (const [t, mask, offset] of [[secs, today, 0], [secs + 86400, yesterday, 86400]] as const) {
			// the trips that started in the last `longest` seconds
			let lo = 0;
			let hi = tripStart.length;
			while (lo < hi) {
				const m = (lo + hi) >> 1;
				if (tripStart[m] < t - data.longest) lo = m + 1;
				else hi = m;
			}
			for (let i = lo; i < tripStart.length && tripStart[i] <= t; i++) {
				if (!(tripMask[i] & mask)) continue;
				const p = patterns[tripPattern[i]];
				if (t - tripStart[i] <= p.arr[p.arr.length - 1]) active.push({ trip: i, offset });
			}
		}
	}

	/** metres along its shape of a trip `tau` seconds after it started: standing at a stop, or easing between two */
	function metresAt(p: TramData["patterns"][number], tau: number) {
		const { arr, dep, m } = p;
		let i = 0;
		while (i < arr.length - 1 && arr[i + 1] <= tau) i++;
		if (tau <= dep[i] || i === arr.length - 1) return m[i];
		const f = Math.min(1, (tau - dep[i]) / Math.max(1, arr[i + 1] - dep[i]));
		return m[i] + (m[i + 1] - m[i]) * f * f * (3 - 2 * f);
	}

	/** the point of shape s at metres `metres` */
	const at = { x: 0, z: 0, dx: 1, dz: 0 };
	function onShape(s: number, metres: number) {
		let lo = shapeStart[s];
		let hi = shapeStart[s + 1] - 2;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (sm[mid] <= metres) lo = mid;
			else hi = mid - 1;
		}
		const span = sm[lo + 1] - sm[lo];
		const f = span > 0 ? Math.min(1, Math.max(0, (metres - sm[lo]) / span)) : 0;
		const dx = sx[lo + 1] - sx[lo];
		const dz = sz[lo + 1] - sz[lo];
		const l = Math.hypot(dx, dz) || 1;
		at.x = sx[lo] + dx * f;
		at.z = sz[lo] + dz * f;
		at.dx = dx / l;
		at.dz = dz / l;
	}

	const { sections, section, width, height, max } = style;
	const bodies = new InstancedMesh(unit, new MeshLambertMaterial({ color: style.body }), max * sections);
	const windows = new InstancedMesh(unit, glass, max * sections);
	const roofs = new InstancedMesh(unit, new MeshLambertMaterial({ color: style.roof }), max * sections);
	for (const m of [bodies, windows, roofs]) {
		m.frustumCulled = false;
		m.userData.dynamic = true;
		m.count = 0;
		scene.add(m);
	}
	const dummy = new Object3D();
	let focus: Focus | null = null;
	const lamps = createLamps(scene, max);
	const seen = style.hidden ? nearTrack(data) : () => true;

	// the vehicles drawn in the last frame, by the middle of their middle car, for picking one by a click
	const drawn: { trip: number; offset: number; x: number; y: number; z: number }[] = [];
	let picked: { trip: number; offset: number } | null = null;
	let pickedAt: { x: number; y: number; z: number } | null = null;
	// the picked one has a yellow diamond over it
	const marker = new Mesh(unit, new MeshBasicMaterial({ color: COLORS.yellow }));
	marker.userData.dynamic = true;
	marker.visible = false;
	scene.add(marker);
	const clock = (secs: number) => {
		const t = ((Math.round(secs / 60) % 1440) + 1440) % 1440;
		return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
	};
	const stopName = (p: TramData["patterns"][number], i: number) => {
		const s = p.stop[i];
		return s ? data.names[data.stops[s - 1].name] : "";
	};

	// the names of the stations (or the stops): one in the middle of the platforms of the same name, unless they lie apart
	const places: Place[] = [];
	if (style.places) {
		const groups: { name: string; x: number; z: number; n: number }[] = [];
		for (const st of data.stops) {
			// "Praha hlavní nádraží" is Hlavní nádraží here, "Praha-Libeň" Libeň
			let name = data.names[st.name].replace(/^Praha[- ]/, "").replace(/ nádr\.$/, " nádraží");
			name = name[0].toUpperCase() + name.slice(1);
			const g = groups.find((g) => g.name === name && Math.hypot(g.x / g.n - st.x, g.z / g.n - st.z) < 25);
			if (g) {
				g.x += st.x;
				g.z += st.z;
				g.n++;
			} else groups.push({ name, x: st.x, z: st.z, n: 1 });
		}
		for (const g of groups) {
			const x = g.x / g.n;
			const z = g.z / g.n;
			if (!seen(x, z)) continue;
			places.push({ x, y: groundAt(x, z) + (style.rail ? 1.6 : 0.8), z, name: g.name, rank: style.rail ? 0 : 1 });
		}
	}

	return {
		simulate(_dt, f) {
			focus = f;
		},
		pose() {
			if (!focus) return;
			const now = Date.now();
			if (now - lookedAt > 5000) {
				lookedAt = now;
				refresh(now);
			}
			const { secs } = prague(now);
			const reach = focus.r * 1.3;
			let n = 0;
			const lit = lamps.begin();
			drawn.length = 0;
			pickedAt = null;
			for (const { trip, offset } of active) {
				if (n >= max * sections) break;
				const p = patterns[tripPattern[trip]];
				const tau = secs + offset - tripStart[trip];
				if (tau < 0 || tau > p.arr[p.arr.length - 1]) continue;
				const front = metresAt(p, tau);
				// a regional train out of the map, where its shape was cut off, is not drawn
				const first = sm[shapeStart[p.shape]];
				const last = sm[shapeStart[p.shape + 1] - 1];
				if (front < first || front > last) continue;
				onShape(p.shape, front);
				if (Math.abs(at.x - focus.x) > reach || Math.abs(at.z - focus.z) > reach) continue;
				for (let k = 0; k < sections; k++) {
					const m = Math.max(first, front - (k + 0.5) * section * M);
					onShape(p.shape, m);
					if (!seen(at.x, at.z)) continue; // this car is still in the tunnel
					// over the water a train runs on the deck of its bridge
					const y = groundAt(at.x, at.z) + (style.rail ? 0.2 : 0);
					const yaw = Math.atan2(at.dx, at.dz);
					dummy.rotation.set(0, yaw, 0);
					dummy.position.set(at.x, y + 0.05 + height / 2, at.z);
					dummy.scale.set(width, height, section - 0.08);
					dummy.updateMatrix();
					bodies.setMatrixAt(n, dummy.matrix);
					dummy.position.y = y + 0.05 + height * 0.62;
					dummy.scale.set(width + 0.02, height * 0.3, section - 0.3);
					dummy.updateMatrix();
					windows.setMatrixAt(n, dummy.matrix);
					dummy.position.y = y + 0.05 + height + 0.04;
					dummy.scale.set(width - 0.04, 0.08, section - 0.2);
					dummy.updateMatrix();
					roofs.setMatrixAt(n, dummy.matrix);
					if (k === sections >> 1) drawn.push({ trip, offset, x: at.x, y: y + height / 2, z: at.z });
					// the headlights on the first car, the tail lights on the last
					if (lit && (k === 0 || k === sections - 1)) lamps.put(at.x, y + 0.05 + height * 0.25, at.z, at.dx, at.dz, section / 2 - 0.02, width * 0.32, (k === 0 ? 1 : 0) | (k === sections - 1 ? 2 : 0));
					n++;
				}
			}
			lamps.end();
			if (picked) {
				const d = drawn.find((v) => v.trip === picked!.trip && v.offset === picked!.offset);
				if (d) {
					pickedAt = d;
					marker.position.set(d.x, d.y + height / 2 + 0.9 + Math.sin(now / 250) * 0.15, d.z);
					marker.rotation.set(Math.PI / 4, now / 600, Math.PI / 4);
					marker.scale.setScalar(0.45);
				}
			}
			marker.visible = !!pickedAt;
			for (const m of [bodies, windows, roofs]) {
				m.count = n;
				m.instanceMatrix.needsUpdate = true;
			}
		},
		places: () => places,
		pick(toScreen: ToScreen, px: number, py: number) {
			let best: (typeof drawn)[number] | null = null;
			let dist = 22; // CSS pixels: a vehicle is small, the finger is not
			for (const v of drawn) {
				const [sx, sy] = toScreen(v.x, v.y, v.z);
				const d = Math.hypot(sx - px, sy - py);
				if (d < dist) {
					dist = d;
					best = v;
				}
			}
			if (!best) return null;
			const chosen = best;
			return { dist, select: () => void (picked = { trip: chosen.trip, offset: chosen.offset }) };
		},
		unselect() {
			picked = null;
		},
		card(): Card | null {
			if (!picked || !pickedAt) return null;
			const p = patterns[tripPattern[picked.trip]];
			const start = tripStart[picked.trip] - picked.offset; // seconds after today's midnight
			const tau = prague(Date.now()).secs - start;
			if (tau > p.arr[p.arr.length - 1]) {
				picked = null; // it has arrived
				return null;
			}
			// the stop it stands at or the last one it left, and the next one it stops at (on the map, with a name)
			let i = 0;
			while (i < p.arr.length - 1 && p.arr[i + 1] <= tau) i++;
			const standing = tau <= p.dep[i];
			let next = i + 1;
			while (next < p.arr.length && !p.stop[next]) next++;
			const lines = [`směr: ${data.names[p.headsign]}`];
			if (standing && stopName(p, i)) lines.push(`stojí: ${stopName(p, i)}, odjede ${clock(start + p.dep[i])}`);
			else if (stopName(p, i)) lines.push(`odjel: ${stopName(p, i)}`);
			if (next < p.arr.length) lines.push(`příští: ${stopName(p, next)} v ${clock(start + p.arr[next])}`);
			const last = p.arr.length - 1;
			if (stopName(p, last) && next !== last) lines.push(`konečná v ${clock(start + p.arr[last])}`);
			return { ...pickedAt, title: `${style.title} ${data.routes[p.route]}`, lines };
		},
	};
}
