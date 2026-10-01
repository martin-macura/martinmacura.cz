// Level crossings: a slab over the rails, barriers and flashing lights that react to the trains, and cars that
// drive over them and stop in front of a closed barrier.
import { Color, InstancedMesh, MeshBasicMaterial, MeshLambertMaterial, Object3D, type Scene, Vector3 } from "three";
import { type Edge, edgeAt, type Rails, type StationSite, TUNNELS } from "./rails";
import { distanceAlong, type Train } from "./trains";
import { box, clamp, COLORS, hash2, rng, unit } from "./util";

interface Lane {
	pts: Vector3[]; // the middle of the road, about a unit apart
	cum: number[];
	sCross: number; // where the rails are, along it
}

interface Car {
	lane: Lane;
	dir: 1 | -1;
	s: number;
	v: number;
	color: Color;
}

export interface Crossing {
	edge: Edge;
	d: number;
	pos: Vector3;
	axis: Vector3; // which way the road runs
	lane: Lane;
	watch: { train: Train; ri: number }[];
	danger: boolean; // a train is coming or still on it
	lightsOn: number; // seconds since the lights began to flash
	barrier: number; // 0 up, 1 down
}

const CAR_COLORS = [COLORS.red, COLORS.yellow, COLORS.blue, COLORS.green, COLORS.pink, COLORS.white, 0xff9f2f, 0x7a6a9a].map((c) => new Color(c));
const ARM_SEGMENTS = 4;

