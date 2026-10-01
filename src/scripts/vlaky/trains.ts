// Trains of all sorts, the stations, and the people on the platforms.
import { Group, Mesh, MeshBasicMaterial, type Scene, Sprite, SpriteMaterial, CanvasTexture, NearestFilter, Vector3 } from "three";
import { type Edge, edgeAt, LINES, type Rails, type StationSite } from "./rails";
import { box, COLORS, glass, glow, unit } from "./util";

export type CarKind = "loco" | "diesel" | "steam" | "tender" | "coach" | "dcoach" | "railcar" | "tank" | "box" | "flat" | "hopper";
const LENGTH: Record<CarKind, number> = { loco: 2.1, diesel: 2.2, steam: 2.4, tender: 1.4, coach: 1.9, dcoach: 1.9, railcar: 2.6, tank: 1.6, box: 1.6, flat: 1.7, hopper: 1.6 };
const PASSENGER = new Set<CarKind>(["coach", "dcoach", "railcar"]);
const GAP = 0.12;
const ACCEL = 1.4;
const DECEL = 1.8;
const DWELL = 8;

export interface Train {
	cars: Group[];
	back: number[]; // distance from the front of the train to the middle of each car
	len: number;
	doors: number[]; // where the doors are, along the platform from the middle of the stopped train
	vmax: number;
	route: Edge[];
	ri: number; // the edge the front is on
	d: number; // how far along it
	v: number;
	stops: { ri: number; d: number; station: Station }[]; // where the front is when the train stands at a platform
	stopIdx: number;
	stopped: Station | null;
	clock: number;
	blocked: boolean;
	leaving: boolean; // just left a platform: the stop it stood at is not the next one
	lap: number; // length of the whole route
	visits: number;
	smokeAt: Vector3; // in the local space of the first car
	smoke: { mesh: Mesh; age: number }[];
	smokeClock: number;
	smokeNext: number;
}

interface Person {
	mesh: Group;
	state: "away" | "enter" | "wait" | "board" | "alight";
	u: number; // along the platform from the middle of the stopped train
	v: number; // across it, from the rail
	slot: number;
	door: number;
	exitU: number;
	timer: number;
	boardAt: number;
	phase: number;
	walking: boolean;
}

export interface Station extends StationSite {
	people: Person[];
	slots: (Person | null)[];
	train: Train | null;
}

const SLOTS: [number, number][] = [-4.5, -3, -1.5, 0, 1.5, 3, 4.5].map((u, i) => [u, i % 2 ? 1.95 : 1.35]);
const WALK = 1.3;
const SKINS = [0xf1c27d, 0xe0ac69, 0x8d5524, 0xffdbac];
const COATS = [0xff5c4d, 0x3d7bff, 0xffcf33, 0x2fd487, 0xff7ab8, 0xf2f2f2, 0x7a6a9a];

const glassBox = (g: Group, w: number, h: number, d: number, x: number, y: number, z: number, m = glass) => {
	const mesh = new Mesh(unit, m);
	mesh.scale.set(w, h, d);
	mesh.position.set(x, y, z);
	g.add(mesh);
};

