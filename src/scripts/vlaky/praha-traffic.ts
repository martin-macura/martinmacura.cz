// Made-up traffic on the real streets of Prague: cars drive the graph of praha-roads.dat, keep to the right, follow
// the one-way streets and keep a gap to the car in front. They live only around the view: a car that falls out of
// it comes back somewhere in it, so a few hundred cars are enough for the whole city.
import { Color, InstancedMesh, MeshBasicMaterial, MeshLambertMaterial, Object3D, type Scene } from "three";
import type { RoadNet } from "./praha-roads";
import { BODIES, COME_FROM, EXIT_PATHS, SIEGL, SLOT_HEADING, TRUCK_LAMPS, truckParts, YARD, YARD_BODIES, YARD_TRUCKS } from "./praha-siegl";
import { COLORS, glow, rng, unit } from "./util";
import { type Focus, VEHICLES_UP_TO } from "./world";

const MAX = 420;
const TRUCKS = 8; // the trucks of Siegl, around their yard
const SPEED = [0, 1.3, 2, 3]; // units a second, by class
const KEEP_RIGHT = [0, 0.24, 0.42, 0.62];
/** how many cars a stretch of street carries by class, against the busiest: the side streets are quiet, the avenues are not */
const BUSY = [0, 0.1, 0.6, 1];
/** what a car adds to the score of a turn onto a street of that class: it likes to be on the bigger road */
const PULL = [0, 0, 0.9, 1.4];
const CAR_COLORS = [COLORS.red, COLORS.yellow, COLORS.blue, COLORS.green, COLORS.white, 0xff9f2f, 0x7a6a9a, 0x2b2b2b, 0xb9b9b9, 0x9a2a2a].map((c) => new Color(c));
const CH = 32;

/**
 * headlights and tail lights for things that drive: two warm white at the front, two red at the back, shown only at
 * night (when the lamp heads of the scene glow), as small pieces of an instanced mesh; no light of their own
 */
export function createLamps(scene: Scene, max: number) {
	const heads = new InstancedMesh(unit, new MeshBasicMaterial({ color: 0xfff1c8 }), max * 2);
	const tails = new InstancedMesh(unit, new MeshBasicMaterial({ color: 0xff2a1a }), max * 2);
	for (const m of [heads, tails]) {
		m.frustumCulled = false;
		m.userData.dynamic = true;
		m.count = 0;
		m.visible = false;
		scene.add(m);
	}
	const dummy = new Object3D();
	let nh = 0; // lamps put this frame, at the front and at the back
	let nt = 0;
	let on = false;
	return {
		/** before putting the lamps of a frame: false by day, and nothing needs putting */
		begin() {
			nh = nt = 0;
			on = glow.emissive.r > 0.5; // the scene's own night, as applyLight sets it
			heads.visible = tails.visible = on;
			return on;
		},
		/**
		 * the lamps of a vehicle at (x, y, z) heading (fx, fz), `half` long and `wide` apart from its middle; `ends` 1 the
		 * front only, 2 the back only (the first and the last car of a tram or a train), 3 both
		 */
		put(x: number, y: number, z: number, fx: number, fz: number, half: number, wide: number, ends = 3) {
			if (!on) return;
			const rx = fz;
			const rz = -fx;
			dummy.rotation.set(0, Math.atan2(fx, fz), 0);
			dummy.scale.set(0.15, 0.1, 0.08);
			for (const side of [-wide, wide]) {
				if (ends & 1 && nh < max * 2) {
					dummy.position.set(x + fx * half + rx * side, y, z + fz * half + rz * side);
					dummy.updateMatrix();
					heads.setMatrixAt(nh++, dummy.matrix);
				}
				if (ends & 2 && nt < max * 2) {
					dummy.position.set(x - fx * half + rx * side, y, z - fz * half + rz * side);
					dummy.updateMatrix();
					tails.setMatrixAt(nt++, dummy.matrix);
				}
			}
		},
		end() {
			heads.count = nh;
			tails.count = nt;
			heads.instanceMatrix.needsUpdate = true;
			tails.instanceMatrix.needsUpdate = true;
		},
	};
}

