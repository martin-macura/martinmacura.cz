// The railway: a graph of one-way edges (plain track between two nodes) laid along irregular curves. Where an edge
// ends in a node with several edges going out, that is a switch; where several come in, a merge.
import { Group, Mesh, MeshBasicMaterial, type Scene, Vector3 } from "three";
import type { Train } from "./trains";
import { box, clamp, COLORS, type Pt, spline, unit } from "./util";

export interface Edge {
	id: string;
	pts: Vector3[];
	cum: number[];
	len: number;
	from: string;
	to: string;
	holder: Train | null; // the train that is on it
	reservedBy: Train | null; // the train that is about to enter it
	waiting: boolean; // a train stands at its end and waits for the next edge
}

export interface RailNode {
	pos: Vector3;
	ins: Edge[];
	outs: Edge[];
	set: Edge; // which way the switch points
}

export interface Layout {
	ring: Pt[];
	inner: Pt[];
	/** edge id, loop it leaves, node it leaves from, loop it joins, node it joins, two points in between */
	connectors: [string, "R" | "I", number, "R" | "I", number, Pt, Pt][];
	/** name, edge, how far along it (0..1), which side the platform is on (1 = right of travel), a stop of the long-distance trains */
	stations: [string, string, number, number, boolean][];
	/** where the track runs through a hill: edge, from, to (distance along it) */
	tunnels: [string, number, number][];
}

// clockwise seen from the south: up the west side, along the north, down the east side, back along the south
const DEFAULT_LAYOUT: Layout = {
	ring: [
		[-108, -14], [-92, -46], [-58, -64], [-18, -62], [22, -70], [66, -58], [100, -34],
		[112, 6], [96, 44], [58, 62], [14, 56], [-28, 66], [-70, 58], [-102, 30],
	],
	inner: [
		[-62, -8], [-46, -34], [-12, -40], [26, -30], [58, -14], [62, 16], [38, 34], [4, 26], [-30, 36], [-58, 22],
	],
	connectors: [
		["c1", "R", 2, "I", 2, [-40, -60], [-24, -50]],
		["c2", "I", 3, "R", 5, [40, -40], [54, -52]],
		["c3", "R", 9, "I", 7, [40, 52], [22, 38]],
		["c4", "I", 8, "R", 12, [-44, 42], [-58, 52]],
	],
	stations: [
		["HLAVNI", "r4", 0.5, 1, true],
		["ZAHRADA", "r7", 0.5, 1, false],
		["PODHRADI", "r8", 0.5, 1, false],
		["PRISTAV", "r9", 0.5, 1, true],
		["HORY", "r12", 0.5, 1, false],
		["VYSEHRAD", "r0", 0.5, 1, false],
		["CENTRUM", "i1", 0.5, 1, true],
		["NADRAZI", "i5", 0.5, 1, false],
		["PARK", "i6", 0.5, 1, false],
		["TRH", "i9", 0.5, 1, false],
	],
	tunnels: [
		["r1", 9, 27],
		["r8", 10, 28],
		["i0", 6, 24],
	],
};