function buildCar(kind: CarKind, index: number, body: number, stripe: number) {
	const len = LENGTH[kind];
	const g = new Group();
	const chassis = () => {
		box(g, 0.9, 0.12, len - 0.3, COLORS.dark, 0, 0.12, 0);
		for (const z of [-len * 0.3, len * 0.3]) box(g, 0.98, 0.16, 0.5, COLORS.dark, 0, 0.1, z);
	};
	chassis();
	switch (kind) {
		case "diesel":
		case "loco": {
			box(g, 1.05, 0.7, len, body, 0, 0.5, 0);
			box(g, 1.07, 0.1, len, stripe, 0, 0.3, 0);
			box(g, 1.1, 0.1, len + 0.04, stripe, 0, 0.88, 0);
			glassBox(g, 0.8, 0.26, 0.06, 0, 0.68, len / 2 + 0.01);
			for (const x of [-0.3, 0.3]) glassBox(g, 0.14, 0.12, 0.06, x, 0.3, len / 2 + 0.02, glow);
			glassBox(g, 1.07, 0.2, len * 0.3, 0, 0.66, -len * 0.3);
			if (kind === "loco") {
				box(g, 0.7, 0.12, 0.7, COLORS.dark, 0, 1, -0.1); // pantograph
				box(g, 0.08, 0.3, 0.08, COLORS.dark, 0, 1.15, -0.1);
			} else {
				box(g, 0.5, 0.25, 0.7, stripe, 0, 1.05, -0.3); // engine hood
			}
			break;
		}
		case "steam": {
			box(g, 0.85, 0.85, len - 0.8, COLORS.dark, 0, 0.6, 0.4); // boiler
			box(g, 0.9, 0.12, len - 0.8, body, 0, 0.98, 0.4);
			box(g, 0.3, 0.45, 0.3, COLORS.dark, 0, 1.25, 0.85); // chimney
			box(g, 0.45, 0.14, 0.45, COLORS.dark, 0, 1.52, 0.85);
			box(g, 0.4, 0.3, 0.4, COLORS.yellow, 0, 1.15, 0.2); // dome
			box(g, 1.05, 0.95, 0.8, body, 0, 0.66, -len / 2 + 0.4); // cab
			box(g, 1.12, 0.12, 0.92, COLORS.dark, 0, 1.2, -len / 2 + 0.4);
			glassBox(g, 1.07, 0.25, 0.4, 0, 0.85, -len / 2 + 0.4);
			glassBox(g, 0.2, 0.2, 0.06, 0, 0.45, len / 2, glow);
			for (const z of [-0.5, 0.1, 0.7]) box(g, 1.02, 0.3, 0.3, body, 0, 0.22, z); // wheels
			break;
		}
		case "tender":
			box(g, 0.95, 0.45, len, COLORS.dark, 0, 0.42, 0);
			box(g, 0.8, 0.3, len - 0.3, 0x2a2a2a, 0, 0.75, 0);
			break;
		case "coach":
		case "dcoach": {
			const tall = kind === "dcoach" ? 1.0 : 0.7;
			box(g, 1.05, tall, len, body, 0, 0.3 + tall / 2, 0);
			box(g, 1.07, 0.1, len, stripe, 0, 0.3, 0);
			box(g, 1.1, 0.1, len + 0.04, stripe, 0, 0.3 + tall + 0.05, 0);
			glassBox(g, 1.07, 0.22, len * 0.78, 0, 0.66, 0);
			if (kind === "dcoach") glassBox(g, 1.07, 0.22, len * 0.78, 0, 1.02, 0);
			break;
		}
		case "railcar": {
			box(g, 1.05, 0.72, len, body, 0, 0.5, 0);
			box(g, 1.07, 0.1, len, stripe, 0, 0.3, 0);
			box(g, 1.1, 0.12, len + 0.04, stripe, 0, 0.9, 0);
			glassBox(g, 1.07, 0.22, len * 0.6, 0, 0.66, 0);
			for (const s of [1, -1]) glassBox(g, 0.8, 0.26, 0.06, 0, 0.68, (s * len) / 2 + s * 0.01);
			glassBox(g, 0.16, 0.12, 0.06, -0.3, 0.3, len / 2 + 0.02, glow);
			glassBox(g, 0.16, 0.12, 0.06, 0.3, 0.3, len / 2 + 0.02, glow);
			box(g, 0.6, 0.2, 0.9, COLORS.dark, 0, 1.06, 0);
			break;
		}
		case "tank":
			box(g, 0.95, 0.12, len, COLORS.dark, 0, 0.3, 0);
			box(g, 0.85, 0.6, len - 0.25, body, 0, 0.66, 0);
			box(g, 0.6, 0.15, len - 0.45, body, 0, 1.03, 0);
			box(g, 0.3, 0.12, 0.3, COLORS.dark, 0, 1.16, 0);
			break;
		case "box":
			box(g, 0.95, 0.12, len, COLORS.dark, 0, 0.3, 0);
			box(g, 1.0, 0.8, len - 0.1, index % 2 ? 0x8a4a2f : 0x5b6b8a, 0, 0.76, 0);
			box(g, 1.02, 0.7, 0.5, 0x2a2a2a, 0, 0.74, 0);
			break;
		case "flat":
			box(g, 1.0, 0.18, len, COLORS.dark, 0, 0.36, 0);
			if (index % 2) {
				for (const x of [-0.25, 0.25]) box(g, 0.4, 0.4, len - 0.2, 0x7a5a3a, x, 0.65, 0);
				box(g, 0.4, 0.4, len - 0.2, 0x8a6a48, 0, 1.05, 0);
			} else {
				box(g, 0.9, 0.6, len - 0.2, [0xff5c4d, 0x3d7bff, 0xffcf33][index % 3], 0, 0.75, 0);
			}
			break;
		case "hopper":
			box(g, 0.95, 0.12, len, COLORS.dark, 0, 0.3, 0);
			box(g, 1.0, 0.6, len - 0.1, 0x3a3a3a, 0, 0.66, 0);
			box(g, 0.8, 0.25, len - 0.4, 0x121212, 0, 1.08, 0);
			break;
	}
	return g;
}

