// The sights of Prague, in boxes. Each one stands where it stands on the map (lat, lon) and pushes the ordinary
// houses away from itself. A builder gets the ground height and places boxes in its own frame: x along the long
// axis of the building, z across it, `rot` turning the whole thing.
import { COLORS } from "./util";

type Add = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, ry?: number) => void;

export interface Landmark {
	name: string;
	x: number;
	z: number;
	/** houses whose middle is closer than this are left out */
	clear: number;
	build(add: Add, glow: Add, y: number): void;
}

// the same projection as scripts/praha/common.py
const LAT0 = 50.0865;
const LON0 = 14.4112;
const KX = (111320 * Math.cos((50.08 * Math.PI) / 180)) / 6;
const KZ = 111200 / 6;
export const project = (lat: number, lon: number): [number, number] => [(lon - LON0) * KX, -(lat - LAT0) * KZ];

const STONE = 0xcfc8b4;
const DARK = 0x4a5560;
const COPPER = 0x5f8f7c;
const GOLD = 0xe8b53a;

/** a stack of narrowing boxes: a spire or a stepped roof */
function spire(add: Add, x: number, y: number, z: number, base: number, steps: number, color: number, ry = 0, step = 0.55) {
	for (let i = 0; i < steps; i++) {
		const s = Math.max(0.15, base * (1 - i / steps));
		add(s, step, s, color, x, y + step / 2 + i * step, z, ry);
	}
}

/** a church on the long axis: nave, steep roof, two towers at the west end */
function twinTowers(add: Add, glow: Add, y: number, opts: { nave: [number, number, number]; tower: number; towerH: number; spireColor: number; roofColor: number }) {
	const [l, w, h] = opts.nave;
	add(l, h, w, STONE, 0, y + h / 2, 0);
	for (let i = 0; i < 4; i++) add(l + 0.2, 0.5, w * (1 - i * 0.22) + 0.2, opts.roofColor, 0, y + h + 0.25 + i * 0.5, 0);
	for (const side of [-1, 1]) {
		const tx = -l / 2 + opts.tower / 2;
		const tz = side * (w / 2 - opts.tower / 2 + 0.1);
		add(opts.tower, opts.towerH, opts.tower, STONE, tx, y + opts.towerH / 2, tz);
		spire(add, tx, y + opts.towerH, tz, opts.tower + 0.2, 5, opts.spireColor);
		glow(0.3, 0.5, 0.1, COLORS.lit, tx - opts.tower / 2 - 0.05, y + opts.towerH * 0.7, tz);
	}
	// turrets and buttresses along the sides
	for (let i = -2; i <= 2; i++) for (const side of [-1, 1]) add(0.3, h * 0.8, 0.45, STONE, i * (l / 5.5), y + (h * 0.8) / 2, side * (w / 2 + 0.2));
}

const at = (lat: number, lon: number) => project(lat, lon);