// Each line is a closed circuit of edges. The loops are joined by connectors, so the lines share track and meet
// in the switches. Every layout has the same edges, only laid out differently.
const ids = (prefix: string, from: number, to: number, count: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${(from + i) % count}`);
export const LINES: Record<string, string[]> = {
	outer: ids("r", 0, 13, 14),
	inner: ids("i", 0, 9, 10),
	shortcutTop: ["c1", "i2", "c2", ...ids("r", 5, 15, 14)],
	shortcutBottom: [...ids("r", 12, 22, 14).slice(0, 11), "c3", "i7", "c4"],
};

// --- the plan in two dimensions: it does not depend on the water, and the water depends on it (dry land under stations)
interface Plan {
	id: string;
	from: string;
	to: string;
	xz: Pt[];
	loop: string; // which dense curve it was cut from, for the heights
	start: number; // index into that curve
}

const slice = (curve: { pts: Pt[]; at: number[] }, k: number, n: number) => {
	const a = curve.at[k];
	const b = k + 1 < n ? curve.at[k + 1] : curve.pts.length;
	const out: Pt[] = [];
	for (let i = a; i <= b; i++) out.push(curve.pts[i % curve.pts.length]);
	return { out, a };
};

const lengthOf = (xz: Pt[]) => xz.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - xz[i - 1][0], p[1] - xz[i - 1][1]) : 0), 0);
const pointAlong = (xz: Pt[], frac: number): Pt => {
	let left = lengthOf(xz) * frac;
	for (let i = 1; i < xz.length; i++) {
		const seg = Math.hypot(xz[i][0] - xz[i - 1][0], xz[i][1] - xz[i - 1][1]);
		if (left <= seg) return [xz[i - 1][0] + ((xz[i][0] - xz[i - 1][0]) * left) / seg, xz[i - 1][1] + ((xz[i][1] - xz[i - 1][1]) * left) / seg];
		left -= seg;
	}
	return xz[xz.length - 1];
};

let RING: Pt[] = [];
let INNER: Pt[] = [];
let plans: Plan[] = [];
let ring: ReturnType<typeof spline>;
let inner: ReturnType<typeof spline>;
export let STATION_DEFS: Layout["stations"] = [];
/** where the track runs through a hill: edge, from, to (distance along it) */
export let TUNNELS: Layout["tunnels"] = [];
/** dry land is carved out around these: [x, z, radius] */
export let carvePoints: [number, number, number][] = [];

/** the place of the tracks; call before anything else is built */
export function useLayout(layout: Layout) {
	RING = layout.ring;
	INNER = layout.inner;
	STATION_DEFS = layout.stations;
	TUNNELS = layout.tunnels;
	ring = spline(RING, true, 1);
	inner = spline(INNER, true, 1);
	plans = [];
	for (let k = 0; k < RING.length; k++) {
		const { out, a } = slice(ring, k, RING.length);
		plans.push({ id: `r${k}`, from: `R${k}`, to: `R${(k + 1) % RING.length}`, xz: out, loop: "R", start: a });
	}
	for (let k = 0; k < INNER.length; k++) {
		const { out, a } = slice(inner, k, INNER.length);
		plans.push({ id: `i${k}`, from: `I${k}`, to: `I${(k + 1) % INNER.length}`, xz: out, loop: "I", start: a });
	}
	for (const [id, fromLoop, fromK, toLoop, toK, m1, m2] of layout.connectors) {
		const src = fromLoop === "R" ? RING : INNER;
		const dst = toLoop === "R" ? RING : INNER;
		const a = src[fromK];
		const b = dst[toK];
		const ghostA = src[(fromK - 1 + src.length) % src.length];
		const ghostB = dst[(toK + 1) % dst.length];
		const s = spline([ghostA, a, m1, m2, b, ghostB], false, 1);
		plans.push({ id, from: `${fromLoop}${fromK}`, to: `${toLoop}${toK}`, xz: s.pts.slice(s.at[1], s.at[4] + 1), loop: id, start: 0 });
	}
	carvePoints = [
		...RING.map(([x, z]): [number, number, number] => [x, z, 7]),
		...INNER.map(([x, z]): [number, number, number] => [x, z, 7]),
		...STATION_DEFS.map(([, edge, frac]): [number, number, number] => {
			const [x, z] = pointAlong(plans.find((p) => p.id === edge)!.xz, frac);
			return [x, z, 10];
		}),
		// the tunnels: the hills they go through must be dry too
		...TUNNELS.map(([edge, from, to]): [number, number, number] => {
			const xz = plans.find((p) => p.id === edge)!.xz;
			const [x, z] = pointAlong(xz, (from + to) / 2 / lengthOf(xz));
			return [x, z, 14];
		}),
	];
}
useLayout(DEFAULT_LAYOUT);

// --- the same in three dimensions, once the water is known

export function edgeAt(e: Edge, d: number, out = new Vector3()) {
	d = clamp(d, 0, e.len);
	let lo = 0;
	let hi = e.pts.length - 2;
	while (lo < hi) {
		const m = (lo + hi + 1) >> 1;
		if (e.cum[m] <= d) lo = m;
		else hi = m - 1;
	}
	return out.lerpVectors(e.pts[lo], e.pts[lo + 1], (d - e.cum[lo]) / (e.cum[lo + 1] - e.cum[lo]));
}

export interface Rails {
	edges: Map<string, Edge>;
	nodes: Map<string, RailNode>;
	/** how far from the nearest track, in units (99 when it is far) */
	railDist: (x: number, z: number) => number;
}

/** lifts the track onto a bridge wherever it crosses water: flat over the water, with ramps of 1.6 units */
function heights(pts: Pt[], closed: boolean, isWater: (x: number, z: number) => boolean) {
	const n = pts.length;
	const near = pts.map(([x, z]) => isWater(x, z) || isWater(x + 1, z) || isWater(x - 1, z) || isWater(x, z + 1) || isWater(x, z - 1));
	const dist = new Array<number>(n).fill(Infinity);
	const seg = (i: number, j: number) => Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
	for (let pass = 0; pass < (closed ? 2 : 1); pass++) {
		for (let i = 0; i < n; i++) {
			if (near[i]) dist[i] = 0;
			const prev = i === 0 ? (closed ? n - 1 : -1) : i - 1;
			if (prev >= 0) dist[i] = Math.min(dist[i], dist[prev] + seg(i, prev));
		}
		for (let i = n - 1; i >= 0; i--) {
			const next = i === n - 1 ? (closed ? 0 : -1) : i + 1;
			if (next >= 0) dist[i] = Math.min(dist[i], dist[next] + seg(i, next));
		}
	}
	return dist.map((d) => clamp(0.8 - 0.5 * Math.max(0, d - 0.3), 0, 0.8));
}

export function createRails(isWater: (x: number, z: number) => boolean): Rails {
	const ringY = heights(ring.pts, true, isWater);
	const innerY = heights(inner.pts, true, isWater);
	const edges = new Map<string, Edge>();
	const nodes = new Map<string, RailNode>();
	const nodeXZ = (name: string): Pt => (name[0] === "R" ? RING : INNER)[Number(name.slice(1))];

	for (const plan of plans) {
		let ys: number[];
		if (plan.loop === "R" || plan.loop === "I") {
			const src = plan.loop === "R" ? ringY : innerY;
			const total = plan.loop === "R" ? ring.pts.length : inner.pts.length;
			ys = plan.xz.map((_, i) => src[(plan.start + i) % total]);
		} else {
			ys = heights(plan.xz, false, isWater);
		}
		const pts = plan.xz.map(([x, z], i) => new Vector3(x, ys[i], z));
		const cum = [0];
		for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
		const edge: Edge = { id: plan.id, pts, cum, len: cum[cum.length - 1], from: plan.from, to: plan.to, holder: null, reservedBy: null, waiting: false };
		edges.set(plan.id, edge);
		for (const name of [plan.from, plan.to]) {
			if (!nodes.has(name)) {
				const [x, z] = nodeXZ(name);
				nodes.set(name, { pos: new Vector3(x, 0, z), ins: [], outs: [], set: edge });
			}
		}
		nodes.get(plan.from)!.outs.push(edge);
		nodes.get(plan.to)!.ins.push(edge);
	}
	for (const node of nodes.values()) node.set = node.outs[0];

	if (import.meta.env.DEV) {
		for (const [name, route] of Object.entries(LINES)) {
			route.forEach((id, i) => {
				if (edges.get(id)!.to !== edges.get(route[(i + 1) % route.length])!.from) throw new Error(`line ${name} breaks after ${id}`);
			});
		}
	}

	// distance to the nearest track, on a grid of one unit
	let minX = Infinity;
	let maxX = -Infinity;
	let minZ = Infinity;
	let maxZ = -Infinity;
	for (const e of edges.values()) {
		for (const p of e.pts) {
			minX = Math.min(minX, p.x);
			maxX = Math.max(maxX, p.x);
			minZ = Math.min(minZ, p.z);
			maxZ = Math.max(maxZ, p.z);
		}
	}
	const OX = Math.floor(minX) - 12;
	const OZ = Math.floor(minZ) - 12;
	const W = Math.ceil(maxX) + 12 - OX;
	const H = Math.ceil(maxZ) + 12 - OZ;
	const grid = new Uint8Array(W * H).fill(255);
	for (const e of edges.values()) {
		for (const p of e.pts) {
			for (let iz = Math.floor(p.z - 10); iz <= Math.ceil(p.z + 10); iz++) {
				for (let ix = Math.floor(p.x - 10); ix <= Math.ceil(p.x + 10); ix++) {
					const gx = ix - OX;
					const gz = iz - OZ;
					if (gx < 0 || gz < 0 || gx >= W || gz >= H) continue;
					const d = Math.hypot(ix + 0.5 - p.x, iz + 0.5 - p.z) * 10;
					if (d < grid[gz * W + gx]) grid[gz * W + gx] = Math.min(254, d);
				}
			}
		}
	}
	const railDist = (x: number, z: number) => {
		const gx = Math.floor(x) - OX;
		const gz = Math.floor(z) - OZ;
		if (gx < 0 || gz < 0 || gx >= W || gz >= H) return 99;
		const v = grid[gz * W + gx];
		return v === 255 ? 99 : v / 10;
	};
	return { edges, nodes, railDist };
}

// ---------------------------------------------------------------------------------------------
// what the track looks like: rails, ballast, sleepers, bridges, tunnels

export interface StationSite {
	name: string;
	edge: Edge;
	d: number;
	major: boolean;
	origin: Vector3;
	t: Vector3; // direction of travel
	n: Vector3; // towards the platform
}

export function buildRailScenery(scene: Scene, rails: Rails, isWater: (x: number, z: number) => boolean) {
	const { edges, nodes } = rails;
	const up = new Vector3(0, 1, 0);
	const tan = new Vector3();
	const tmp = new Vector3();

	for (const e of edges.values()) {
		for (let i = 0; i < e.pts.length - 1; i++) {
			const a = e.pts[i];
			const b = e.pts[i + 1];
			const len = a.distanceTo(b);
			const dir = new Vector3().subVectors(b, a).normalize();
			const mid = new Vector3().addVectors(a, b).multiplyScalar(0.5);
			const right = new Vector3().crossVectors(dir, up).normalize();
			for (const side of [-0.42, 0.42]) {
				const rail = box(scene, 0.09, 0.09, len + 0.1, COLORS.steel, mid.x + right.x * side, mid.y + 0.11, mid.z + right.z * side);
				rail.lookAt(rail.position.clone().add(dir));
			}
			const yaw = Math.atan2(dir.x, dir.z);
			const deck = mid.y > 0.7 && (isWater(mid.x, mid.z) || isWater(mid.x + 1, mid.z) || isWater(mid.x - 1, mid.z) || isWater(mid.x, mid.z + 1) || isWater(mid.x, mid.z - 1));
			if (deck) {
				const dk = box(scene, 1.7, 0.25, len + 0.12, COLORS.steel, mid.x, mid.y - 0.1, mid.z);
				dk.rotation.y = yaw;
				for (const side of [-0.85, 0.85]) box(scene, 0.1, 0.45, len + 0.12, COLORS.steel, mid.x + right.x * side, mid.y + 0.12, mid.z + right.z * side).rotation.y = yaw;
				if (i % 3 === 0) box(scene, 0.45, mid.y, 1.1, COLORS.rock, mid.x, mid.y / 2 - 0.05, mid.z).rotation.y = yaw;
			} else {
				const h = Math.max(0.05, mid.y + 0.05);
				box(scene, 1.5, h, len + 0.1, COLORS.ballast, mid.x, h / 2, mid.z).rotation.y = yaw;
			}
		}
		for (let d = 0.3; d < e.len; d += 0.6) {
			const p = edgeAt(e, d);
			tan.subVectors(edgeAt(e, d + 0.05, tmp), edgeAt(e, d - 0.05)).normalize();
			const sleeper = box(scene, 1.25, 0.05, 0.14, COLORS.wood, p.x, p.y + 0.075, p.z);
			sleeper.lookAt(sleeper.position.clone().add(tan));
		}
	}

	// tunnels: a mound of hill along the track, dark mouths at both ends
	for (const [id, from, to] of TUNNELS) {
		const e = edges.get(id)!;
		for (let d = from; d <= to; d += 1.5) {
			const p = edgeAt(e, d);
			const dir = edgeAt(e, d + 0.3).sub(edgeAt(e, d - 0.3)).setY(0).normalize();
			const yaw = Math.atan2(dir.x, dir.z);
			const k = Math.round(d / 1.5);
			box(scene, 5.4, 1.9, 1.9, 0x3f7a42, p.x, 0.95, p.z).rotation.y = yaw;
			box(scene, 3.9, 1.0, 1.9, k % 3 ? 0x4a8a4c : 0x5a9a58, p.x, 2.4, p.z).rotation.y = yaw;
			box(scene, 2.2, 0.8, 1.9, k % 2 ? COLORS.rock : 0x4a8a4c, p.x, 3.3, p.z).rotation.y = yaw;
		}
		for (const [d, sign] of [[from, -1], [to, 1]] as const) {
			const p = edgeAt(e, d);
			const dir = edgeAt(e, d + 0.3).sub(edgeAt(e, d - 0.3)).setY(0).normalize();
			const yaw = Math.atan2(dir.x, dir.z);
			const right = new Vector3().crossVectors(dir, up);
			const at = (along: number, lateral: number) => p.clone().addScaledVector(dir, sign * along).addScaledVector(right, lateral);
			const mouth = at(1.0, 0);
			box(scene, 1.5, 1.25, 0.12, 0x05060a, mouth.x, 0.65, mouth.z).rotation.y = yaw;
			const lintel = at(1.05, 0);
			box(scene, 1.9, 0.22, 0.2, COLORS.rock, lintel.x, 1.36, lintel.z).rotation.y = yaw;
			for (const lateral of [-0.85, 0.85]) {
				const jamb = at(1.05, lateral);
				box(scene, 0.2, 1.35, 0.2, COLORS.rock, jamb.x, 0.68, jamb.z).rotation.y = yaw;
			}
		}
	}

	// --- signals at the end of every edge that leads into a switch or a merge, and the switches themselves
	const lamp = {
		red: new MeshBasicMaterial({ color: 0xff3b30 }),
		green: new MeshBasicMaterial({ color: 0x35f07a }),
		yellow: new MeshBasicMaterial({ color: 0xffcf33 }),
	};
	const beside = (e: Edge, d: number, side: number) => {
		const p = edgeAt(e, d);
		const dir = edgeAt(e, d + 0.3).sub(p).setY(0).normalize();
		return p.addScaledVector(new Vector3().crossVectors(dir, up), side);
	};
	const signals: { edge: Edge; light: Mesh }[] = [];
	for (const e of edges.values()) {
		const node = nodes.get(e.to)!;
		if (node.ins.length < 2 && node.outs.length < 2) continue;
		const g = new Group();
		box(g, 0.08, 0.9, 0.08, COLORS.dark, 0, 0.45, 0);
		box(g, 0.24, 0.42, 0.16, COLORS.dark, 0, 1, 0);
		const light = new Mesh(unit, lamp.green);
		light.scale.set(0.14, 0.14, 0.18);
		light.position.set(0, 1.06, 0);
		g.add(light);
		g.position.copy(beside(e, e.len - 1.6, 1.2));
		scene.add(g);
		signals.push({ edge: e, light });
	}
	const switches: { node: RailNode; lever: Mesh; head: Mesh; tongues: Map<Edge, Group> }[] = [];
	for (const node of nodes.values()) {
		if (node.outs.length < 2) continue;
		const g = new Group();
		box(g, 0.1, 0.45, 0.1, COLORS.dark, 0, 0.22, 0);
		const lever = box(g, 0.5, 0.08, 0.08, COLORS.dark, 0, 0.5, 0);
		const head = new Mesh(unit, lamp.green);
		head.scale.set(0.4, 3, 3); // the lever is 0.5 x 0.08 x 0.08, so this is a 0.2 cube
		head.position.set(0.5, 0, 0);
		lever.add(head);
		g.position.copy(beside(node.outs[0], 0.4, -1.5));
		scene.add(g);
		// the blade: the first stretch of the track the switch points to lights up
		const tongues = new Map<Edge, Group>();
		for (const e of node.outs) {
			const tg = new Group();
			for (const side of [-0.42, 0.42]) {
				const a = beside(e, 0.2, side);
				const b = beside(e, 2, side);
				const rail = box(tg, 0.13, 0.13, a.distanceTo(b), COLORS.yellow, (a.x + b.x) / 2, (a.y + b.y) / 2 + 0.15, (a.z + b.z) / 2);
				rail.lookAt(b.x, b.y + 0.15, b.z);
			}
			scene.add(tg);
			tongues.set(e, tg);
		}
		switches.push({ node, lever, head, tongues });
	}

	return { signals, switches, lamp };
}

/** where the stations stand, with the direction of travel and the side of the platform */
export function stationSites(rails: Rails): StationSite[] {
	const up = new Vector3(0, 1, 0);
	return STATION_DEFS.map(([name, edgeId, frac, side, major]) => {
		const edge = rails.edges.get(edgeId)!;
		const d = edge.len * frac;
		const origin = edgeAt(edge, d);
		const t = edgeAt(edge, d + 0.3).sub(edgeAt(edge, d - 0.3)).setY(0).normalize();
		const n = new Vector3().crossVectors(t, up).multiplyScalar(side);
		return { name, edge, d, major, origin, t, n };
	});
}

