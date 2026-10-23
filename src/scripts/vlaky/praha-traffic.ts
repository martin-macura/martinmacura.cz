// Made-up traffic on the real streets of Prague: cars drive the graph of praha-roads.dat, keep to the right, follow
// the one-way streets and keep a gap to the car in front. They live only around the view: a car that falls out of
// it comes back somewhere in it, so a few hundred cars are enough for the whole city.
import { Color, InstancedMesh, MeshBasicMaterial, MeshLambertMaterial, Object3D, type Scene } from "three";
import type { RoadNet } from "./praha-roads";
import { AWAY, COME_FROM, JOIN, SLOTS, TRUCK_PARTS, TRUCKS, YARD, YARD_PATH } from "./praha-siegl";
import { COLORS, glow, rng, unit } from "./util";
import { type Focus, type Place, VEHICLES_UP_TO } from "./world";

const MAX = 420;
const SPEED = [0, 1.3, 2, 3]; // units a second, by class
const KEEP_RIGHT = [0, 0.24, 0.42, 0.62];
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
}

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
		let best = -1;
		let bestScore = -Infinity;
		for (let k = outCount[node]; k < outCount[node + 1]; k++) {
			const e = outs[k] >> 1;
			const dir = outs[k] & 1 ? -1 : 1;
			if (!ok(e)) continue;
			if (e === car.e && dir === -car.dir) continue;
			place(e, dir, Math.min(0.5, len[e]));
			const straight = hx * at.dx + hz * at.dz; // 1 straight on, -1 back
			const score = straight + rand() * 1.6 + (net.cls[e] === net.cls[car.e] ? 0.3 : 0);
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

	const cars: Car[] = Array.from({ length: MAX + TRUCKS }, () => ({ e: -1, dir: 1, s: 0, v: 0, vmax: 1 })); // the last ones are the lorries of SIEGL
	const colors = cars.map((_, i) => CAR_COLORS[i % CAR_COLORS.length]);

	/** puts the car on a random street of a random chunk in the view */
	function spawn(car: Car, f: Focus) {
		for (let tries = 0; tries < 12; tries++) {
			const cx = Math.floor((f.x + (rand() * 2 - 1) * f.r) / CH);
			const cz = Math.floor((f.z + (rand() * 2 - 1) * f.r) / CH);
			const segs = net.byChunk.get(cx * 1000 + cz);
			// a chunk with few streets gets few cars, or its one road would jam
			if (!segs || rand() * 120 > segs.length) continue;
			const e = net.segEdge[segs[Math.floor(rand() * segs.length)]];
			if (!ok(e)) continue;
			car.e = e;
			car.dir = net.oneway[e] || rand() < 0.5 ? 1 : -1;
			car.s = rand() * len[e];
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

	const lamps = createLamps(scene, MAX + TRUCKS);

	// --- the lorries of SIEGL (praha-siegl.ts): out of the yard and down the service road into Teplárenská, along the
	// streets as far as AWAY from the yard, then out of sight for a while; some come back, turn in and park
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
					const along = cum[i] + t;
					best = { e, dir, s: dir > 0 ? along : len[e] - along, d };
				}
			}
		}
		return best;
	};
	const join = locate(JOIN.x, JOIN.z); // where the service road meets the street
	const comeFrom = locate(COME_FROM.x, COME_FROM.z); // and where the lorries that come back join it
	const fleetOK = join.d < 6 && comeFrom.d < 6;
	const paths = SLOTS.map((slot) => [slot, ...YARD_PATH]);
	const pathLen = paths.map((p) => p.reduce((sum, q, i) => sum + (i ? Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) : 0), 0));
	/** the point at distance d along the way out of slot k, in `at` */
	function onPath(k: number, d: number) {
		const p = paths[k];
		let i = 0;
		let left = Math.max(0, d);
		while (i < p.length - 2 && left > Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1])) {
			left -= Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
			i++;
		}
		const l = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]) || 1;
		const f = Math.min(1, left / l);
		at.x = p[i][0] + (p[i + 1][0] - p[i][0]) * f;
		at.z = p[i][1] + (p[i + 1][1] - p[i][1]) * f;
		at.dx = (p[i + 1][0] - p[i][0]) / l;
		at.dz = (p[i + 1][1] - p[i][1]) / l;
	}
	type Phase = "parked" | "out" | "road" | "away" | "in";
	const trucks = Array.from({ length: TRUCKS }, (_, k) => ({ car: cars[MAX + k], phase: "parked" as Phase, d: 0, wait: 1 + k * 4 + rand() * 5, slot: k, homing: false, stuck: 0 }));
	const YARD_SPEED = 1.5;
	function takeTheStreet(t: (typeof trucks)[number], where: typeof join, homing: boolean) {
		const car = t.car;
		car.e = where.e;
		car.dir = where.dir;
		car.s = where.s;
		car.v = 0.3;
		car.vmax = SPEED[net.cls[car.e]] * 0.85;
		t.phase = "road";
		t.homing = homing;
	}
	function simulateTrucks(dt: number) {
		if (!fleetOK) return;
		for (const t of trucks) {
			const car = t.car;
			switch (t.phase) {
				case "parked":
					if ((t.wait -= dt) <= 0) {
						t.phase = "out";
						t.d = 0;
					}
					break;
				case "out":
					t.d += YARD_SPEED * dt;
					if (t.d >= pathLen[t.slot]) takeTheStreet(t, join, false);
					break;
				case "road":
					if (car.e < 0) {
						t.phase = "away";
						t.wait = 3 + rand() * 8;
						break;
					}
					place(car.e, car.dir, car.s);
					if (Math.hypot(at.x - YARD.x, at.z - YARD.z) > AWAY) {
						car.e = -1;
						t.phase = "away";
						t.wait = 4 + rand() * 10;
					} else if (t.homing && car.e === join.e && car.dir === join.dir && car.s >= join.s) {
						car.e = -1;
						t.phase = "in";
						t.d = pathLen[t.slot];
					} else {
						// in a jam for good: off on a job, and back later, rather than stand for ever
						t.stuck = car.v < 0.05 ? t.stuck + dt : 0;
						if (t.stuck > 20) {
							car.e = -1;
							t.phase = "away";
							t.wait = 3 + rand() * 6;
							t.stuck = 0;
						}
					}
					break;
				case "away":
					if ((t.wait -= dt) <= 0) takeTheStreet(t, comeFrom, true);
					break;
				case "in":
					t.d -= YARD_SPEED * dt;
					if (t.d <= 0) {
						t.phase = "parked";
						t.wait = 8 + rand() * 20;
					}
					break;
			}
		}
	}
	const truckParts = new InstancedMesh(unit, new MeshLambertMaterial({ color: 0xffffff }), TRUCKS * TRUCK_PARTS.length);
	{
		const tint = new Color();
		for (let k = 0; k < TRUCKS; k++) TRUCK_PARTS.forEach((part, i) => truckParts.setColorAt(k * TRUCK_PARTS.length + i, tint.setHex(part[3])));
	}
	truckParts.frustumCulled = false;
	truckParts.userData.dynamic = true;
	truckParts.count = TRUCKS * TRUCK_PARTS.length;
	scene.add(truckParts);
	const part = new Object3D();
	function poseTrucks(lit: boolean) {
		trucks.forEach((t, k) => {
			const seen = fleetOK && t.phase !== "away";
			let x = 0;
			let z = 0;
			let angle = 0;
			if (seen) {
				if (t.phase === "road") {
					place(t.car.e, t.car.dir, t.car.s);
					const off = net.oneway[t.car.e] && net.cls[t.car.e] < 3 ? 0 : KEEP_RIGHT[net.cls[t.car.e]];
					x = at.x - at.dz * off;
					z = at.z + at.dx * off;
					angle = Math.atan2(at.dx, at.dz);
				} else {
					onPath(t.slot, t.phase === "parked" ? 0 : t.d);
					x = at.x;
					z = at.z;
					angle = Math.atan2(at.dx, at.dz);
					// a lorry that comes in turns round over the last stretch, to stand as it will leave
					if (t.phase === "in") angle += Math.PI * (t.d > 1.4 ? 1 : t.d / 1.4);
				}
			}
			const y = seen ? groundAt(x, z) - 0.01 : 0;
			const c = Math.cos(angle);
			const sn = Math.sin(angle);
			TRUCK_PARTS.forEach(([w, h, d, , px, py, pz], i) => {
				if (seen) {
					part.position.set(x + px * c + pz * sn, y + py, z - px * sn + pz * c);
					part.rotation.set(0, angle, 0);
					part.scale.set(w, h, d);
				} else {
					part.scale.set(0, 0, 0);
				}
				part.updateMatrix();
				truckParts.setMatrixAt(k * TRUCK_PARTS.length + i, part.matrix);
			});
			if (seen && lit) lamps.put(x, y + 0.2, z, Math.sin(angle), Math.cos(angle), 0.82, 0.22);
		});
		truckParts.instanceMatrix.needsUpdate = true;
	}

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
		lanes.clear();
		for (const car of cars) {
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
					limit = Math.min(limit, Math.max(0, (gap - 1.3) * 1.5));
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
		simulateTrucks(dt);
	}

	const dummy = new Object3D();
	function pose() {
		bodies.visible = cabins.visible = truckParts.visible = shown;
		const lit = lamps.begin();
		if (!shown) {
			lamps.end();
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
		poseTrucks(lit);
		lamps.end();
		bodies.count = cabins.count = n;
		bodies.instanceMatrix.needsUpdate = true;
		cabins.instanceMatrix.needsUpdate = true;
		if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
	}

	/** the name of the yard over the scene, close up */
	const places = (): Place[] => [{ x: YARD.x, y: groundAt(YARD.x, YARD.z) + 1.9, z: YARD.z, name: "SIEGL", rank: 1 }];
	return { simulate, pose, cars, places };
}
