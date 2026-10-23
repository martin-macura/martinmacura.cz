// SIEGL kontejnery, Teplárenská 1620 in Malešice: a yard with green containers and white and red lorries, which carry
// them (a hook-lift with a green container; the cab white with red skirts and a red band over the windscreen, the
// chequered flag of their "turbo" containers on the doors and at the back). The lorries drive out of the yard along
// the service road to Teplárenská and into the traffic of praha-traffic.ts; some come back and park.
// Positions are in world units (the address point of OpenStreetMap node 2815817652; the service road is way 23428513).
import { walkSegment } from "./praha-roads";
import { COLORS } from "./util";

type Add = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry?: number) => void;

const RED = 0xc8272d;
const WHITE = 0xf4f4f4;
const GREEN = 0x2d5a3a;
const GREEN_LIGHT = 0x3f7a50;
const BLACK = 0x1a1a1f;
const GLASS = 0x1c2232;
const GREY = 0x59616d;

/** the middle of the yard, and its size (the sights place it: the houses of the map are cleared around it) */
export const YARD = { x: 1439, z: 9, w: 6.6, d: 5.4 };
/** how many lorries belong to it */
export const TRUCKS = 4;
/** where the lorries stand in the yard (x, z) */
export const SLOTS: [number, number][] = [
	[1437.3, 10.6],
	[1439.1, 10.6],
	[1440.9, 10.6],
	[1437.3, 8.6],
];
/** the way out: the gate of the yard and the service road down to Teplárenská */
export const YARD_PATH: [number, number][] = [
	[1436.2, 10.0],
	[1434.8, 10.2],
	[1434.2, 12.1],
	[1435.8, 23.2],
	[1436.7, 27.3],
	[1439.3, 38.5],
	[1441.4, 49.0],
	[1442.2, 50.9],
	[1445.2, 53.1],
	[1447.5, 54.7],
	[1447.4, 61.1],
];
/** where the service road meets Teplárenská, and a point of that street further upstream, where lorries come from */
export const JOIN = { x: 1447.4, z: 61.1 };
export const COME_FROM = { x: 1500, z: 65.5 };
/** farther than this from the yard a lorry is off on a job, out of sight */
export const AWAY = 150;

/** the parts of a lorry: w, h, d, colour, x, y (middle), z in its own frame, z forward, x to its right, one unit is 6 m */
export const TRUCK_PARTS: [number, number, number, number, number, number, number][] = [
	[0.44, 0.12, 1.62, RED, 0, 0.17, 0], // the frame
	[0.62, 0.46, 0.5, WHITE, 0, 0.47, 0.55], // the cab
	[0.64, 0.14, 0.52, RED, 0, 0.27, 0.55], // its red skirt
	[0.66, 0.1, 0.06, RED, 0, 0.2, 0.82], // the bumper
	[0.64, 0.08, 0.1, RED, 0, 0.72, 0.77], // the band over the windscreen
	[0.5, 0.2, 0.04, GLASS, 0, 0.55, 0.805], // the windscreen
	[0.65, 0.16, 0.16, GLASS, 0, 0.56, 0.52], // the side windows
	[0.58, 0.4, 1.0, GREEN, 0, 0.4, -0.22], // the container
	[0.6, 0.04, 1.02, GREEN_LIGHT, 0, 0.62, -0.22],
	[0.3, 0.2, 0.04, WHITE, -0.15, 0.5, -0.74], // the chequered end of it
	[0.3, 0.2, 0.04, BLACK, 0.15, 0.5, -0.74],
	[0.3, 0.2, 0.04, BLACK, -0.15, 0.3, -0.74],
	[0.3, 0.2, 0.04, WHITE, 0.15, 0.3, -0.74],
	[0.04, 0.08, 0.1, BLACK, -0.32, 0.31, 0.43], // the chequers on the doors
	[0.04, 0.08, 0.1, BLACK, 0.32, 0.31, 0.43],
	[0.04, 0.08, 0.1, BLACK, -0.32, 0.39, 0.53],
	[0.04, 0.08, 0.1, BLACK, 0.32, 0.39, 0.53],
	...[0.55, -0.15, -0.55].flatMap((z): [number, number, number, number, number, number, number][] => [
		[0.1, 0.2, 0.2, BLACK, -0.3, 0.1, z],
		[0.1, 0.2, 0.2, BLACK, 0.3, 0.1, z],
	]),
];