export function createCrossings(scene: Scene, rails: Rails, sites: StationSite[], isWater: (x: number, z: number) => boolean, roadAt: (x: number, z: number) => boolean) {
	const { edges, nodes, railDist } = rails;

	// no roads across the stations, the switches and the tunnels
	const tunnelPoints: [number, number][] = [];
	for (const [id, from, to] of TUNNELS) {
		const e = edges.get(id)!;
		for (let d = from - 4; d <= to + 4; d += 2) {
			const p = edgeAt(e, d);
			tunnelPoints.push([p.x, p.z]);
		}
	}
	const switchNodes = [...nodes.values()].filter((n) => n.ins.length > 1 || n.outs.length > 1);
	const noRoad = (x: number, z: number) => {
		for (const s of sites) if ((s.origin.x - x) ** 2 + (s.origin.z - z) ** 2 < 18 * 18) return true;
		for (const n of switchNodes) if ((n.pos.x - x) ** 2 + (n.pos.z - z) ** 2 < 12 * 12) return true;
		for (const [tx, tz] of tunnelPoints) if ((tx - x) ** 2 + (tz - z) ** 2 < 5 * 5) return true;
		return false;
	};
	const dry = (x: number, z: number) => roadAt(x, z) && !isWater(x, z) && !noRoad(x, z);

	// --- where does a road cross a track? (a road that runs along the track for a while is not a crossing)
	const found: { edge: Edge; d: number }[] = [];
	for (const e of edges.values()) {
		let run: { d0: number; d1: number } | null = null;
		const flush = () => {
			if (run && run.d1 - run.d0 <= 4.5) {
				const d = (run.d0 + run.d1) / 2;
				const last = found[found.length - 1];
				if (!last || last.edge !== e || d - last.d > 9) found.push({ edge: e, d });
			}
			run = null;
		};
		for (let d = 2; d < e.len - 2; d += 0.5) {
			const p = edgeAt(e, d);
			if (p.y < 0.3 && dry(p.x, p.z)) {
				if (run && d - run.d1 <= 1.6) run.d1 = d;
				else {
					flush();
					run = { d0: d, d1: d };
				}
			}
		}
		flush();
	}

	// --- the road through each one: its direction, and a line of points to drive along
	const trace = (x: number, z: number, dx: number, dz: number, length: number) => {
		const out: [number, number][] = [];
		let px = x;
		let pz = z;
		let heading = Math.atan2(dz, dx);
		for (let i = 0; i < length; i++) {
			let best: [number, number, number] | null = null;
			let bestScore = -1;
			for (let k = -3; k <= 3; k++) {
				const a = heading + k * 0.12;
				const nx = px + Math.cos(a);
				const nz = pz + Math.sin(a);
				if (!roadAt(nx, nz) || isWater(nx, nz)) continue;
				const score = (roadAt(px + Math.cos(a) * 2.5, pz + Math.sin(a) * 2.5) ? 2 : 0) + 1 - Math.abs(k) / 4;
				if (score > bestScore) {
					bestScore = score;
					best = [a, nx, nz];
				}
			}
			if (!best) break;
			[heading, px, pz] = best;
			out.push([px, pz]);
		}
		return out;
	};
	const smoothLine = (pts: [number, number][]) =>
		pts.map((_, i) => {
			let sx = 0;
			let sz = 0;
			let n = 0;
			for (let k = Math.max(0, i - 3); k <= Math.min(pts.length - 1, i + 3); k++) {
				sx += pts[k][0];
				sz += pts[k][1];
				n++;
			}
			return [sx / n, sz / n] as [number, number];
		});

	const crossings: Crossing[] = [];
	for (const { edge, d } of found) {
		const pos = edgeAt(edge, d);
		// the direction in which the road runs on longest either side of the rails
		let bestA = 0;
		let bestCount = -1;
		for (let a = 0; a < Math.PI; a += Math.PI / 18) {
			let count = 0;
			for (let s = -9; s <= 9; s++) if (roadAt(pos.x + Math.cos(a) * s, pos.z + Math.sin(a) * s) && !isWater(pos.x + Math.cos(a) * s, pos.z + Math.sin(a) * s)) count++;
			if (count > bestCount) {
				bestCount = count;
				bestA = a;
			}
		}
		const ax = Math.cos(bestA);
		const az = Math.sin(bestA);
		const back = smoothLine(trace(pos.x, pos.z, -ax, -az, 42)).reverse();
		const fwd = smoothLine(trace(pos.x, pos.z, ax, az, 42));
		const line: [number, number][] = [...back, [pos.x, pos.z], ...fwd];
		if (back.length < 8 || fwd.length < 8) continue; // a dead end: no traffic, and no barrier worth building
		const pts = line.map(([x, z]) => new Vector3(x, 0.17, z));
		const cum = [0];
		for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
		const lane: Lane = { pts, cum, sCross: cum[back.length] };
		crossings.push({ edge, d, pos, axis: new Vector3(ax, 0, az), lane, watch: [], danger: false, lightsOn: 0, barrier: 0 });
	}

	// --- what stands there: the slab over the rails, the posts (all fixed, so they are merged with the rest)
	const up = new Vector3(0, 1, 0);
	for (const c of crossings) {
		const t = edgeAt(c.edge, c.d + 0.3).sub(edgeAt(c.edge, c.d - 0.3)).setY(0).normalize();
		const yaw = Math.atan2(t.x, t.z);
		const slab = box(scene, 1.7, 0.13, 2.9, COLORS.road, c.pos.x, c.pos.y + 0.085, c.pos.z);
		slab.rotation.y = yaw;
		const perp = new Vector3().crossVectors(c.axis, up); // across the road
		for (const side of [1, -1]) {
			const post = c.pos.clone().addScaledVector(c.axis, side * 2.7).addScaledVector(perp, -1.5);
			box(scene, 0.12, 1.1, 0.12, COLORS.dark, post.x, post.y + 0.55, post.z);
			// the cross: St Andrew's, white with red edges
			const cross = box(scene, 0.7, 0.12, 0.05, COLORS.white, post.x, post.y + 1.0, post.z);
			cross.rotation.y = Math.atan2(perp.x, perp.z);
			cross.rotation.z = 0.6;
		}
	}

	const roadOK = (x: number, z: number) => {
		if (noRoad(x, z)) return false;
		if (railDist(x, z) > 1.4) return true;
		for (const c of crossings) if ((c.pos.x - x) ** 2 + (c.pos.z - z) ** 2 < 3.6 * 3.6) return true;
		return false;
	};

	// --- everything that moves, made once the trains exist
	function attach(trains: Train[]) {
		const rand = rng(11);
		for (const c of crossings) {
			for (const train of trains) {
				const ri = train.route.indexOf(c.edge);
				if (ri >= 0) c.watch.push({ train, ri });
			}
		}

		const dummy = new Object3D();
		// barrier arms: four segments each, two arms per crossing
		const armMat = new MeshLambertMaterial({ color: 0xffffff });
		const arms = new InstancedMesh(unit, armMat, crossings.length * 2 * ARM_SEGMENTS);
		arms.frustumCulled = false;
		arms.userData.dynamic = true;
		const red = new Color(0xe03a2c);
		const white = new Color(0xf2f2f2);
		for (let i = 0; i < crossings.length * 2; i++) for (let k = 0; k < ARM_SEGMENTS; k++) arms.setColorAt(i * ARM_SEGMENTS + k, k % 2 ? white : red);
		scene.add(arms);

		const lampOn = new Color(0xff3b30);
		const lampOff = new Color(0x3a1512);
		const lamps = new InstancedMesh(unit, new MeshBasicMaterial({ color: 0xffffff }), crossings.length * 4);
		lamps.frustumCulled = false;
		lamps.userData.dynamic = true;
		for (let i = 0; i < crossings.length * 4; i++) lamps.setColorAt(i, lampOff);
		scene.add(lamps);

		// cars
		const cars: Car[] = [];
		for (const c of crossings) {
			const total = c.lane.cum[c.lane.cum.length - 1];
			for (const dir of [1, -1] as const) {
				for (let i = 0; i < 2; i++) cars.push({ lane: c.lane, dir, s: rand() * total, v: 1 + rand(), color: CAR_COLORS[hash2(cars.length, 3) % CAR_COLORS.length] });
			}
		}
		const bodies = new InstancedMesh(unit, new MeshLambertMaterial({ color: 0xffffff }), Math.max(1, cars.length));
		const cabins = new InstancedMesh(unit, new MeshLambertMaterial({ color: 0xffffff }), Math.max(1, cars.length));
		for (const m of [bodies, cabins]) {
			m.frustumCulled = false;
			m.userData.dynamic = true;
			scene.add(m);
		}
		cars.forEach((car, i) => {
			bodies.setColorAt(i, car.color);
			cabins.setColorAt(i, new Color(0x1c2232));
		});

		const laneAt = (lane: Lane, s: number, out: Vector3) => {
			s = clamp(s, 0, lane.cum[lane.cum.length - 1]);
			let lo = 0;
			let hi = lane.pts.length - 2;
			while (lo < hi) {
				const m = (lo + hi + 1) >> 1;
				if (lane.cum[m] <= s) lo = m;
				else hi = m - 1;
			}
			const span = lane.cum[lo + 1] - lane.cum[lo] || 1;
			return out.lerpVectors(lane.pts[lo], lane.pts[lo + 1], (s - lane.cum[lo]) / span);
		};

		const pa = new Vector3();
		const pb = new Vector3();
		let time = 0;
		function simulate(dt: number) {
			time += dt;
			for (const c of crossings) {
				let danger = false;
				for (const { train, ri } of c.watch) {
					const ahead = distanceAlong(train, ri, c.d);
					const lap = train.route.reduce((sum, e) => sum + e.len, 0);
					if (ahead <= 10 + 4 * train.v || lap - ahead <= train.len + 3) danger = true;
				}
				c.danger = danger;
				c.lightsOn = danger ? c.lightsOn + dt : 0;
				const target = danger && c.lightsOn > 1.6 ? 1 : 0;
				c.barrier = clamp(c.barrier + Math.sign(target - c.barrier) * dt * 0.8, Math.min(c.barrier, target), Math.max(c.barrier, target));
			}

			// cars: drive on, brake for a closed crossing, keep a gap to the one in front
			const byCrossing = new Map<Lane, Crossing>();
			for (const c of crossings) byCrossing.set(c.lane, c);
			for (const car of cars) {
				const c = byCrossing.get(car.lane)!;
				const total = car.lane.cum[car.lane.cum.length - 1];
				let limit = 2.4;
				if (c.danger) {
					// the stop line is 3 units before the rails, as seen by this car
					const toLine = car.dir > 0 ? car.lane.sCross - 3 - car.s : car.s - (car.lane.sCross + 3);
					if (toLine > -0.3) limit = Math.min(limit, Math.sqrt(2 * 2.2 * Math.max(0, toLine)));
				}
				for (const other of cars) {
					if (other === car || other.lane !== car.lane || other.dir !== car.dir) continue;
					const gap = (other.s - car.s) * car.dir;
					if (gap > 0 && gap < 6) limit = Math.min(limit, Math.max(0, (gap - 1.3) * 1.5));
				}
				car.v = car.v < limit ? Math.min(limit, car.v + 1.6 * dt) : Math.max(limit, car.v - 4 * dt);
				car.s += car.dir * car.v * dt;
				if (car.s > total + 1) car.s = -0.5 - rand() * 4;
				if (car.s < -1) car.s = total + 0.5 + rand() * 4;
			}
		}

		function pose() {
			const flash = Math.floor(time * 2.2) % 2;
			crossings.forEach((c, i) => {
				const perp = new Vector3().crossVectors(c.axis, new Vector3(0, 1, 0)); // across the road
				const yaw = Math.atan2(perp.x, perp.z);
				[1, -1].forEach((side, k) => {
					const post = c.pos.clone().addScaledVector(c.axis, side * 2.7).addScaledVector(perp, -1.5);
					const angle = (1 - c.barrier) * 1.25; // raised: 1.25 rad up
					for (let seg = 0; seg < ARM_SEGMENTS; seg++) {
						const along = 0.35 + seg * 0.7; // along the arm, from the post
						dummy.position.set(post.x + perp.x * along * Math.cos(angle), post.y + 0.95 + along * Math.sin(angle), post.z + perp.z * along * Math.cos(angle));
						dummy.rotation.set(0, yaw, 0);
						dummy.rotateX(-angle);
						dummy.scale.set(0.1, 0.1, 0.7);
						dummy.updateMatrix();
						arms.setMatrixAt((i * 2 + k) * ARM_SEGMENTS + seg, dummy.matrix);
					}
					for (const [m, offset] of [[0, -0.22], [1, 0.22]] as const) {
						dummy.position.set(post.x + perp.x * offset, post.y + 1.35, post.z + perp.z * offset);
						dummy.rotation.set(0, 0, 0);
						dummy.scale.set(0.2, 0.2, 0.2);
						dummy.updateMatrix();
						const idx = i * 4 + k * 2 + m;
						lamps.setMatrixAt(idx, dummy.matrix);
						lamps.setColorAt(idx, c.danger && (flash + m) % 2 === 0 ? lampOn : lampOff);
					}
				});
			});
			arms.instanceMatrix.needsUpdate = true;
			lamps.instanceMatrix.needsUpdate = true;
			if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;

			cars.forEach((car, i) => {
				laneAt(car.lane, car.s, pa);
				laneAt(car.lane, car.s + car.dir * 0.6, pb);
				const dx = (pb.x - pa.x) * car.dir;
				const dz = (pb.z - pa.z) * car.dir;
				const len = Math.hypot(dx, dz) || 1;
				// keep to the right
				const rx = -dz / len;
				const rz = dx / len;
				const yaw = Math.atan2(dx, dz);
				dummy.position.set(pa.x + rx * 0.4, 0.2, pa.z + rz * 0.4);
				dummy.rotation.set(0, yaw, 0);
				dummy.scale.set(0.5, 0.26, 0.95);
				dummy.updateMatrix();
				bodies.setMatrixAt(i, dummy.matrix);
				dummy.position.y = 0.43;
				dummy.translateZ(-0.05);
				dummy.scale.set(0.42, 0.2, 0.5);
				dummy.updateMatrix();
				cabins.setMatrixAt(i, dummy.matrix);
			});
			bodies.instanceMatrix.needsUpdate = true;
			cabins.instanceMatrix.needsUpdate = true;
			if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
			if (cabins.instanceColor) cabins.instanceColor.needsUpdate = true;
		}

		return { simulate, pose, cars };
	}

	return { crossings, roadOK, attach };
}