export const LANDMARKS: (Landmark & { rot: number })[] = [
	{
		// St. Vitus: nave east-west, twin towers in the west, the great south tower with its gold cap
		name: "vit",
		...pos(50.0909, 14.4005),
		rot: 0.05,
		clear: 9,
		build(add, glow, y) {
			twinTowers(add, glow, y, { nave: [11, 3.4, 4.4], tower: 1.5, towerH: 9, spireColor: DARK, roofColor: COPPER });
			add(2.2, 1.0, 2.2, STONE, 0.5, y + 10.4 - 0.5, 2.6);
			add(2.0, 10.4, 2.0, STONE, 0.5, y + 5.2, 2.6);
			add(2.3, 0.5, 2.3, STONE, 0.5, y + 10.6, 2.6);
			spire(add, 0.5, y + 10.85, 2.6, 1.9, 4, GOLD, 0, 0.6);
			add(0.12, 0.9, 0.12, GOLD, 0.5, y + 13.6, 2.6);
			add(3.2, 3.6, 2.6, STONE, 6.4, y + 1.8, 0); // choir
			add(3.4, 0.6, 2.8, COPPER, 6.4, y + 3.9, 0);
		},
	},
	{
		name: "tyn",
		...pos(50.08755, 14.4223),
		rot: 0,
		clear: 6.5,
		build(add, glow, y) {
			twinTowers(add, glow, y, { nave: [7.2, 3.6, 5], tower: 1.7, towerH: 11.5, spireColor: 0x39424c, roofColor: 0x5a4a45 });
			for (const side of [-1, 1]) for (const dx of [-0.75, 0.75]) add(0.35, 0.9, 0.35, DARK, -3.6 + 0.85 + dx, y + 11.9, side * 1.4 + (side > 0 ? 0 : 0));
		},
	},
	{
		name: "radnice",
		...pos(50.08704, 14.42083),
		rot: 0.3,
		clear: 5,
		build(add, glow, y) {
			add(5.5, 3.2, 2.6, 0xe6d3a0, 0, y + 1.6, 1.2);
			add(5.7, 0.5, 2.8, 0xa03e2a, 0, y + 3.45, 1.2);
			add(1.7, 11, 1.7, 0xdcd4c0, -2.6, y + 5.5, -0.6); // the tower
			add(1.9, 0.5, 1.9, 0xdcd4c0, -2.6, y + 11.2, -0.6);
			spire(add, -2.6, y + 11.45, -0.6, 1.8, 4, COPPER, 0, 0.6);
			add(0.6, 0.6, 0.12, 0xf2f2f2, -2.6, y + 8.6, 0.3); // the clock
			glow(0.4, 0.4, 0.1, COLORS.lit, -2.6, y + 8.6, 0.35);
		},
	},
	{
		name: "prasna",
		...pos(50.08755, 14.4287),
		rot: 0.2,
		clear: 4,
		build(add, glow, y) {
			add(2.6, 8, 2.6, 0x8a7f6a, 0, y + 4, 0);
			add(2.9, 0.5, 2.9, 0x6b6253, 0, y + 8.2, 0);
			spire(add, 0, y + 8.45, 0, 2.6, 4, 0x3b3f44, 0, 0.6);
			for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
				add(0.55, 1.2, 0.55, 0x6b6253, sx * 1.4, y + 8.6, sz * 1.4);
				add(0.4, 0.5, 0.4, 0x3b3f44, sx * 1.4, y + 9.45, sz * 1.4);
			}
			glow(0.3, 0.5, 0.1, COLORS.lit, 0, y + 6, 1.36);
		},
	},
	{
		// the National Museum closes Wenceslas Square: a long front and a green dome in the middle
		name: "muzeum",
		...pos(50.0792, 14.4306),
		rot: 0.45,
		clear: 10,
		build(add, glow, y) {
			add(13, 4.4, 4.6, 0xd6cba8, 0, y + 2.2, 0);
			add(13.2, 0.5, 4.8, 0x6b6b5c, 0, y + 4.65, 0);
			add(5.2, 5.6, 5.2, 0xdcd2b2, 0, y + 2.8, 0.3);
			for (let i = 0; i < 4; i++) add(4.4 - i * 0.9, 0.9, 4.4 - i * 0.9, COPPER, 0, y + 6.1 + i * 0.9, 0.3);
			add(0.8, 1.2, 0.8, GOLD, 0, y + 10.1, 0.3);
			for (const sx of [-1, 1]) add(2.6, 6.2, 2.6, 0xdcd2b2, sx * 5.4, y + 3.1, 0);
			for (const sx of [-1, 1]) add(2.8, 0.6, 2.8, COPPER, sx * 5.4, y + 6.5, 0);
			for (let i = -3; i <= 3; i++) glow(0.3, 0.6, 0.1, COLORS.lit, i * 1.4, y + 2, -2.35);
		},
	},
	{
		name: "narodni",
		...pos(50.0812, 14.413),
		rot: Math.PI / 2 + 0.1,
		clear: 6.5,
		build(add, glow, y) {
			add(8, 3.6, 4.4, 0xd8c7a0, 0, y + 1.8, 0);
			add(8.2, 0.5, 4.6, 0x3f6f8a, 0, y + 3.85, 0);
			add(6.4, 0.9, 3.6, 0x3f6f8a, 0, y + 4.55, 0);
			add(3.2, 0.9, 2.8, 0x3f6f8a, 0, y + 5.4, 0);
			add(1.8, 0.7, 1.8, GOLD, 0, y + 6.2, 0);
			for (let i = -2; i <= 2; i++) glow(0.4, 0.8, 0.1, COLORS.lit, i * 1.5, y + 1.7, 2.25);
		},
	},
	{
		name: "tancici",
		...pos(50.0755, 14.414),
		rot: 0.2,
		clear: 3,
		build(add, glow, y) {
			add(2, 4.6, 2, 0xc9d3dc, -0.9, y + 2.3, 0);
			add(2, 6.4, 2, 0xb8c4cf, 1.1, y + 3.2, 0);
			add(1.4, 0.4, 1.4, 0x3a4a66, 1.1, y + 6.6, 0);
			for (let r = 0; r < 4; r++) glow(1.6, 0.3, 0.1, COLORS.lit, 1.1, y + 1 + r * 1.3, 1.01);
		},
	},
	{
		name: "petrin",
		...pos(50.0835, 14.3954),
		rot: 0,
		clear: 4,
		build(add, glow, y) {
			let top = y;
			for (let k = 0; k < 5; k++) {
				const s0 = 1.5 - k * 0.22;
				for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(0.22, 2.5, 0.22, 0xd9dde2, sx * s0, top + 1.25, sz * s0);
				add(s0 * 2, 0.1, 0.1, 0xd9dde2, 0, top + 1.25, s0);
				add(s0 * 2, 0.1, 0.1, 0xd9dde2, 0, top + 1.25, -s0);
				add(0.1, 0.1, s0 * 2, 0xd9dde2, s0, top + 2.4, 0);
				add(0.1, 0.1, s0 * 2, 0xd9dde2, -s0, top + 2.4, 0);
				top += 2.5;
			}
			add(1.5, 0.8, 1.5, 0xaeb6c0, 0, top + 0.4, 0);
			add(0.3, 3.2, 0.3, 0xd9dde2, 0, top + 2.4, 0);
			add(0.16, 0.8, 0.16, 0xff3b30, 0, top + 4.4, 0);
			glow(1.2, 0.3, 0.1, COLORS.lit, 0, top + 0.4, 0.78);
		},
	},
	{
		name: "zizkov",
		...pos(50.0805, 14.4503),
		rot: 0,
		clear: 4,
		build(add, glow, y) {
			add(3.4, 1.4, 3.4, 0x8a8f96, 0, y + 0.7, 0);
			for (let k = 0; k < 3; k++) {
				const a = (k / 3) * Math.PI * 2 + 0.5;
				add(0.7, 23, 0.7, 0xaeb6c0, Math.cos(a) * 0.55, y + 12, Math.sin(a) * 0.55);
			}
			for (const [py, size] of [[12, 1.9], [16, 2.1], [19.6, 1.7]] as const) {
				add(size, 1.1, size, 0x9aa3ad, 0, y + py, 0);
				glow(size * 0.7, 0.3, 0.1, COLORS.lit, 0, y + py, size / 2 + 0.03);
			}
			add(1.4, 0.6, 1.4, 0x6f767f, 0, y + 23.4, 0);
			add(0.22, 7, 0.22, 0xd9dde2, 0, y + 27, 0);
			add(0.22, 1, 0.22, 0xff3b30, 0, y + 30.6, 0);
		},
	},
	{
		name: "vysehrad",
		...pos(50.0644, 14.4197),
		rot: 0,
		clear: 6,
		build(add, glow, y) {
			twinTowers(add, glow, y, { nave: [6.4, 2.8, 3.6], tower: 1.4, towerH: 8.4, spireColor: 0x3f4a55, roofColor: 0xa03e2a });
		},
	},
];

function pos(lat: number, lon: number) {
	const [x, z] = at(lat, lon);
	return { x, z };
}

// Charles Bridge: from the Lesser Town tower to the Old Town tower
export const CHARLES: { from: [number, number]; to: [number, number] } = { from: project(50.0872, 14.4071), to: project(50.0862, 14.4135) };