interface Car {
	e: number; // the edge it is on, -1 when parked out of sight
	dir: 1 | -1; // with the edge or against it
	s: number; // distance driven along the edge
	v: number;
	vmax: number;
	/** a truck of Siegl: the kind of its body, an index into BODIES; absent for a car */
	truck?: number;
	/** a truck that lives in the yard of Siegl: where it is in its day; absent for the others */
	duty?: Duty;
}

/** a truck of the yard stands in its slot, drives out, goes along the streets, is away for a while, comes back and drives in */
interface Duty {
	slot: number;
	phase: "parked" | "out" | "road" | "away" | "in";
	/** how far along the way out of its slot it is, while it drives out or in */
	d: number;
	/** seconds until it leaves its slot, or until it comes back */
	wait: number;
	/** on its way home: it turns in at the access road */
	homing: boolean;
	/** seconds it has stood still on a street */
	stuck: number;
	/** the way it faces, an angle from +z; on the way in and out it turns towards the way it goes */
	heading: number;
}

/** how fast a truck drives on the access road, units a second */
const YARD_SPEED = 1.6;

/** `from` turned towards `to` by at most `max` radians */
const turnTo = (from: number, to: number, max: number) => {
	let diff = (to - from) % (Math.PI * 2);
	if (diff > Math.PI) diff -= Math.PI * 2;
	else if (diff < -Math.PI) diff += Math.PI * 2;
	return from + Math.max(-max, Math.min(max, diff));
};