/** distance the front still has to go to reach the point `sd` on edge `sri` of the route */
export function distanceAlong(tr: Train, sri: number, sd: number) {
	if (sri === tr.ri && sd >= tr.d) return sd - tr.d;
	const n = tr.route.length;
	let dist = tr.route[tr.ri].len - tr.d;
	for (let i = (tr.ri + 1) % n, guard = 0; i !== sri && guard < n; i = (i + 1) % n, guard++) dist += tr.route[i].len;
	return dist + sd;
}

interface TrainSpec {
	line: keyof typeof LINES;
	ri: number;
	d: number;
	body: number;
	stripe: number;
	cars: CarKind[];
	stops: "all" | "major" | "none";
	vmax: number;
}
const SPECS: TrainSpec[] = [
	{ line: "outer", ri: 3, d: 25, body: COLORS.red, stripe: COLORS.white, cars: ["diesel", "coach", "coach"], stops: "all", vmax: 4.2 },
	{ line: "shortcutTop", ri: 6, d: 22, body: COLORS.blue, stripe: COLORS.yellow, cars: ["loco", "coach", "coach", "coach", "dcoach"], stops: "major", vmax: 5.2 },
	{ line: "inner", ri: 2, d: 20, body: COLORS.yellow, stripe: COLORS.dark, cars: ["railcar", "railcar"], stops: "all", vmax: 4 },
	{ line: "shortcutBottom", ri: 6, d: 30, body: COLORS.green, stripe: COLORS.white, cars: ["steam", "tender", "coach", "coach"], stops: "all", vmax: 3.4 },
	{ line: "outer", ri: 9, d: 30, body: 0x8a4a2f, stripe: COLORS.yellow, cars: ["diesel", "tank", "tank", "box", "flat", "hopper", "box", "tank"], stops: "none", vmax: 3 },
	{ line: "inner", ri: 6, d: 22, body: COLORS.pink, stripe: COLORS.white, cars: ["loco", "flat", "box", "tank"], stops: "none", vmax: 3.2 },
	{ line: "outer", ri: 11, d: 20, body: 0xff9f2f, stripe: COLORS.dark, cars: ["railcar"], stops: "all", vmax: 4.4 },
];

const labelTexture = (text: string) => {
	const c = document.createElement("canvas");
	c.width = 64;
	c.height = 16;
	const g = c.getContext("2d")!;
	g.fillStyle = "#f2f2f2";
	g.fillRect(0, 0, 64, 16);
	g.fillStyle = "#0c0c0c";
	g.fillRect(0, 0, 64, 1);
	g.fillRect(0, 15, 64, 1);
	g.font = `${text.length > 7 ? 7 : 8}px "Press Start 2P", monospace`;
	g.textBaseline = "middle";
	g.textAlign = "center";
	g.fillText(text, 32, 9);
	const tex = new CanvasTexture(c);
	tex.magFilter = NearestFilter;
	tex.minFilter = NearestFilter;
	return tex;
};