/** letters of a sign, 3 x 5 pixels each */
const LETTERS: Record<string, string[]> = {
	S: ["111", "100", "111", "001", "111"],
	I: ["111", "010", "010", "010", "111"],
	E: ["111", "100", "111", "100", "111"],
	G: ["111", "100", "101", "101", "111"],
	L: ["100", "100", "100", "100", "111"],
};

/** the yard, in the frame of the sight: x east, z south, its middle at (0, 0) */
export function sieglYard(add: Add, glow: Add, y: number) {
	const { w, d } = YARD;
	add(w, 0.06, d, 0x8e8c86, 0, y + 0.03, 0); // gravel
	// the fence, with a gate to the service road on the west
	add(w, 0.34, 0.07, GREY, 0, y + 0.2, -d / 2);
	add(w, 0.34, 0.07, GREY, 0, y + 0.2, d / 2);
	add(0.07, 0.34, d, GREY, w / 2, y + 0.2, 0);
	add(0.07, 0.34, 1.9, GREY, -w / 2, y + 0.2, -d / 2 + 0.95);
	add(0.07, 0.34, 1.3, GREY, -w / 2, y + 0.2, d / 2 - 0.65);
	// the office: white, with a red band and a flat roof
	add(2.0, 0.8, 1.0, WHITE, -1.9, y + 0.4, -1.6);
	add(2.02, 0.16, 1.02, RED, -1.9, y + 0.7, -1.6);
	add(2.1, 0.08, 1.1, GREY, -1.9, y + 0.84, -1.6);
	for (const x of [-2.5, -1.9, -1.3]) {
		add(0.3, 0.26, 0.04, GLASS, x, y + 0.36, -1.08);
		glow(0.3, 0.26, 0.06, COLORS.lit, x, y + 0.36, -1.08);
	}
	// the sign over the yard, red with white letters: SIEGL
	const px = 0.1;
	const word = "SIEGL";
	const width = word.length * 3 * px + (word.length - 1) * px;
	add(width + 0.3, 0.7, 0.08, RED, 0.9, y + 1.5, -d / 2 + 0.2);
	for (const sx of [-1, 1]) add(0.08, 1.2, 0.08, GREY, 0.9 + sx * (width / 2 + 0.05), y + 0.65, -d / 2 + 0.2);
	[...word].forEach((ch, i) => {
		LETTERS[ch].forEach((row, r) => {
			[...row].forEach((on, c) => {
				if (on === "1") add(px, px, 0.04, WHITE, 0.9 - width / 2 + (i * 4 + c + 0.5) * px, y + 1.5 + (2 - r) * px, -d / 2 + 0.26);
			});
		});
	});
	// the containers: green, two high in places, in rows on the east side
	for (let row = 0; row < 2; row++) {
		for (let k = 0; k < 3; k++) {
			const cx = 0.3 + k * 1.2;
			const cz = -0.6 - row * 0.8;
			add(1.1, 0.4, 0.6, GREEN, cx, y + 0.26, cz);
			add(1.12, 0.04, 0.62, GREEN_LIGHT, cx, y + 0.48, cz);
			if ((k + row) % 2 === 0) {
				add(1.1, 0.4, 0.6, GREEN, cx, y + 0.7, cz);
				add(1.12, 0.04, 0.62, GREEN_LIGHT, cx, y + 0.92, cz);
			}
			// the chequers of the turbo containers, on the end that faces the yard
			add(0.04, 0.12, 0.3, WHITE, cx + 0.56, y + 0.3, cz - 0.1);
			add(0.04, 0.12, 0.3, BLACK, cx + 0.56, y + 0.3, cz + 0.2);
		}
	}
}

/** the service road from the yard to Teplárenská, which the street lines of the map leave out, as a strip along the way out */
export function sieglRoad(cx: number, cz: number, ground: (x: number, z: number) => number, add: Add) {
	for (let i = 1; i < YARD_PATH.length - 1; i++) {
		const [x1, z1] = YARD_PATH[i];
		const [x2, z2] = YARD_PATH[i + 1];
		walkSegment(x1, z1, x2, z2, cx, cz, ground, () => false, (x, z, l, h, ry) => add(l + 0.3, 0.05, 0.7, 0x5a5a56, x, h + 0.035, z, ry));
	}
}
