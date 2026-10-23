// SIEGL s.r.o. (containers and the hauling of waste), Teplárenská 1620, Praha-Kyje: its white and red trucks drive
// the streets around the yard. The livery from their photos: a white cab, a red visor over the windscreen with an
// amber beacon on it, a red bumper and a red apron under the door, two red bars on the black chassis, and on the back
// a hooklift with a dark green container. Four of them live in the yard: they leave it down the access road, drive
// the streets, and some come back and park (praha-traffic.ts).
import type { Scene } from "three";
import { project } from "./praha-landmarks";
import { walkSegment } from "./praha-roads";
import { type Box, COLORS, glow, lightMaterial, meshFromBoxes } from "./util";
import type { Extras, Focus, Place } from "./world";

/** where the trucks start and come back to: the junction of the access road with Teplárenská, 316 m south of the yard */
export const SIEGL = (() => {
	const [x, z] = project(50.083203, 14.532758);
	return { x, z, home: 75 };
})();

const WHITE = 0xf1f2f0;
const RED = 0xd71921;
const GREEN = 0x2f4a3c;
const BLACK = 0x1a1919;
const AMBER = 0xf08c10;
const TYRE = 0x14161c;

/** a box of a truck in its own frame: x across, y up (its middle), z along (front is +); size across, up, along */
export type Part = [x: number, y: number, z: number, w: number, h: number, l: number, color: number];

/** the kinds of the body behind the cab */
export const BODIES = ["container", "container", "container", "skip", "bare"] as const;

/** the trucks are drawn a fifth bigger than their length by the scale of the cars: they are to be told from far */
const SCALE = 1.2;
/** how far the headlights of a truck are from its middle, and how far apart */
export const TRUCK_LAMPS = { half: 0.86 * SCALE, wide: 0.2 * SCALE };

/** a hooklift truck of 12 t: about 12 m long here, the cab at the front */
export function truckParts(body: (typeof BODIES)[number]): Part[] {
	return rawParts(body).map((p) => [p[0] * SCALE, p[1] * SCALE, p[2] * SCALE, p[3] * SCALE, p[4] * SCALE, p[5] * SCALE, p[6]]);
}

function rawParts(body: (typeof BODIES)[number]): Part[] {
	const parts: Part[] = [
		[0, 0.2, 0, 0.36, 0.1, 1.55, BLACK], // the chassis
		[0.19, 0.2, 0.05, 0.03, 0.06, 1.2, RED], // the two red bars on its side
		[-0.19, 0.2, 0.05, 0.03, 0.06, 1.2, RED],
		[0, 0.5, 0.58, 0.56, 0.5, 0.42, WHITE], // the cab
		[0, 0.78, 0.69, 0.58, 0.07, 0.24, RED], // the visor over the windscreen
		[0, 0.68, 0.79, 0.5, 0.18, 0.04, 0x1c2232], // the windscreen
		[0, 0.84, 0.72, 0.12, 0.07, 0.1, AMBER], // the beacon
		[0, 0.26, 0.82, 0.58, 0.14, 0.06, RED], // the bumper
		[0.29, 0.34, 0.6, 0.03, 0.14, 0.4, RED], // the apron under the door, both sides
		[-0.29, 0.34, 0.6, 0.03, 0.14, 0.4, RED],
		[0.295, 0.5, 0.48, 0.03, 0.2, 0.12, RED], // the arch over the front wheel curls up onto the door
		[-0.295, 0.5, 0.48, 0.03, 0.2, 0.12, RED],
		[0.3, 0.6, 0.44, 0.03, 0.12, 0.12, BLACK], // the chequered flag on the back of the door
		[-0.3, 0.6, 0.44, 0.03, 0.12, 0.12, BLACK],
		[0.31, 0.6, 0.44, 0.02, 0.06, 0.06, WHITE],
		[-0.31, 0.6, 0.44, 0.02, 0.06, 0.06, WHITE],
	];
	for (const side of [-0.3, 0.3]) for (const z of [0.58, -0.52, -0.2]) parts.push([side, 0.1, z, 0.08, 0.2, 0.2, TYRE]);
	if (body === "container") {
		parts.push([0, 0.26, -0.3, 0.2, 0.06, 0.9, BLACK]); // the frame of the hooklift
		parts.push([0, 0.52, -0.3, 0.56, 0.42, 0.95, GREEN]); // the container
		parts.push([0, 0.75, -0.3, 0.5, 0.05, 0.9, 0x253b30]); // its lid, a shade darker
		parts.push([0.29, 0.54, -0.3, 0.02, 0.1, 0.5, WHITE]); // the stencilled number, both sides
		parts.push([-0.29, 0.54, -0.3, 0.02, 0.1, 0.5, WHITE]);
	} else if (body === "skip") {
		parts.push([0, 0.26, -0.3, 0.2, 0.06, 0.9, BLACK]);
		parts.push([0.24, 0.5, -0.3, 0.06, 0.34, 0.9, GREEN]); // the open skip: two walls, a front, a back
		parts.push([-0.24, 0.5, -0.3, 0.06, 0.34, 0.9, GREEN]);
		parts.push([0, 0.5, 0.13, 0.5, 0.34, 0.06, GREEN]);
		parts.push([0, 0.5, -0.73, 0.5, 0.34, 0.06, GREEN]);
		parts.push([0, 0.36, -0.3, 0.46, 0.04, 0.84, 0x20332a]);
	} else {
		parts.push([0, 0.27, -0.3, 0.2, 0.08, 1.0, BLACK]); // the hook arm, nothing on it
		parts.push([0, 0.4, -0.72, 0.28, 0.06, 0.22, RED]);
	}
	return parts;
}


