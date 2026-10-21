// The trams of Prague by the real timetable (scripts/praha/bake_trams.py -> praha-tram.dat): every tram that runs
// now, by the clock of Prague, is where the timetable puts it, on the line it runs on. Nothing is live: it is the plan,
// so a late tram in the street is on time here. The rails and the stops are drawn into the chunks.
// Timetable: PID / ROPID (CC BY 4.0).
import { InstancedMesh, MeshLambertMaterial, Object3D, type Scene } from "three";
import { inChunk, walkSegment } from "./praha-roads";
import { glass, unit } from "./util";
import type { Extras, Focus } from "./world";

const CH = 32;
const M = 6; // metres in a unit
const SECTIONS = 3;
const SECTION = 1.7; // units
const MAX = 900;

export interface TramData {
	routes: string[];
	/** the rails, each street once: segments as indexes of their first point in tx/tz, by chunk */
	tx: Float32Array;
	tz: Float32Array;
	trackByChunk: Map<number, number[]>;
	stops: { x: number; z: number; heading: number }[];
	stopsByChunk: Map<number, number[]>;
	/** shape s has points sx/sz/sm[shapeStart[s] .. shapeStart[s + 1]); sm is metres along it */
	shapeStart: Uint32Array;
	sx: Float32Array;
	sz: Float32Array;
	sm: Float32Array;
	/** pattern p: its route, its shape, its stops (arrival, departure in seconds after the start, metres) */
	patterns: { route: number; shape: number; arr: Uint32Array; dep: Uint32Array; m: Float32Array }[];
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
			const s = { x: x / 4, z: z / 4, heading: (uv() / 64) * Math.PI * 2 };
			bucket(stopsByChunk, s.x, s.z, s.x, s.z, 0, stops.length);
			stops.push(s);
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
		const k = uv();
		const arr = new Uint32Array(k);
		const dep = new Uint32Array(k);
		const m = new Float32Array(k);
		for (let i = 0; i < k; i++) {
			arr[i] = uv();
			dep[i] = arr[i] + uv();
			m[i] = uv();
		}
		patterns.push({ route, shape, arr, dep, m });
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
		tx,
		tz,
		trackByChunk,
		stops,
		stopsByChunk,
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

/** the rails and the stops of chunk (cx, cz) */
export function tramBoxes(
	data: TramData,
	cx: number,
	cz: number,
	ground: (x: number, z: number) => number,
	skip: (x: number, z: number) => boolean,
	add: (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry?: number) => void,
) {
	const { tx, tz } = data;
	for (const i of data.trackByChunk.get(cx * 1000 + cz) ?? []) {
		const dx = tx[i + 1] - tx[i];
		const dz = tz[i + 1] - tz[i];
		const len = Math.hypot(dx, dz) || 1;
		// the bed, then a rail on each side of it
		walkSegment(tx[i], tz[i], tx[i + 1], tz[i + 1], cx, cz, ground, skip, (x, z, l, h, ry) => add(l + 0.05, 0.05, 0.8, 0x4a4743, x, h + 0.05, z, ry));
		for (const side of [-0.24, 0.24]) {
			const ox = (-dz / len) * side;
			const oz = (dx / len) * side;
			walkSegment(tx[i] + ox, tz[i] + oz, tx[i + 1] + ox, tz[i + 1] + oz, cx, cz, ground, skip, (x, z, l, h, ry) => add(l + 0.05, 0.03, 0.06, 0x9aa3ad, x, h + 0.09, z, ry));
		}
	}
	for (const i of data.stopsByChunk.get(cx * 1000 + cz) ?? []) {
		const s = data.stops[i];
		if (!inChunk(s.x, s.z, cx, cz) || skip(s.x, s.z)) continue;
		const h = ground(s.x, s.z);
		const ry = -s.heading;
		const c = Math.cos(s.heading);
		const sn = Math.sin(s.heading);
		// a platform with a shelter on it
		add(2, 0.12, 0.45, 0xb9b09c, s.x, h + 0.08, s.z, ry);
		for (const t of [-0.35, 0.35]) add(0.06, 0.55, 0.06, 0x14161c, s.x + c * t, h + 0.42, s.z + sn * t, ry);
		add(0.95, 0.06, 0.4, 0xc23b2f, s.x, h + 0.72, s.z, ry);
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

export function createTrams(scene: Scene, data: TramData, groundAt: (x: number, z: number) => number): Extras {
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

	const bodies = new InstancedMesh(unit, new MeshLambertMaterial({ color: 0xd8322a }), MAX * SECTIONS);
	const windows = new InstancedMesh(unit, glass, MAX * SECTIONS);
	const roofs = new InstancedMesh(unit, new MeshLambertMaterial({ color: 0xf2ead8 }), MAX * SECTIONS);
	for (const m of [bodies, windows, roofs]) {
		m.frustumCulled = false;
		m.userData.dynamic = true;
		m.count = 0;
		scene.add(m);
	}
	const dummy = new Object3D();
	let focus: Focus | null = null;

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
			for (const { trip, offset } of active) {
				if (n >= MAX * SECTIONS) break;
				const p = patterns[tripPattern[trip]];
				const tau = secs + offset - tripStart[trip];
				if (tau < 0 || tau > p.arr[p.arr.length - 1]) continue;
				const front = metresAt(p, tau);
				onShape(p.shape, front);
				if (Math.abs(at.x - focus.x) > reach || Math.abs(at.z - focus.z) > reach) continue;
				for (let k = 0; k < SECTIONS; k++) {
					onShape(p.shape, Math.max(0, front - (k + 0.5) * SECTION * M));
					const y = groundAt(at.x, at.z);
					const yaw = Math.atan2(at.dx, at.dz);
					dummy.rotation.set(0, yaw, 0);
					dummy.position.set(at.x, y + 0.3, at.z);
					dummy.scale.set(0.46, 0.5, SECTION - 0.08);
					dummy.updateMatrix();
					bodies.setMatrixAt(n, dummy.matrix);
					dummy.position.y = y + 0.4;
					dummy.scale.set(0.48, 0.16, SECTION - 0.3);
					dummy.updateMatrix();
					windows.setMatrixAt(n, dummy.matrix);
					dummy.position.y = y + 0.59;
					dummy.scale.set(0.42, 0.08, SECTION - 0.2);
					dummy.updateMatrix();
					roofs.setMatrixAt(n, dummy.matrix);
					n++;
				}
			}
			for (const m of [bodies, windows, roofs]) {
				m.count = n;
				m.instanceMatrix.needsUpdate = true;
			}
		},
	};
}