export function createTraffic(scene: Scene, net: RoadNet, groundAt: (x: number, z: number) => number, roadOK: (x: number, z: number) => boolean) {
	const rand = rng(23);
	const ne = net.ea.length;
	// the length of every edge, and of the edge up to each of its points
	const cum = new Float32Array(net.px.length);
	const len = new Float32Array(ne);
	for (let e = 0; e < ne; e++) {
		let d = 0;
		for (let i = net.start[e]; i < net.start[e + 1]; i++) {
			if (i > net.start[e]) d += Math.hypot(net.px[i] - net.px[i - 1], net.pz[i] - net.pz[i - 1]);
			cum[i] = d;
		}
		len[e] = d;
	}
	// what leaves each node: edge * 2 + (1 when driven against its direction)
	const outCount = new Uint32Array(net.nx.length + 1);
	for (let e = 0; e < ne; e++) {
		outCount[net.ea[e] + 1]++;
		if (!net.oneway[e]) outCount[net.eb[e] + 1]++;
	}
	for (let i = 1; i < outCount.length; i++) outCount[i] += outCount[i - 1];
	const outs = new Uint32Array(outCount[outCount.length - 1]);
	const fill = outCount.slice(0, -1);
	for (let e = 0; e < ne; e++) {
		outs[fill[net.ea[e]]++] = e * 2;
		if (!net.oneway[e]) outs[fill[net.eb[e]]++] = e * 2 + 1;
	}
	// an edge that runs across the railway away from a level crossing, or that has no length, is not driven
	const usable = new Uint8Array(ne); // 0 not known yet, 1 yes, 2 no
	const ok = (e: number) => {
		if (!usable[e]) {
			let good = len[e] > 0.05;
			for (let i = net.start[e]; good && i < net.start[e + 1] - 1; i++) {
				const L = cum[i + 1] - cum[i];
				for (let t = 0; good && t <= L; t += 1) {
					const f = L ? t / L : 0;
					good = roadOK(net.px[i] + (net.px[i + 1] - net.px[i]) * f, net.pz[i] + (net.pz[i + 1] - net.pz[i]) * f);
				}
			}
			usable[e] = good ? 1 : 2;
		}
		return usable[e] === 1;
	};

	/** the point at distance s along edge e as driven in direction dir, and the heading there */
	const at = { x: 0, z: 0, dx: 1, dz: 0 };
	function place(e: number, dir: number, s: number) {
		const a = net.start[e];
		const b = net.start[e + 1] - 1;
		const d = dir > 0 ? s : len[e] - s;
		let lo = a;
		let hi = b - 1;
		while (lo < hi) {
			const m = (lo + hi + 1) >> 1;
			if (cum[m] <= d) lo = m;
			else hi = m - 1;
		}
		const span = cum[lo + 1] - cum[lo] || 1;
		const f = Math.min(1, Math.max(0, (d - cum[lo]) / span));
		const dx = net.px[lo + 1] - net.px[lo];
		const dz = net.pz[lo + 1] - net.pz[lo];
		const l = Math.hypot(dx, dz) || 1;
		at.x = net.px[lo] + dx * f;
		at.z = net.pz[lo] + dz * f;
		at.dx = (dx / l) * dir;
		at.dz = (dz / l) * dir;
	}

	/** at the end of an edge: mostly straight on, sometimes a turn, back only from a dead end */
	function next(car: Car) {
		const node = car.dir > 0 ? net.eb[car.e] : net.ea[car.e];
		place(car.e, car.dir, len[car.e]);
		const hx = at.dx;
		const hz = at.dz;
		// a truck of Siegl that has gone far from its yard takes the turns that lead back
		const homeward = car.truck !== undefined && (!car.duty || car.duty.homing) && Math.hypot(net.nx[node] - SIEGL.x, net.nz[node] - SIEGL.z) > SIEGL.home;
		let best = -1;
		let bestScore = -Infinity;
		for (let k = outCount[node]; k < outCount[node + 1]; k++) {
			const e = outs[k] >> 1;
			const dir = outs[k] & 1 ? -1 : 1;
			if (!ok(e)) continue;
			if (e === car.e && dir === -car.dir) continue;
			place(e, dir, Math.min(0.5, len[e]));
			const straight = hx * at.dx + hz * at.dz; // 1 straight on, -1 back
			let score = straight + rand() * 1.6 + PULL[net.cls[e]];
			if (car.duty?.homing && e === join.e && dir === join.dir) score += 4; // home: the access road is here
			if (homeward) {
				const end = dir > 0 ? net.eb[e] : net.ea[e];
				score += ((Math.hypot(net.nx[node] - SIEGL.x, net.nz[node] - SIEGL.z) - Math.hypot(net.nx[end] - SIEGL.x, net.nz[end] - SIEGL.z)) / Math.max(1, len[e])) * 4;
			}
			if (score > bestScore) {
				bestScore = score;
				best = k;
			}
		}
		if (best < 0) {
			// a dead end: turn round, if the street allows it
			if (net.oneway[car.e]) return false;
			car.dir = car.dir > 0 ? -1 : 1;
			car.s = 0;
			return true;
		}
		car.e = outs[best] >> 1;
		car.dir = outs[best] & 1 ? -1 : 1;
		car.s = 0;
		car.vmax = SPEED[net.cls[car.e]] * (0.8 + rand() * 0.4);
		return true;
	}

	const cars: Car[] = Array.from({ length: MAX }, () => ({ e: -1, dir: 1, s: 0, v: 0, vmax: 1 }));
	const colors = cars.map((_, i) => CAR_COLORS[i % CAR_COLORS.length]);
	const trucks: Car[] = Array.from({ length: TRUCKS }, (_, i): Car => {
		if (i >= YARD_TRUCKS) return { e: -1, dir: 1, s: 0, v: 0, vmax: 1, truck: i % BODIES.length };
		return { e: -1, dir: 1, s: 0, v: 0, vmax: 1, truck: YARD_BODIES[i], duty: { slot: i, phase: "parked", d: 0, wait: 1 + i * 3 + rand() * 4, homing: false, stuck: 0, heading: SLOT_HEADING } };
	});
	const everyone = [...cars, ...trucks];
	// the streets that touch the neighbourhood of the yard: where a truck starts
	const siteEdges: number[] = [];
	for (let e = 0; e < ne; e++) {
		for (let i = net.start[e]; i < net.start[e + 1]; i++) {
			if (Math.hypot(net.px[i] - SIEGL.x, net.pz[i] - SIEGL.z) < SIEGL.home * 0.6) {
				if (ok(e)) siteEdges.push(e);
				break;
			}
		}
	}
	function spawnTruck(car: Car) {
		if (!siteEdges.length) return;
		const e = siteEdges[Math.floor(rand() * siteEdges.length)];
		car.e = e;
		car.dir = net.oneway[e] || rand() < 0.5 ? 1 : -1;
		car.s = rand() * len[e];
		car.vmax = SPEED[net.cls[e]] * (0.7 + rand() * 0.3);
		car.v = car.vmax * 0.6;
	}

	// --- the trucks that live in the yard: the way out of a slot is a path of the world, which is not a street of the
	// map; on a street a truck is a car like the others
	/** the street, the direction and the place on it that are nearest to a point of the world, among the streets that run west */
	const locate = (px: number, pz: number) => {
		let best = { e: -1, dir: 1 as 1 | -1, s: 0, d: Infinity };
		for (let a = -1; a <= 1; a++) {
			for (let b = -1; b <= 1; b++) {
				for (const i of net.byChunk.get((Math.floor(px / CH) + a) * 1000 + Math.floor(pz / CH) + b) ?? []) {
					const e = net.segEdge[i];
					const dx = net.px[i + 1] - net.px[i];
					const dz = net.pz[i + 1] - net.pz[i];
					const l = Math.hypot(dx, dz) || 1;
					const t = Math.min(l, Math.max(0, ((px - net.px[i]) * dx + (pz - net.pz[i]) * dz) / l));
					const d = Math.hypot(net.px[i] + (dx / l) * t - px, net.pz[i] + (dz / l) * t - pz);
					if (d >= best.d || !ok(e)) continue;
					const dir = net.oneway[e] || dx < 0 ? 1 : -1; // with the street, or to the west
					if ((dir * dx) / l > -0.6) continue; // Teplárenská runs west here: not a street that crosses it
					const along = cum[i] + t;
					best = { e, dir, s: dir > 0 ? along : len[e] - along, d };
				}
			}
		}
		return best;
	};
	const join = locate(SIEGL.x, SIEGL.z); // where the access road meets the street
	const comeFrom = locate(COME_FROM.x, COME_FROM.z); // and where a truck that comes back joins the street
	const fleetOK = join.d < 6 && comeFrom.d < 6 && !(comeFrom.e === join.e && comeFrom.dir === join.dir && comeFrom.s >= join.s);
	const pathLen = EXIT_PATHS.map((path) => path.reduce((sum, q, i) => sum + (i ? Math.hypot(q[0] - path[i - 1][0], q[1] - path[i - 1][1]) : 0), 0));
	/** the point at distance d along the way out of slot k, and the way it goes there */
	const spot = { x: 0, z: 0, dx: 0, dz: 1 };
	function onPath(k: number, d: number) {
		const path = EXIT_PATHS[k];
		let i = 0;
		let left = Math.max(0, d);
		while (i < path.length - 2 && left > Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1])) {
			left -= Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
			i++;
		}
		const l = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]) || 1;
		const f = Math.min(1, left / l);
		spot.x = path[i][0] + (path[i + 1][0] - path[i][0]) * f;
		spot.z = path[i][1] + (path[i + 1][1] - path[i][1]) * f;
		spot.dx = (path[i + 1][0] - path[i][0]) / l;
		spot.dz = (path[i + 1][1] - path[i][1]) / l;
	}
	/** no car is within a few units of the place on the street */
	const room = (w: typeof join, except: Car) => everyone.every((c) => c === except || c.e !== w.e || c.dir !== w.dir || Math.abs(c.s - w.s) > 2.5);
	/** another truck is on the access road near where the way out of slot k meets it */
	const roadBusy = (k: number) =>
		trucks.some((o) => {
			const t = o.duty;
			if (!t || t.slot === k || (t.phase !== "out" && t.phase !== "in")) return false;
			onPath(t.slot, t.d);
			return Math.hypot(spot.x - EXIT_PATHS[k][2][0], spot.z - EXIT_PATHS[k][2][1]) < 5;
		});
	function takeStreet(car: Car, t: Duty, where: typeof join, homing: boolean) {
		car.e = where.e;
		car.dir = where.dir;
		car.s = where.s;
		car.v = 0.3;
		car.vmax = SPEED[net.cls[car.e]] * 0.85;
		t.phase = "road";
		t.homing = homing;
		t.stuck = 0;
	}
	/** a day of a truck of the yard, one step; `near` says the yard is in the view or close to it */
	function tend(car: Car, t: Duty, dt: number, near: boolean) {
		if (!near) {
			// out of sight it is back in its slot
			if (t.phase !== "parked") {
				t.phase = "parked";
				t.wait = 1 + t.slot * 3 + rand() * 4;
			}
			car.e = -1;
			t.heading = SLOT_HEADING;
			return;
		}
		switch (t.phase) {
			case "parked":
				t.heading = SLOT_HEADING;
				if ((t.wait -= dt) <= 0 && fleetOK && !roadBusy(t.slot)) {
					t.phase = "out";
					t.d = 0;
				}
				break;
			case "out":
				t.d += YARD_SPEED * dt;
				onPath(t.slot, t.d);
				t.heading = turnTo(t.heading, Math.atan2(spot.dx, spot.dz), 3 * dt);
				if (t.d >= pathLen[t.slot]) {
					if (room(join, car)) takeStreet(car, t, join, false);
					else t.d = pathLen[t.slot];
				}
				break;
			case "road": {
				if (car.e < 0) {
					// the street ended
					t.phase = "away";
					t.wait = 3 + rand() * 8;
					break;
				}
				place(car.e, car.dir, car.s);
				t.heading = turnTo(t.heading, Math.atan2(at.dx, at.dz), 3 * dt);
				if (Math.hypot(at.x - SIEGL.x, at.z - SIEGL.z) > SIEGL.home * 1.8) {
					// off on a job, out of sight
					car.e = -1;
					t.phase = "away";
					t.wait = 4 + rand() * 10;
				} else if (t.homing && car.e === join.e && car.dir === join.dir && car.s >= join.s) {
					// at the access road: it turns in
					car.e = -1;
					t.phase = "in";
					t.d = pathLen[t.slot];
				} else {
					// in a jam for good: it goes, and comes back later, rather than stand for ever
					t.stuck = car.v < 0.05 ? t.stuck + dt : 0;
					if (t.stuck > 20) {
						car.e = -1;
						t.phase = "away";
						t.wait = 3 + rand() * 6;
					}
				}
				break;
			}
			case "away":
				if ((t.wait -= dt) <= 0 && room(comeFrom, car)) takeStreet(car, t, comeFrom, true);
				break;
			case "in":
				t.d -= YARD_SPEED * dt;
				onPath(t.slot, t.d);
				// over the last stretch it swings round to stand as it will leave, nose to the road
				t.heading = turnTo(t.heading, t.d > 1.6 ? Math.atan2(-spot.dx, -spot.dz) : SLOT_HEADING, 3 * dt);
				if (t.d <= 0) {
					t.phase = "parked";
					t.wait = 12 + rand() * 25;
				}
				break;
		}
	}
	let siteNear = false; // the yard is in the view or close to it

	/** puts the car on a random street of a random chunk in the view */
	function spawn(car: Car, f: Focus) {
		for (let tries = 0; tries < 24; tries++) {
			const cx = Math.floor((f.x + (rand() * 2 - 1) * f.r) / CH);
			const cz = Math.floor((f.z + (rand() * 2 - 1) * f.r) / CH);
			const segs = net.byChunk.get(cx * 1000 + cz);
			// a chunk with few streets gets few cars, or its one road would jam
			if (!segs || rand() * 120 > segs.length) continue;
			const e = net.segEdge[segs[Math.floor(rand() * segs.length)]];
			if (rand() > BUSY[net.cls[e]] || !ok(e)) continue;
			const dir = net.oneway[e] || rand() < 0.5 ? 1 : -1;
			const s = rand() * len[e];
			// not on top of a car in the same lane: the busy streets are crowded enough for that to happen
			if (cars.some((c) => c !== car && c.e === e && c.dir === dir && Math.abs(c.s - s) < 1.4)) continue;
			car.e = e;
			car.dir = dir;
			car.s = s;
			car.vmax = SPEED[net.cls[e]] * (0.8 + rand() * 0.4);
			car.v = car.vmax * 0.6;
			return;
		}
		car.e = -1;
	}

	const bodies = new InstancedMesh(unit, new MeshLambertMaterial({ color: 0xffffff }), MAX);
	const cabins = new InstancedMesh(unit, new MeshLambertMaterial({ color: 0xffffff }), MAX);
	const cabin = new Color(0x1c2232);
	for (let i = 0; i < MAX; i++) {
		bodies.setColorAt(i, colors[i]);
		cabins.setColorAt(i, cabin);
	}
	for (const m of [bodies, cabins]) {
		m.frustumCulled = false;
		m.userData.dynamic = true;
		m.count = 0;
		scene.add(m);
	}

	const lamps = createLamps(scene, MAX);

	// the trucks of Siegl: every part of one is a box of an instanced mesh with its colour
	const kinds = BODIES.map((b) => truckParts(b).map((p) => ({ part: p, color: new Color(p[6]) })));
	const truckMesh = new InstancedMesh(unit, new MeshLambertMaterial({ color: 0xffffff }), TRUCKS * Math.max(...kinds.map((k) => k.length)));
	truckMesh.frustumCulled = false;
	truckMesh.userData.dynamic = true;
	truckMesh.count = 0;
	scene.add(truckMesh);
	const truckLamps = createLamps(scene, TRUCKS);

	// cars in the same lane of the same edge, to keep the gaps
	const lanes = new Map<number, Car[]>();
	let shown = false;

	function simulate(dt: number, f: Focus) {
		shown = !f.far && f.k <= VEHICLES_UP_TO;
		if (!shown) return;
		// the denser the view, the more cars, up to the pool
		const want = Math.min(MAX, Math.round((f.r * f.r) / 24));
		for (let i = 0; i < MAX; i++) {
			const car = cars[i];
			if (i >= want) {
				car.e = -1;
				continue;
			}
			if (car.e < 0) {
				spawn(car, f);
				continue;
			}
			place(car.e, car.dir, car.s);
			if (Math.abs(at.x - f.x) > f.r * 1.25 || Math.abs(at.z - f.z) > f.r * 1.25) spawn(car, f);
		}
		// the trucks of Siegl are there while the yard is in the view or near it
		const nearSite = (px: number, pz: number) => Math.abs(f.x - px) < f.r * 1.25 + SIEGL.home * 0.5 && Math.abs(f.z - pz) < f.r * 1.25 + SIEGL.home * 0.5;
		const yard = nearSite(SIEGL.x, SIEGL.z);
		siteNear = yard || nearSite(YARD.x, YARD.z);
		for (const car of trucks) {
			if (car.duty) tend(car, car.duty, dt, siteNear);
			else if (!yard) car.e = -1;
			else if (car.e < 0) spawnTruck(car);
			else {
				place(car.e, car.dir, car.s);
				if (Math.hypot(at.x - SIEGL.x, at.z - SIEGL.z) > SIEGL.home * 1.8) spawnTruck(car);
			}
		}
		lanes.clear();
		for (const car of everyone) {
			if (car.e < 0) continue;
			const key = car.e * 2 + (car.dir > 0 ? 0 : 1);
			const list = lanes.get(key);
			if (list) list.push(car);
			else lanes.set(key, [car]);
		}
		for (const list of lanes.values()) {
			list.sort((a, b) => b.s - a.s);
			for (let i = 0; i < list.length; i++) {
				const car = list[i];
				let limit = car.vmax;
				if (i > 0) {
					const gap = list[i - 1].s - car.s;
					// a truck is longer than a car: more room in front of it, and more behind it
					const need = 1.3 + (list[i - 1].truck !== undefined ? 0.6 : 0) + (car.truck !== undefined ? 0.4 : 0);
					limit = Math.min(limit, Math.max(0, (gap - need) * 1.5));
				}
				car.v = car.v < limit ? Math.min(limit, car.v + 1.4 * dt) : Math.max(limit, car.v - 4 * dt);
				car.s += car.v * dt;
				while (car.e >= 0 && car.s >= len[car.e]) {
					const over = car.s - len[car.e];
					if (!next(car)) {
						car.e = -1;
						break;
					}
					car.s = over;
				}
			}
		}
	}

	const dummy = new Object3D();
	function pose() {
		bodies.visible = cabins.visible = truckMesh.visible = shown;
		const lit = lamps.begin();
		const trucksLit = truckLamps.begin();
		if (!shown) {
			lamps.end();
			truckLamps.end();
			return;
		}
		let n = 0;
		for (let i = 0; i < MAX; i++) {
			const car = cars[i];
			if (car.e < 0) continue;
			place(car.e, car.dir, car.s);
			const off = net.oneway[car.e] && net.cls[car.e] < 3 ? 0 : KEEP_RIGHT[net.cls[car.e]];
			const x = at.x - at.dz * off;
			const z = at.z + at.dx * off;
			const y = groundAt(x, z);
			dummy.position.set(x, y + 0.16, z);
			dummy.rotation.set(0, Math.atan2(at.dx, at.dz), 0);
			dummy.scale.set(0.5, 0.26, 0.95);
			dummy.updateMatrix();
			bodies.setMatrixAt(n, dummy.matrix);
			dummy.position.y = y + 0.38;
			dummy.translateZ(-0.05);
			dummy.scale.set(0.42, 0.2, 0.5);
			dummy.updateMatrix();
			cabins.setMatrixAt(n, dummy.matrix);
			bodies.setColorAt(n, colors[i]);
			if (lit) lamps.put(x, y + 0.2, z, at.dx, at.dz, 0.48, 0.15);
			n++;
		}
		let t = 0;
		for (const car of trucks) {
			const duty = car.duty;
			let x: number;
			let z: number;
			let heading: number;
			if (duty && duty.phase !== "road") {
				// in the yard or on the access road, off the streets of the map
				if (duty.phase === "away" || !siteNear) continue;
				onPath(duty.slot, duty.phase === "parked" ? 0 : duty.d);
				x = spot.x;
				z = spot.z;
				heading = duty.heading;
			} else {
				if (car.e < 0) continue;
				place(car.e, car.dir, car.s);
				const off = net.oneway[car.e] && net.cls[car.e] < 3 ? 0 : KEEP_RIGHT[net.cls[car.e]];
				x = at.x - at.dz * off;
				z = at.z + at.dx * off;
				heading = duty ? duty.heading : Math.atan2(at.dx, at.dz);
			}
			const y = groundAt(x, z);
			for (const { part, color } of kinds[car.truck!]) {
				dummy.position.set(x, y, z);
				dummy.rotation.set(0, heading, 0);
				dummy.translateX(part[0]);
				dummy.translateY(part[1]);
				dummy.translateZ(part[2]);
				dummy.scale.set(part[3], part[4], part[5]);
				dummy.updateMatrix();
				truckMesh.setMatrixAt(t, dummy.matrix);
				truckMesh.setColorAt(t, color);
				t++;
			}
			if (trucksLit && duty?.phase !== "parked") truckLamps.put(x, y + 0.3, z, Math.sin(heading), Math.cos(heading), TRUCK_LAMPS.half, TRUCK_LAMPS.wide);
		}
		truckMesh.count = t;
		truckMesh.instanceMatrix.needsUpdate = true;
		if (truckMesh.instanceColor) truckMesh.instanceColor.needsUpdate = true;
		truckLamps.end();
		lamps.end();
		bodies.count = cabins.count = n;
		bodies.instanceMatrix.needsUpdate = true;
		cabins.instanceMatrix.needsUpdate = true;
		if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
	}

	return { simulate, pose, cars, trucks };
}