// --- the yard: Teplárenská 1620, between the halls of Kyje. OSM has no yard of Siegl, only the address (50.085982,
// 14.531850) and the halls around it, so the containers and the parked trucks stand on the open ground next to the pin.
const [YX, YZ] = project(50.0859, 14.5316);
// the halls there run along 82 degrees; the yard is laid out the same way: u along them, v across (to the west)
const AXIS = (82 / 180) * Math.PI;
const U: [number, number] = [Math.cos(AXIS), Math.sin(AXIS)];
const V: [number, number] = [-U[1], U[0]];

export const YARD = { x: YX, z: YZ };

/** the point (u, v) of the yard in the world */
const at = (u: number, v: number): [number, number] => [YX + U[0] * u + V[0] * v, YZ + U[1] * u + V[1] * v];

// --- the access road and the trucks that live in the yard. Four of the trucks stand in the yard, nose to the road; they
// pull out, drive down the road to Teplárenská and into the traffic, and some come back later and park again.

/** how many of the trucks belong to the yard (the others drive the streets round it and never come in) */
export const YARD_TRUCKS = 4;
/** the kinds of their bodies, as indices into BODIES: a container, a skip, a bare hook, a container */
export const YARD_BODIES = [0, 3, 4, 1];

/** the access road from the yard down to Teplárenská (OSM way 23428513): the street lines of the map leave it out */
const ROAD: [number, number][] = [
	[1434.8, 10.2],
	[1434.2, 12.1],
	[1435.8, 23.2],
	[1436.7, 27.3],
	[1439.3, 38.5],
	[1441.4, 49.0],
	[1442.2, 50.9],
	[1445.2, 53.1],
	[1447.5, 54.7],
	[SIEGL.x, SIEGL.z],
];

/** a point of Teplárenská upstream of the access road (the street runs west): the trucks that come back join it here */
export const COME_FROM = { x: 1500, z: 65.5 };

/** a truck in a slot stands nose to the road (east of the yard): this is the way it faces, as an angle from +z */
export const SLOT_HEADING = Math.atan2(-V[0], -V[1]);

/** the parts of the way out of every slot: from the slot, onto the access road, and down it to Teplárenská */
export const EXIT_PATHS: [number, number][][] = Array.from({ length: YARD_TRUCKS }, (_, k) => {
	const u = k * 1.4;
	const slot = at(u, 1.45);
	const turn = at(u + 0.1, -0.4);
	const onRoad = at(u + 0.9, -0.95);
	// the nearest point of the road to where the truck meets it, and the road from there on
	let best = { i: 0, t: 0, d: Infinity };
	for (let i = 0; i < ROAD.length - 1; i++) {
		const [x1, z1] = ROAD[i];
		const [x2, z2] = ROAD[i + 1];
		const l2 = (x2 - x1) ** 2 + (z2 - z1) ** 2;
		const t = Math.max(0, Math.min(1, ((onRoad[0] - x1) * (x2 - x1) + (onRoad[1] - z1) * (z2 - z1)) / l2));
		const d = Math.hypot(x1 + (x2 - x1) * t - onRoad[0], z1 + (z2 - z1) * t - onRoad[1]);
		if (d < best.d) best = { i, t, d };
	}
	const [x1, z1] = ROAD[best.i];
	const [x2, z2] = ROAD[best.i + 1];
	return [slot, turn, [x1 + (x2 - x1) * best.t, z1 + (z2 - z1) * best.t], ...ROAD.slice(best.i + 1)];
});

