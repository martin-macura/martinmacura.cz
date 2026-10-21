// Made-up traffic on the real streets of Prague: cars drive the graph of praha-roads.dat, keep to the right, follow
// the one-way streets and keep a gap to the car in front. They live only around the view: a car that falls out of
// it comes back somewhere in it, so a few hundred cars are enough for the whole city.
import { Color, InstancedMesh, MeshLambertMaterial, Object3D, type Scene } from "three";
import type { RoadNet } from "./praha-roads";
import { COLORS, rng, unit } from "./util";
import type { Focus } from "./world";

const MAX = 420;
const SPEED = [0, 1.3, 2, 3]; // units a second, by class
const KEEP_RIGHT = [0, 0.24, 0.42, 0.62];
const CAR_COLORS = [COLORS.red, COLORS.yellow, COLORS.blue, COLORS.green, COLORS.white, 0xff9f2f, 0x7a6a9a, 0x2b2b2b, 0xb9b9b9, 0x9a2a2a].map((c) => new Color(c));
const CH = 32;

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

	const cars: Car[] = Array.from({ length: MAX }, () => ({ e: -1, dir: 1, s: 0, v: 0, vmax: 1 }));
	const colors = cars.map((_, i) => CAR_COLORS[i % CAR_COLORS.length]);

	/** puts the car on a random street of a random chunk in the view */
	function spawn(car: Car, f: Focus) {
		for (let tries = 0; tries < 8; tries++) {
			const cx = Math.floor((f.x + (rand() * 2 - 1) * f.r) / CH);
			const cz = Math.floor((f.z + (rand() * 2 - 1) * f.r) / CH);
			const segs = net.byChunk.get(cx * 1000 + cz);
			if (!segs) continue;
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

	// cars in the same lane of the same edge, to keep the gaps
	const lanes = new Map<number, Car[]>();
	let shown = false;

	function simulate(dt: number, f: Focus) {
		shown = !f.far;
		if (!shown) return;
		// the denser the view, the more cars, up to the pool
		const want = Math.min(MAX, Math.round((f.r * f.r) / 8));
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
	}

	const dummy = new Object3D();
	function pose() {
		bodies.visible = cabins.visible = shown;
		if (!shown) return;
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
			n++;
		}
		bodies.count = cabins.count = n;
		bodies.instanceMatrix.needsUpdate = true;
		cabins.instanceMatrix.needsUpdate = true;
		if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
	}

	return { simulate, pose, cars };
}