export function createTraffic(
	scene: Scene,
	rails: Rails,
	scenery: { signals: { edge: Edge; light: Mesh }[]; switches: { node: import("./rails").RailNode; lever: Mesh; head: Mesh; tongues: Map<Edge, Group> }[]; lamp: { red: MeshBasicMaterial; green: MeshBasicMaterial; yellow: MeshBasicMaterial } },
	sites: StationSite[],
	rand: () => number,
) {
	const { edges, nodes } = rails;

	// --- stations
	const stations: Station[] = sites.map((site) => {
		const { origin, t, n } = site;
		const station: Station = { ...site, people: [], slots: SLOTS.map(() => null), train: null };
		const place = (u: number, v: number) => origin.clone().addScaledVector(t, u).addScaledVector(n, v);
		const yaw = Math.atan2(t.x, t.z);
		const plat = box(scene, 1.6, 0.25, 11, COLORS.platform, 0, 0.125, 0);
		plat.position.copy(place(0, 1.7)).setY(0.125);
		plat.rotation.y = yaw;
		const lip = box(scene, 0.12, 0.26, 11, COLORS.yellow, 0, 0.125, 0);
		lip.position.copy(place(0, 0.94)).setY(0.125);
		lip.rotation.y = yaw;
		for (const u of [-4.8, 0, 4.8]) {
			const p = place(u, 2.3);
			box(scene, 0.08, 1.2, 0.08, COLORS.dark, p.x, 0.85, p.z);
			const head = new Mesh(unit, glow);
			head.scale.set(0.22, 0.16, 0.22);
			head.position.set(p.x, 1.52, p.z);
			scene.add(head);
		}
		const post = place(-5.2, 2.35);
		box(scene, 0.1, 2, 0.1, COLORS.dark, post.x, 1.2, post.z);
		const label = new Sprite(new SpriteMaterial({ map: labelTexture(site.name), depthTest: false }));
		label.renderOrder = 10; // signs stay readable even behind a building
		label.scale.set(5.6, 1.4, 1);
		label.position.set(post.x + t.x, 2.7, post.z + t.z);
		scene.add(label);
		for (let i = 0; i < 9; i++) {
			const mesh = new Group();
			box(mesh, 0.2, 0.14, 0.14, COLORS.dark, 0, 0.07, 0);
			box(mesh, 0.28, 0.34, 0.2, COATS[Math.floor(rand() * COATS.length)], 0, 0.31, 0);
			box(mesh, 0.22, 0.22, 0.22, SKINS[Math.floor(rand() * SKINS.length)], 0, 0.59, 0);
			scene.add(mesh);
			station.people.push({ mesh, state: "away", u: 0, v: 0, slot: -1, door: 0, exitU: 0, timer: rand() * 10, boardAt: -1, phase: rand() * 10, walking: false });
		}
		// a few people are already waiting
		station.people.slice(0, 4).forEach((p, i) => {
			p.state = "wait";
			p.slot = [0, 2, 4, 6][i];
			station.slots[p.slot] = p;
			[p.u, p.v] = SLOTS[p.slot];
		});
		return station;
	});

	// --- trains
	const smokeMat = new MeshBasicMaterial({ color: 0xdddddd });
	const trains: Train[] = SPECS.map((spec) => {
		const route = LINES[spec.line].map((id) => edges.get(id)!);
		const cars = spec.cars.map((kind, i) => {
			const g = buildCar(kind, i, spec.body, spec.stripe);
			scene.add(g);
			return g;
		});
		const back: number[] = [];
		let at = 0;
		spec.cars.forEach((kind, i) => {
			back.push(at + LENGTH[kind] / 2);
			at += LENGTH[kind] + (i < spec.cars.length - 1 ? GAP : 0);
		});
		const len = at;
		const doors = spec.cars.flatMap((kind, i) => (PASSENGER.has(kind) ? [len / 2 - back[i]] : []));
		const smoke = Array.from({ length: 6 }, () => {
			const mesh = new Mesh(unit, smokeMat);
			mesh.visible = false;
			scene.add(mesh);
			return { mesh, age: 9 };
		});
		const stops: Train["stops"] = [];
		if (spec.stops !== "none") {
			route.forEach((e, i) => {
				for (const station of stations) if (station.edge === e && (spec.stops === "all" || station.major)) stops.push({ ri: i, d: station.d + len / 2, station });
			});
			stops.sort((a, b) => a.ri - b.ri || a.d - b.d);
		}
		let stopIdx = stops.findIndex((st) => st.ri > spec.ri || (st.ri === spec.ri && st.d > spec.d));
		if (stopIdx < 0) stopIdx = 0;
		const smokeAt = spec.cars[0] === "steam" ? new Vector3(0, 1.75, 0.85) : new Vector3(0, 1.3, -0.3);
		return { cars, back, len, doors, vmax: spec.vmax, route, ri: spec.ri, d: spec.d, v: 0, stops, stopIdx, stopped: null, clock: 0, blocked: false, leaving: false, lap: route.reduce((sum, e) => sum + e.len, 0), visits: 0, smokeAt, smoke, smokeClock: 0, smokeNext: 0 };
	});

	const pA = new Vector3();
	const pB = new Vector3();
	const pC = new Vector3();

	function refreshHolders() {
		for (const e of edges.values()) {
			e.holder = null;
			e.waiting = false;
		}
		for (const tr of trains) {
			const n = tr.route.length;
			let ri = tr.ri;
			let left = tr.len + 1.2 - tr.d;
			tr.route[ri].holder = tr;
			while (left > 0) {
				ri = (ri - 1 + n) % n;
				tr.route[ri].holder = tr;
				left -= tr.route[ri].len;
			}
			if (tr.blocked) tr.route[tr.ri].waiting = true;
		}
	}

	function canEnter(tr: Train, e: Edge) {
		if ((e.holder && e.holder !== tr) || (e.reservedBy && e.reservedBy !== tr)) return false;
		e.reservedBy = tr;
		const node = nodes.get(e.from)!;
		if (node.outs.length > 1) node.set = e;
		return true;
	}

	function pointOnRoute(tr: Train, back: number, out: Vector3) {
		const n = tr.route.length;
		let ri = tr.ri;
		let d = tr.d - back;
		while (d < 0) {
			ri = (ri - 1 + n) % n;
			d += tr.route[ri].len;
		}
		return edgeAt(tr.route[ri], d, out);
	}

	function placeTrain(tr: Train) {
		tr.cars.forEach((car, i) => {
			const back = tr.back[i];
			pointOnRoute(tr, back, pA);
			pointOnRoute(tr, back - 0.7, pB);
			pointOnRoute(tr, back + 0.7, pC);
			pB.sub(pC);
			car.position.copy(pA).y += 0.16;
			car.lookAt(pA.x + pB.x, pA.y + 0.16 + pB.y, pA.z + pB.z);
		});
	}

	function stepTrain(tr: Train, dt: number) {
		if (tr.stopped !== null) {
			tr.clock += dt;
			if (tr.clock >= DWELL) {
				const st = tr.stopped;
				st.train = null;
				for (const p of st.people) {
					if (p.state === "board") p.state = "enter"; // the doors closed: back to the waiting spot
				}
				tr.stopped = null;
				tr.leaving = true;
				tr.stopIdx = (tr.stopIdx + 1) % tr.stops.length;
				tr.clock = 0;
			}
			return;
		}
		const cur = tr.route[tr.ri];
		const next = tr.route[(tr.ri + 1) % tr.route.length];
		const toEnd = cur.len - tr.d;
		let dGate = Infinity;
		tr.blocked = false;
		if (toEnd < 14 && !canEnter(tr, next)) {
			dGate = Math.max(0, toEnd - 0.05); // red signal: stop at the end of the edge
			tr.blocked = true;
		}
		const stop = tr.stops[tr.stopIdx];
		let dStop = stop ? distanceAlong(tr, stop.ri, stop.d) : Infinity;
		if (tr.leaving) {
			// with a single stop on the route the next one is the same platform, a whole lap away
			if (dStop < 2) dStop += tr.lap;
			else tr.leaving = false;
		}
		const dist = Math.min(dGate, dStop);
		const allowed = dist === Infinity ? tr.vmax : Math.min(tr.vmax, 0.35 + Math.sqrt(2 * DECEL * dist));
		tr.v = tr.v < allowed ? Math.min(allowed, tr.v + ACCEL * dt) : Math.max(allowed, tr.v - DECEL * 1.5 * dt);
		if (dist <= 0.001) tr.v = 0;
		const step = Math.min(tr.v * dt, dist);
		tr.d += step;
		while (tr.d >= tr.route[tr.ri].len) {
			tr.d -= tr.route[tr.ri].len;
			tr.ri = (tr.ri + 1) % tr.route.length;
		}
		if (stop && dStop <= dGate && dStop - step <= 0.002) {
			tr.ri = stop.ri;
			tr.d = stop.d;
			tr.v = 0;
			tr.stopped = stop.station;
			tr.clock = 0;
			tr.visits++;
			const st = stop.station;
			st.train = tr;
			// some of the people who are away at this station get off
			const away = st.people.filter((p) => p.state === "away");
			const count = Math.min(away.length, 1 + tr.doors.length + Math.floor(rand() * 3));
			for (let i = 0; i < count; i++) {
				const p = away[i];
				p.state = "alight";
				p.door = Math.floor(rand() * tr.doors.length);
				p.timer = 0.6 + i * 0.45; // seconds until they step out
				p.exitU = tr.doors[p.door] + (rand() - 0.5) * 2;
				p.mesh.visible = false;
			}
			for (const p of st.people) p.boardAt = -1;
		}
	}

	function smokeTrain(tr: Train, dt: number) {
		for (const p of tr.smoke) {
			p.age += dt;
			p.mesh.visible = p.age < 1.6;
			if (p.mesh.visible) {
				p.mesh.position.y += dt * 0.7;
				p.mesh.scale.setScalar(0.3 * (1 - p.age / 1.6) + 0.04);
			}
		}
		tr.smokeClock += dt;
		if (tr.v > 0.3 && tr.smokeClock > 0.4) {
			tr.smokeClock = 0;
			const p = tr.smoke[tr.smokeNext++ % tr.smoke.length];
			p.age = 0;
			p.mesh.visible = true;
			p.mesh.position.copy(tr.smokeAt).applyMatrix4(tr.cars[0].matrixWorld);
		}
	}

	function walk(p: Person, tu: number, tv: number, dt: number) {
		const dx = tu - p.u;
		const dy = tv - p.v;
		const dist = Math.hypot(dx, dy);
		const step = WALK * dt;
		p.walking = true;
		if (dist <= step) {
			p.u = tu;
			p.v = tv;
			return true;
		}
		p.u += (dx / dist) * step;
		p.v += (dy / dist) * step;
		return false;
	}

	function stepStation(st: Station, dt: number) {
		const tr = st.train;
		for (const p of st.people) {
			p.walking = false;
			switch (p.state) {
				case "away":
					p.timer -= dt;
					if (p.timer <= 0) {
						const slot = st.slots.indexOf(null);
						if (slot < 0) {
							p.timer = 2;
							break;
						}
						p.slot = slot;
						st.slots[slot] = p;
						p.u = SLOTS[slot][0] + (rand() - 0.5) * 2;
						p.v = 2.8;
						p.state = "enter";
						p.mesh.visible = true;
					}
					break;
				case "enter":
					if (walk(p, SLOTS[p.slot][0], SLOTS[p.slot][1], dt)) p.state = "wait";
					break;
				case "wait":
					if (tr && tr.doors.length && tr.clock < DWELL - 2.5) {
						if (p.boardAt < 0) p.boardAt = tr.clock + 0.4 + rand() * 3;
						if (tr.clock >= p.boardAt) {
							p.door = tr.doors.reduce((best, u, i) => (Math.abs(u - p.u) < Math.abs(tr.doors[best] - p.u) ? i : best), 0);
							p.state = "board";
						}
					}
					break;
				case "board":
					if (!tr) {
						p.state = "enter";
					} else if (walk(p, tr.doors[p.door], 0.85, dt)) {
						st.slots[p.slot] = null;
						p.state = "away";
						p.timer = 6 + rand() * 8;
						p.mesh.visible = false;
					}
					break;
				case "alight":
					if (!tr && p.timer > 0) {
						p.state = "away"; // the train left before they got out
						p.timer = 3;
					} else if (p.timer > 0) {
						p.timer -= dt;
						if (p.timer <= 0) {
							p.u = tr!.doors[p.door];
							p.v = 0.85;
							p.mesh.visible = true;
						}
					} else if (walk(p, p.exitU, 2.9, dt)) {
						p.state = "away";
						p.timer = 5 + rand() * 8;
						p.mesh.visible = false;
					}
					break;
			}
		}
	}

	let time = 0;
	function simulate(dt: number) {
		time += dt;
		refreshHolders();
		for (const tr of trains) {
			stepTrain(tr, dt);
			smokeTrain(tr, dt);
		}
		for (const e of edges.values()) if (e.reservedBy && e.holder === e.reservedBy) e.reservedBy = null;
		for (const st of stations) stepStation(st, dt);
	}

	function pose() {
		for (const tr of trains) placeTrain(tr);
		for (const tr of trains) tr.cars[0].updateMatrixWorld(true);
		for (const sg of scenery.signals) sg.light.material = sg.edge.waiting ? scenery.lamp.red : scenery.lamp.green;
		for (const sw of scenery.switches) {
			const straight = sw.node.set === sw.node.outs[0];
			sw.lever.rotation.y = straight ? 0 : 0.7;
			sw.head.material = straight ? scenery.lamp.green : scenery.lamp.yellow;
			for (const [e, g] of sw.tongues) g.visible = e === sw.node.set;
		}
		for (const st of stations) {
			for (const p of st.people) {
				if (!p.mesh.visible) continue;
				const hop = p.walking
					? Math.floor(time * 9 + p.phase) % 2
						? 0.07
						: 0
					: (time * 0.5 + p.phase) % 4 < 0.12
						? 0.07
						: 0;
				p.mesh.position.set(st.origin.x + st.t.x * p.u + st.n.x * p.v, st.origin.y + 0.25 + hop, st.origin.z + st.t.z * p.u + st.n.z * p.v);
			}
		}
	}

	return { trains, stations, simulate, pose };
}