/** the access road as a strip along the ground, for chunk (cx, cz) */
export function sieglRoad(cx: number, cz: number, ground: (x: number, z: number) => number, add: (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry?: number) => void) {
	for (let i = 0; i < ROAD.length - 1; i++) {
		const [x1, z1] = ROAD[i];
		const [x2, z2] = ROAD[i + 1];
		walkSegment(x1, z1, x2, z2, cx, cz, ground, () => false, (x, z, l, h, ry) => add(l + 0.3, 0.05, 0.7, 0x4a4a48, x, h + 0.035, z, ry));
	}
}

export function createYard(scene: Scene, groundAt: (x: number, z: number) => number): Extras {
	const y = groundAt(YX, YZ) - 0.07;
	const heading = Math.atan2(U[0], U[1]); // facing along u, towards the street
	const boxes: Box[] = [];
	const lamps: Box[] = [];
	// (the trucks that stand here are those of praha-traffic.ts: they drive out and come back)
	// the containers in two rows, one of them stacked
	const container = (u: number, v: number, level: number, color = GREEN) => {
		const [x, z] = at(u, v);
		boxes.push([0.55, 0.36, 1.1, color, x, y + 0.18 + level * 0.36, z, heading]);
		boxes.push([0.5, 0.04, 1.0, 0x20332a, x, y + 0.38 + level * 0.36, z, heading]);
		boxes.push([0.02, 0.1, 0.5, WHITE, x + V[0] * 0.28, y + 0.2 + level * 0.36, z + V[1] * 0.28, heading]);
	};
	for (let i = 0; i < 4; i++) {
		container(-3 + i * 1.25, 4.2, 0);
		container(-3 + i * 1.25, 5.4, 0);
	}
	container(-3, 4.2, 1);
	container(-1.75, 5.4, 1);
	container(-0.5, 6.8, 0, 0x3a5a48);
	container(0.75, 6.8, 0, 0x3a5a48);
	// a heap of gravel and a heap of rubble, as steps of boxes
	for (const [u, v, a, b] of [[-4.6, 1, 0x8c8a84, 3], [-4.6, 3.1, 0xa8643f, 2]] as const) {
		for (let k = 0; k < b; k++) {
			const [x, z] = at(u, v);
			const w = 1.5 - k * 0.45;
			boxes.push([w, 0.16, w * 0.8, a, x, y + 0.08 + k * 0.16, z, heading]);
		}
	}
	// the sign at the gate: a red board on two posts, with a white stripe
	const [sx, sz] = at(5.5, 2);
	for (const side of [-0.7, 0.7]) boxes.push([0.08, 0.7, 0.08, COLORS.dark, sx + V[0] * side, y + 0.35, sz + V[1] * side, heading]);
	boxes.push([1.9, 0.5, 0.07, RED, sx, y + 0.95, sz, heading]);
	boxes.push([1.5, 0.12, 0.08, WHITE, sx, y + 0.95, sz, heading]);
	// two floodlights on poles, lit at night
	for (const [u, v] of [[-4.5, 7.2], [4, 8]] as const) {
		const [x, z] = at(u, v);
		boxes.push([0.08, 1.6, 0.08, COLORS.dark, x, y + 0.8, z, 0]);
		lamps.push([0.3, 0.16, 0.3, COLORS.lit, x, y + 1.65, z, 0]);
	}
	const still = meshFromBoxes(boxes);
	const lit = meshFromBoxes(lamps, lightMaterial);
	for (const m of [still, lit]) {
		m.userData.dynamic = true;
		m.visible = false;
		scene.add(m);
	}
	let focus: Focus | null = null;
	return {
		simulate(_dt, f) {
			focus = f;
		},
		pose() {
			const shown = !!focus && !focus.far && focus.k <= 2 && Math.abs(focus.x - YX) < focus.r * 1.3 + 12 && Math.abs(focus.z - YZ) < focus.r * 1.3 + 12;
			still.visible = shown;
			lit.visible = shown && glow.emissive.r > 0.5;
		},
		places(): Place[] {
			return [{ x: YX, y: y + 1.6, z: YZ, name: "Siegl", rank: 1 }];
		},
	};
}
