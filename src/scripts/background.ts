// Background scene: a toy-like diorama. A programmer sits cross-legged with a laptop on his knees; a
// PCB-style trace tree grows out of the laptop and forks in every direction. Packets run to the leaves,
// where the parts of an app (DB, SERVER, API, AUTH, FE) pop up one by one, then hop together into the
// finished product (a tiny copy of this very page). Loops.
//
// Deliberately low fidelity: chunky flat-shaded blocks, no outlines, and the whole thing is rendered at a
// fraction of the screen resolution and scaled up with nearest-neighbour filtering.
// Everything is a pure function of time (apply(t)), so it can be seeked (?t= in dev).

import {
	AmbientLight,
	BoxGeometry,
	BufferGeometry,
	CanvasTexture,
	Color,
	CylinderGeometry,
	DirectionalLight,
	DoubleSide,
	Float32BufferAttribute,
	Group,
	LinearFilter,
	Mesh,
	MeshBasicMaterial,
	MeshLambertMaterial,
	NearestFilter,
	Object3D,
	OrthographicCamera,
	PlaneGeometry,
	Scene,
	ShaderMaterial,
	Sprite,
	SpriteMaterial,
	SRGBColorSpace,
	Vector3,
	WebGLRenderer,
} from "three";

// ---------------------------------------------------------------------------------------------
// tuning

const ELEVATION = (40 * Math.PI) / 180; // camera tilt above the board
const PACKET_SPEED = 15; // world units per second
const DEPLOY_SPEED = 24;
const ARRIVE_GAP = 1.5; // seconds between parts popping up
const TRACE_WIDTH = 0.5;
/** Playback speed of the whole scene, 1 being the original pace. (?t= in dev is in scene seconds.) */
const SPEED = 1.5;

// Flat toy colours on the page's near-black. Swap these to re-skin the whole scene.
const PALETTE = {
	trace: 0x2c2c2c,
	traceLit: 0x767676,
	tile: 0x1b1b1b,
	ink: 0xf2f2f2,
	skin: 0xf4c7a1,
	hair: 0x2a2a2a,
	hoodie: 0xf2f2f2,
	pants: 0x4a5878,
	shoe: 0xf2f2f2,
	beanie: 0xff5c4d,
	pompom: 0xffcf33,
	laptop: 0xd8d8d8,
	laptopDark: 0x8a8a8a,
	cable: 0x5a5a5a,
	DB: 0x3d7bff,
	SERVER: 0x2fd487,
	API: 0xffcf33,
	AUTH: 0xff5c4d,
	FE: 0xff7ab8,
};

type Key = "DB" | "SERVER" | "API" | "AUTH" | "FE";
const KEYS: Key[] = ["DB", "SERVER", "API", "AUTH", "FE"];
const DEPLOY = KEYS.length; // route index of the product
const ROUTES = KEYS.length + 1;
const CODE_COLORS = ["#ffcf33", "#3d7bff", "#2fd487", "#ff5c4d", "#f2f2f2"];

// ---------------------------------------------------------------------------------------------
// trace trees. Nodes are world (x, z) on the board; the screen is roughly x right, z down (z is
// foreshortened by the camera tilt). Edges are routed octilinearly (straight + 45 degree runs).

type V2 = [number, number];

interface TreeSpec {
	nodes: Record<string, V2>;
	/** [from, to, diagonalFirst] - a leaf node is named after the part it feeds (DB ... FE, P) */
	edges: [string, string, boolean?][];
	/** dead ends that only decorate the board */
	decor: [string, string, boolean?][];
	root: string;
	guyYaw: number; // rotation of the programmer about the vertical axis
}

// landscape: a ring of traces around the title, programmer bottom centre, product top centre
const LANDSCAPE: TreeSpec = {
	root: "R",
	guyYaw: -0.8,
	nodes: {
		R: [1.5, 19.5],
		B0: [1.5, 12.5],
		L0: [-18, 12.5],
		DB: [-22, 16.5],
		L1: [-18, 1],
		AUTH: [-22, 1],
		L2: [-18, -15.5],
		FE: [-22, -19.5],
		T1: [2, -15.5],
		P: [2, -20.5],
		E0: [18, 12.5],
		SERVER: [22, 16.5],
		E1: [18, -2],
		API: [22, -2],
		X1: [18, -9],
		X2: [-10, -15.5],
		X3: [-10, -19.5],
	},
	edges: [
		["R", "B0"],
		["B0", "L0"],
		["L0", "DB"],
		["L0", "L1"],
		["L1", "AUTH"],
		["L1", "L2"],
		["L2", "FE"],
		["L2", "T1"],
		["T1", "P"],
		["B0", "E0"],
		["E0", "SERVER"],
		["E0", "E1"],
		["E1", "API"],
	],
	decor: [
		["E1", "X1"],
		["X2", "X3"],
	],
};

// portrait: the same story, stacked. Programmer at the bottom, product at the top. The trunk forks into
// a left and a right limb that run up behind the title, each with stubs to parts; AUTH forks again into
// FE. The title sits in the middle band (z between about -13 and 13), so the parts stay above and below it
const PORTRAIT: TreeSpec = {
	root: "R",
	guyYaw: -0.5,
	nodes: {
		R: [1.5, 40.5],
		B0: [1.5, 32.5],
		// left limb
		L0: [-10, 26],
		DB: [-4, 22],
		L1: [-10, -14],
		A0: [-6, -18],
		AUTH: [-0.5, -18],
		FE: [-6, -28],
		// right limb, which also carries the product
		E0: [13, 26],
		SERVER: [7, 22],
		E1: [13, -22],
		API: [7, -22],
		E2: [13, -32],
		P: [1.5, -40],
		X1: [9.5, 33],
	},
	edges: [
		["R", "B0"],
		["B0", "L0"],
		["L0", "DB"],
		["L0", "L1"],
		["L1", "A0"],
		["A0", "AUTH"],
		["A0", "FE"],
		["B0", "E0"],
		["E0", "SERVER"],
		["E0", "E1"],
		["E1", "API"],
		["E1", "E2"],
		["E2", "P"],
	],
	decor: [["E0", "X1"]],
};

// ---------------------------------------------------------------------------------------------
// small helpers

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (x: number) => {
	x = clamp01(x);
	return x * x * (3 - 2 * x);
};
const hash = (n: number) => {
	const s = Math.sin(n * 127.1) * 43758.5453;
	return s - Math.floor(s);
};
/** Damped spring from 0 that overshoots to ~1.3 and settles at 1: the bouncy pop used everywhere. */
const pop = (age: number) => (age <= 0 ? 0 : 1 - Math.exp(-6.5 * age) * Math.cos(15 * age));

const lambertCache = new Map<number, MeshLambertMaterial>();
function lambert(hex: number) {
	let m = lambertCache.get(hex);
	if (!m) {
		m = new MeshLambertMaterial({ color: hex, flatShading: true });
		lambertCache.set(hex, m);
	}
	return m;
}

function box(w: number, h: number, d: number, hex: number) {
	return new Mesh(new BoxGeometry(w, h, d), lambert(hex));
}

function put<T extends Object3D>(o: T, x: number, y: number, z: number, parent?: Object3D): T {
	o.position.set(x, y, z);
	parent?.add(o);
	return o;
}

/** A block that starts at the origin and extends along +z, so `aim` can point it anywhere. */
function bar(len: number, thick: number, hex: number): Group {
	const g = new Group();
	g.rotation.order = "YXZ";
	put(box(thick, thick, len, hex), 0, 0, len / 2, g);
	return g;
}

function aim(g: Object3D, dx: number, dy: number, dz: number) {
	g.rotation.y = Math.atan2(dx, dz);
	g.rotation.x = -Math.atan2(dy, Math.hypot(dx, dz));
}

function pixelTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d")!;
	ctx.imageSmoothingEnabled = false;
	draw(ctx);
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	texture.magFilter = NearestFilter;
	texture.minFilter = LinearFilter;
	texture.generateMipmaps = false;
	return { ctx, texture };
}

// 3x5 bitmap letters for the part labels
const FONT: Record<string, string[]> = {
	A: ["010", "101", "111", "101", "101"],
	B: ["110", "101", "110", "101", "110"],
	D: ["110", "101", "101", "101", "110"],
	E: ["111", "100", "110", "100", "111"],
	F: ["111", "100", "110", "100", "100"],
	H: ["101", "101", "111", "101", "101"],
	I: ["111", "010", "010", "010", "111"],
	P: ["110", "101", "110", "100", "100"],
	R: ["110", "101", "110", "101", "101"],
	S: ["011", "100", "010", "001", "110"],
	T: ["111", "010", "010", "010", "010"],
	U: ["101", "101", "101", "101", "111"],
	V: ["101", "101", "101", "101", "010"],
};

function pixelLabel(text: string) {
	const w = text.length * 4; // 3 columns per glyph, and a gap that also holds the drop shadow
	const h = 6;
	const { texture } = pixelTexture(w, h, (ctx) => {
		const glyphs = (ox: number, oy: number, color: string) => {
			ctx.fillStyle = color;
			[...text].forEach((ch, i) => {
				FONT[ch]?.forEach((row, y) => {
					[...row].forEach((bit, x) => {
						if (bit === "1") ctx.fillRect(ox + i * 4 + x, oy + y, 1, 1);
					});
				});
			});
		};
		glyphs(1, 1, "#0c0c0c");
		glyphs(0, 0, "#f2f2f2");
	});
	const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
	sprite.renderOrder = 10;
	return { sprite, w, h };
}

// ---------------------------------------------------------------------------------------------
// the programmer: cross-legged, laptop on the knees

function drawCode(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
	ctx.fillStyle = "#141a23";
	ctx.fillRect(0, 0, w, h);
	const rowH = 5;
	const scroll = t * 9;
	const first = Math.floor(scroll / rowH);
	const off = scroll - first * rowH;
	for (let i = -1; i <= Math.ceil(h / rowH); i++) {
		const n = first + i;
		const y = Math.round(i * rowH - off + 3);
		const indent = 4 + Math.floor(hash(n + 7) * 3) * 6;
		const len = 8 + Math.floor(hash(n + 13) * (w - indent - 16));
		ctx.fillStyle = CODE_COLORS[Math.floor(hash(n + 3) * CODE_COLORS.length)];
		ctx.fillRect(indent, y, len, 2);
	}
	if (Math.floor(t * 2.4) % 2 === 0) {
		ctx.fillStyle = "#f2f2f2";
		ctx.fillRect(6, h - 7, 3, 4);
	}
}

/** Where the cable meets the floor, in the programmer's own frame (x right, forward is -z). */
const GUY_ROOT: V2 = [1.9, -4.4];
/** Local bounding box of the programmer, for framing. */
const GUY_BOX = { x: 3.6, zMin: -5, zMax: 1.6, y: 5.6 };
/** He is the star of the show, so he is drawn a bit larger than the parts. */
const GUY_SCALE = 1.3;
const PRODUCT_SCALE = 1.15;

function buildGuy() {
	const guy = new Group(); // origin on the floor between the hips; faces -z
	const P = PALETTE;

	const seg = (a: Vector3, b: Vector3, thick: number, hex: number) => {
		const g = bar(a.distanceTo(b), thick, hex);
		g.position.copy(a);
		aim(g, b.x - a.x, b.y - a.y, b.z - a.z);
		guy.add(g);
		return g;
	};

	// crossed legs: thighs out to wide knees, shins back across each other in front
	const hip = (s: number) => new Vector3(s * 0.7, 0.8, 0.2);
	const knee = (s: number) => new Vector3(s * 2.3, 0.75, -1.3);
	const foot = (s: number) => new Vector3(-s * 1.0, s < 0 ? 0.7 : 1.25, -2.25);
	for (const s of [-1, 1]) {
		seg(hip(s), knee(s), 1.0, P.pants);
		seg(knee(s), foot(s), 0.9, P.pants);
		put(box(0.95, 0.6, 1.0, P.shoe), foot(s).x, foot(s).y, foot(s).z - 0.3, guy);
	}
	put(box(2.4, 1.1, 1.7, P.pants), 0, 0.75, 0.25, guy);

	// torso, big figurine head, beanie
	put(box(2.3, 2.4, 1.4, P.hoodie), 0, 2.25, 0.2, guy);
	const head = new Group();
	head.position.set(0, 3.55, 0.05);
	guy.add(head);
	put(box(1.7, 1.7, 1.7, P.skin), 0, 0.85, 0, head);
	put(box(1.72, 1.1, 0.6, P.hair), 0, 0.95, 0.6, head);
	put(box(1.85, 0.75, 1.85, P.beanie), 0, 1.95, 0, head);
	put(box(0.55, 0.5, 0.55, P.pompom), 0, 2.55, 0, head);
	for (const s of [-1, 1]) put(box(0.24, 0.3, 0.08, 0x1a1a1a), s * 0.4, 0.95, -0.87, head);

	// arms: upper arms fixed, forearms follow the typing hands
	const shoulder = [-1, 1].map((s) => new Vector3(s * 1.5, 3.15, 0.15));
	const elbow = [-1, 1].map((s) => new Vector3(s * 1.85, 1.95, -0.8));
	const hand0 = [-1, 1].map((s) => new Vector3(s * 0.7, 1.95, -2.2));
	const forearms: Group[] = [];
	for (let i = 0; i < 2; i++) {
		seg(shoulder[i], elbow[i], 0.8, P.hoodie);
		const len = hand0[i].distanceTo(elbow[i]);
		const fore = bar(len, 0.7, P.hoodie);
		fore.position.copy(elbow[i]);
		put(box(0.75, 0.45, 0.75, P.skin), 0, 0, len, fore);
		guy.add(fore);
		forearms.push(fore);
	}

	// laptop on the knees, lid hinged at the far edge
	put(box(3.2, 0.24, 2.1, P.laptop), 0, 1.75, -2.05, guy);
	put(box(2.7, 0.08, 1.2, P.laptopDark), 0, 1.9, -1.85, guy);
	const lid = new Group();
	lid.position.set(0, 1.85, -3.05);
	lid.rotation.x = -0.32;
	guy.add(lid);
	put(box(3.2, 2.1, 0.2, P.laptop), 0, 1.05, 0, lid);
	put(box(0.7, 0.7, 0.06, P.beanie), 0.8, 1.1, -0.13, lid); // sticker on the back
	const screen = pixelTexture(72, 46, () => {});
	const screenMesh = new Mesh(new PlaneGeometry(2.85, 1.82), new MeshBasicMaterial({ map: screen.texture }));
	screenMesh.position.set(0, 1.1, 0.11);
	lid.add(screenMesh);

	// cable from the laptop to the floor, where the traces start
	put(box(0.35, 1.7, 0.35, P.cable), GUY_ROOT[0], 0.95, -3.1, guy);
	put(box(0.35, 0.2, 1.5, P.cable), GUY_ROOT[0], 0.12, -3.7, guy);
	put(box(0.6, 0.5, 0.6, P.pompom), GUY_ROOT[0], 1.8, -3.1, guy);

	let lastStep = -1;
	const update = (t: number) => {
		const ts = Math.floor(t * 12) / 12; // typing runs at 12 fps, like stop motion
		for (let i = 0; i < 2; i++) {
			const burst = 0.5 + 0.5 * smooth(0.5 + 0.5 * Math.sin(ts * 0.6 + i * 1.7));
			const tap = Math.max(0, Math.sin(ts * (11 + i * 2.7) + i * 2.1));
			aim(
				forearms[i],
				hand0[i].x + Math.sin(ts * 2.3 + i) * 0.14 * burst - elbow[i].x,
				hand0[i].y + tap * 0.22 * burst - elbow[i].y,
				hand0[i].z - elbow[i].z,
			);
		}
		head.rotation.x = -0.32 + 0.08 * Math.sin(t * 0.9) + 0.05 * Math.sin(ts * 5.3);
		head.rotation.y = 0.14 * Math.sin(t * 0.37);

		const step = Math.floor(t * 12);
		if (step !== lastStep) {
			lastStep = step;
			drawCode(screen.ctx, 72, 46, step / 12);
			screen.texture.needsUpdate = true;
		}
	};

	return { group: guy, update };
}

// ---------------------------------------------------------------------------------------------
// the parts of the app

function buildDb(c: number) {
	const g = new Group();
	for (let i = 0; i < 3; i++) g.add(put(new Mesh(new CylinderGeometry(1.5, 1.5, 0.85, 8), lambert(c)), 0, 0.55 + i * 1.05, 0));
	return { group: g, height: 3.2 };
}

function buildServer(c: number) {
	const g = new Group();
	for (let i = 0; i < 3; i++) {
		const y = 0.55 + i * 1.05;
		g.add(put(box(3.2, 0.9, 2.3, c), 0, y, 0));
		g.add(put(box(0.32, 0.32, 0.1, PALETTE.pompom), 1.05, y, 1.2));
		g.add(put(box(1.4, 0.16, 0.1, 0x000000), -0.5, y, 1.2));
	}
	return { group: g, height: 3.2 };
}

function buildApi(c: number) {
	const g = new Group();
	g.add(put(box(3.0, 0.7, 3.0, c), 0, 0.5, 0));
	g.add(put(box(1.5, 0.5, 1.5, 0xffe38a), 0, 1.05, 0));
	for (let i = 0; i < 3; i++) {
		const p = -0.9 + i * 0.9;
		for (const s of [-1, 1]) {
			g.add(put(box(0.4, 0.3, 0.5, 0xb88f00), p, 0.3, s * 1.7));
			g.add(put(box(0.5, 0.3, 0.4, 0xb88f00), s * 1.7, 0.3, p));
		}
	}
	return { group: g, height: 1.6 };
}

function buildAuth(c: number) {
	const g = new Group();
	g.add(put(box(2.5, 1.9, 1.3, c), 0, 1.05, 0));
	g.add(put(box(0.5, 1.1, 0.5, 0xe0e0e0), -0.75, 2.5, 0));
	g.add(put(box(0.5, 1.1, 0.5, 0xe0e0e0), 0.75, 2.5, 0));
	g.add(put(box(2.0, 0.5, 0.5, 0xe0e0e0), 0, 3.15, 0));
	g.add(put(box(0.4, 0.7, 0.1, 0x000000), 0, 1.05, 0.7));
	return { group: g, height: 3.5 };
}

function buildFe(c: number) {
	const g = new Group();
	g.add(put(box(3.8, 2.7, 0.45, c), 0, 1.75, 0));
	g.add(put(box(1.4, 0.35, 1.1, 0xe0e0e0), 0, 0.2, 0));
	const tex = pixelTexture(38, 26, (ctx) => {
		ctx.fillStyle = "#101010";
		ctx.fillRect(0, 0, 38, 26);
		ctx.fillStyle = "#3a3a3a";
		for (let i = 0; i < 3; i++) ctx.fillRect(2 + i * 3, 2, 2, 2);
		ctx.fillStyle = "#f2f2f2";
		ctx.fillRect(3, 7, 18, 3);
		ctx.fillRect(3, 12, 12, 3);
		ctx.fillStyle = "#ffcf33";
		ctx.fillRect(3, 18, 8, 5);
		ctx.fillStyle = "#3d7bff";
		ctx.fillRect(13, 18, 8, 5);
		ctx.fillStyle = "#2fd487";
		ctx.fillRect(23, 18, 8, 5);
	});
	const front = new Mesh(new PlaneGeometry(3.4, 2.3), new MeshBasicMaterial({ map: tex.texture }));
	front.position.set(0, 1.75, 0.24);
	g.add(front);
	return { group: g, height: 3.2 };
}

const BUILDERS: Record<Key, (c: number) => { group: Group; height: number }> = {
	DB: buildDb,
	SERVER: buildServer,
	API: buildApi,
	AUTH: buildAuth,
	FE: buildFe,
};

// ---------------------------------------------------------------------------------------------
// the product: a tiny copy of this page in a chunky browser window

function buildProduct() {
	const outer = new Group(); // popped and shrunk by the timeline
	const g = new Group();
	g.scale.setScalar(PRODUCT_SCALE);
	outer.add(g);
	put(box(7.4, 4.9, 0.55, PALETTE.ink), 0, 3.0, 0, g);
	put(box(2.6, 0.5, 1.6, 0xd0d0d0), 0, 0.3, -0.1, g);
	put(box(0.9, 0.7, 0.4, 0xd0d0d0), 0, 0.75, -0.1, g);
	// 64x40 texels with the page's own font at its native 8px, so every font pixel is exactly one texel
	const tex = pixelTexture(64, 40, (ctx) => {
		ctx.fillStyle = "#0c0c0c";
		ctx.fillRect(0, 0, 64, 40);
		ctx.fillStyle = "#1c1c1c";
		ctx.fillRect(0, 0, 64, 5);
		ctx.fillStyle = "#4a4a4a";
		for (let i = 0; i < 3; i++) ctx.fillRect(2 + i * 3, 2, 1, 1);
		ctx.fillStyle = "#f2f2f2";
		ctx.font = '8px "Press Start 2P", monospace';
		ctx.textBaseline = "top";
		ctx.fillText("Martin", 8, 10);
		ctx.fillText("Macura", 8, 20);
		// the motto and the links, as bars
		ctx.fillStyle = "#8a8a8a";
		ctx.fillRect(8, 33, 16, 1);
		ctx.fillStyle = "#f2f2f2";
		ctx.fillRect(28, 33, 8, 1);
		ctx.fillRect(40, 33, 3, 1);
		ctx.fillRect(47, 33, 9, 1);
	});
	const front = new Mesh(new PlaneGeometry(6.7, 4.2), new MeshBasicMaterial({ map: tex.texture }));
	front.position.set(0, 3.0, 0.29);
	g.add(front);
	return { group: outer, height: 5.6 * PRODUCT_SCALE };
}

// ---------------------------------------------------------------------------------------------
// trace geometry

/** Octilinear route between two points: a straight run and a 45 degree run. */
function route(a: V2, b: V2, diagonalFirst = false): V2[] {
	const dx = b[0] - a[0];
	const dz = b[1] - a[1];
	const adx = Math.abs(dx);
	const adz = Math.abs(dz);
	if (adx < 1e-6 || adz < 1e-6 || Math.abs(adx - adz) < 1e-6) return [a, b];
	const m = Math.min(adx, adz);
	const sx = Math.sign(dx);
	const sz = Math.sign(dz);
	const diagonal: V2 = [a[0] + sx * m, a[1] + sz * m];
	const straight: V2 = adx > adz ? [a[0] + sx * (adx - m), a[1]] : [a[0], a[1] + sz * (adz - m)];
	return [a, diagonalFirst ? diagonal : straight, b];
}

const TRACE_VERT = /* glsl */ `
attribute float aDist;
varying float vDist;
void main() {
	vDist = aDist;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// uHeads[i] is where packet i is along this edge; everything behind a packet stays lit
const TRACE_FRAG = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uLit;
uniform float uHeads[${ROUTES}];
uniform float uLitAmt;
varying float vDist;
void main() {
	float lit = 0.0;
	for (int i = 0; i < ${ROUTES}; i++) lit = max(lit, step(vDist, uHeads[i]));
	gl_FragColor = vec4(mix(uBase, uLit, lit * uLitAmt), 1.0);
	#include <colorspace_fragment>
}`;

function traceMaterial(lit: number) {
	return new ShaderMaterial({
		uniforms: {
			uBase: { value: new Color(PALETTE.trace) },
			uLit: { value: new Color(lit) },
			uHeads: { value: new Float32Array(ROUTES).fill(-50) },
			uLitAmt: { value: 1 },
		},
		vertexShader: TRACE_VERT,
		fragmentShader: TRACE_FRAG,
		side: DoubleSide,
	});
}

/** Flat ribbon along a world (x, z) polyline with mitered joins; aDist is the distance along it. */
function ribbon(pts: V2[], width: number, y: number) {
	const pos: number[] = [];
	const dist: number[] = [];
	const idx: number[] = [];
	let run = 0;
	const normal = (a: V2, b: V2): V2 => {
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		return [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
	};
	pts.forEach((p, i) => {
		if (i > 0) run += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
		const n1 = i > 0 ? normal(pts[i - 1], p) : normal(p, pts[i + 1]);
		const n2 = i < pts.length - 1 ? normal(p, pts[i + 1]) : n1;
		let mx = n1[0] + n2[0];
		let mz = n1[1] + n2[1];
		const ml = Math.hypot(mx, mz);
		mx /= ml;
		mz /= ml;
		const k = width / 2 / Math.max(0.3, mx * n1[0] + mz * n1[1]);
		pos.push(p[0] + mx * k, y, p[1] + mz * k, p[0] - mx * k, y, p[1] - mz * k);
		dist.push(run, run);
		if (i < pts.length - 1) {
			const a = i * 2;
			idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
		}
	});
	const geo = new BufferGeometry();
	geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
	geo.setAttribute("aDist", new Float32BufferAttribute(dist, 1));
	geo.setIndex(idx);
	return { geo, length: run };
}

interface Edge {
	mesh: Mesh;
	mat: ShaderMaterial;
	/** per route: distance from the start of that route to the start of this edge, or -1 if not on it */
	offset: number[];
}

interface Path {
	pts: V2[];
	cum: number[];
	length: number;
}

interface NodePad {
	mat: MeshBasicMaterial;
	/** [route, distance along that route] pairs that pass through this node */
	via: [number, number][];
}

// ---------------------------------------------------------------------------------------------

export async function start(canvas: HTMLCanvasElement) {
	let renderer: WebGLRenderer;
	try {
		renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "low-power" });
	} catch {
		return;
	}
	renderer.setClearColor(0x000000, 0);

	try {
		await document.fonts.load('8px "Press Start 2P"');
	} catch {
		// fall back to whatever font the canvas resolves
	}

	const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

	// dev only: ?t=6.5 freezes the timeline, ?view=x,z,width frames a close-up, ?yaw= turns the programmer
	let frozen: number | null = null;
	let debugView: number[] | null = null;
	let debugYaw: number | null = null;
	if (import.meta.env.DEV) {
		const params = new URLSearchParams(location.search);
		const q = params.get("t");
		if (q !== null && q !== "") frozen = Number(q);
		const v = params.get("view");
		if (v) debugView = v.split(",").map(Number);
		const y = params.get("yaw");
		if (y) debugYaw = Number(y);
	}

	const scene = new Scene();
	scene.add(new AmbientLight(0xffffff, 1.4));
	const sun = new DirectionalLight(0xffffff, 2.4);
	sun.position.set(-6, 12, 8);
	scene.add(sun);

	const guy = buildGuy();
	guy.group.scale.setScalar(GUY_SCALE);
	scene.add(guy.group);

	// parts: a module, its socket tile, its label
	const parts = KEYS.map((key) => {
		const color = PALETTE[key];
		const built = BUILDERS[key](color);
		const tileMat = new MeshLambertMaterial({ color: PALETTE.tile, flatShading: true });
		const tile = new Mesh(new BoxGeometry(4.2, 0.2, 4.2), tileMat);
		const label = pixelLabel(key);
		scene.add(built.group, tile, label.sprite);
		return { key, color, group: built.group, height: built.height, tile, tileMat, label };
	});

	const product = buildProduct();
	scene.add(product.group);
	const productTile = new Mesh(new BoxGeometry(9.2 * PRODUCT_SCALE, 0.2, 5.4 * PRODUCT_SCALE), new MeshLambertMaterial({ color: PALETTE.tile, flatShading: true }));
	scene.add(productTile);

	// one packet per route; colour = the part it carries (the deploy packet is white)
	const packets = Array.from({ length: ROUTES }, (_, r) => {
		const m = box(1.0, 1.0, 1.0, r === DEPLOY ? PALETTE.ink : PALETTE[KEYS[r]]);
		m.visible = false;
		scene.add(m);
		return m;
	});

	// confetti when the product pops
	const confettiColors = [PALETTE.DB, PALETTE.SERVER, PALETTE.API, PALETTE.AUTH, PALETTE.FE, PALETTE.ink];
	const confetti = Array.from({ length: 22 }, (_, i) => {
		const m = box(0.42, 0.42, 0.42, confettiColors[i % confettiColors.length]);
		m.visible = false;
		scene.add(m);
		const a = hash(i * 3.1) * Math.PI * 2;
		const sp = 4 + hash(i * 7.7) * 6;
		return { m, vx: Math.cos(a) * sp, vy: 9 + hash(i * 5.3) * 8, vz: Math.sin(a) * sp * 0.8, spin: 3 + hash(i + 1) * 8 };
	});

	const flow = new Group(); // everything that depends on the layout
	scene.add(flow);
	const padGeo = new CylinderGeometry(0.85, 0.85, 0.16, 8);
	const viaGeo = new CylinderGeometry(0.55, 0.55, 0.16, 8); // where a dead-end trace stops
	const decorMat = new MeshBasicMaterial({ color: PALETTE.trace, side: DoubleSide }); // the ribbons have no fixed winding

	// ---- layout (landscape rings the title, portrait stacks) -------------------------------------

	let portrait = false;
	const edges: Edge[] = [];
	const paths: Path[] = [];
	const pads: NodePad[] = [];
	const sites: V2[] = []; // where each part lives
	const productAt: V2 = [0, 0];
	const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
	const target = new Vector3();
	let fit = { sxMin: 0, sxMax: 1, syMin: 0, syMax: 1 };

	function layout(isPortrait: boolean) {
		portrait = isPortrait;
		const spec = portrait ? PORTRAIT : LANDSCAPE;

		for (const e of edges) e.mat.dispose();
		for (const p of pads) p.mat.dispose();
		for (const child of [...flow.children]) {
			flow.remove(child);
			const geo = (child as Mesh).geometry;
			if (geo && geo !== padGeo && geo !== viaGeo) geo.dispose();
		}
		edges.length = 0;
		paths.length = 0;
		pads.length = 0;
		sites.length = 0;

		// tree structure: which edges lead from the root to each leaf
		const parentEdge = new Map<string, number>();
		spec.edges.forEach(([, to], i) => parentEdge.set(to, i));
		const routeEdges: number[][] = [];
		for (let r = 0; r < ROUTES; r++) {
			const chain: number[] = [];
			let node = r === DEPLOY ? "P" : KEYS[r];
			while (parentEdge.has(node)) {
				const e = parentEdge.get(node)!;
				chain.unshift(e);
				node = spec.edges[e][0];
			}
			routeEdges.push(chain);
		}

		// edges: one chunky ribbon each, lit in the part's own colour if only one part uses it
		const edgePts = spec.edges.map(([from, to, df]) => route(spec.nodes[from], spec.nodes[to], df));
		const edgeLen = edgePts.map((pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0));
		spec.edges.forEach((_, i) => {
			const users = routeEdges.flatMap((chain, r) => (chain.includes(i) ? [r] : []));
			const exclusive = users.length === 1 && users[0] !== DEPLOY;
			const mat = traceMaterial(exclusive ? PALETTE[KEYS[users[0]]] : PALETTE.traceLit);
			const mesh = new Mesh(ribbon(edgePts[i], TRACE_WIDTH, 0.05).geo, mat);
			flow.add(mesh);
			const offset = Array.from({ length: ROUTES }, (_, r) => {
				const chain = routeEdges[r];
				const k = chain.indexOf(i);
				return k < 0 ? -1 : chain.slice(0, k).reduce((s, e) => s + edgeLen[e], 0);
			});
			edges.push({ mesh, mat, offset });
		});

		// decor: dead-end traces ending in a via
		for (const [from, to, df] of spec.decor) {
			flow.add(new Mesh(ribbon(route(spec.nodes[from], spec.nodes[to], df), TRACE_WIDTH, 0.05).geo, decorMat));
			flow.add(put(new Mesh(viaGeo, decorMat), spec.nodes[to][0], 0.08, spec.nodes[to][1]));
		}

		// routes as polylines for the packets
		for (let r = 0; r < ROUTES; r++) {
			const pts: V2[] = [];
			routeEdges[r].forEach((e, k) => edgePts[e].forEach((p, j) => (k === 0 || j > 0) && pts.push(p)));
			const cum = [0];
			for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
			paths.push({ pts, cum, length: cum[cum.length - 1] });
		}

		// junction pads (big chunky vias)
		const nodeVia = new Map<string, [number, number][]>();
		const visit = (name: string, r: number, at: number) => nodeVia.set(name, [...(nodeVia.get(name) ?? []), [r, at]]);
		for (let r = 0; r < ROUTES; r++) {
			let d = 0;
			visit(spec.root, r, 0);
			for (const e of routeEdges[r]) {
				d += edgeLen[e];
				visit(spec.edges[e][1], r, d);
			}
		}
		for (const [name, via] of nodeVia) {
			const mat = new MeshBasicMaterial({ color: PALETTE.trace });
			flow.add(put(new Mesh(padGeo, mat), spec.nodes[name][0], 0.08, spec.nodes[name][1]));
			pads.push({ mat, via });
		}

		// the programmer sits so that his cable lands on the root node
		const yaw = debugYaw ?? spec.guyYaw;
		const cos = Math.cos(yaw);
		const sin = Math.sin(yaw);
		const root = spec.nodes[spec.root];
		guy.group.rotation.y = yaw;
		guy.group.position.set(
			root[0] - GUY_SCALE * (GUY_ROOT[0] * cos + GUY_ROOT[1] * sin),
			0,
			root[1] - GUY_SCALE * (-GUY_ROOT[0] * sin + GUY_ROOT[1] * cos),
		);

		KEYS.forEach((key, k) => {
			const [x, z] = spec.nodes[key];
			sites.push([x, z]);
			parts[k].group.position.set(x, 0, z);
			parts[k].tile.position.set(x, 0.1, z);
		});
		productAt[0] = spec.nodes.P[0];
		productAt[1] = spec.nodes.P[1];
		product.group.position.set(productAt[0], 0, productAt[1]);
		productTile.position.set(productAt[0], 0.1, productAt[1]);

		// frame everything: project the interesting points and fit the ortho frustum around them
		const pts3: [number, number, number][] = [];
		for (const [x, z] of Object.values(spec.nodes)) pts3.push([x, 0, z]);
		for (const s of sites) for (const dx of [-2.3, 2.3]) for (const dz of [-2.3, 2.3]) pts3.push([s[0] + dx, 4.4, s[1] + dz]);
		for (const dx of [-4.6, 4.6]) for (const dz of [-2.7, 2.7]) pts3.push([productAt[0] + dx * PRODUCT_SCALE, 6.2 * PRODUCT_SCALE, productAt[1] + dz * PRODUCT_SCALE]);
		const corners: [number, number][] = [
			[GUY_BOX.zMin, 0],
			[GUY_BOX.zMax, 0],
			[GUY_BOX.zMin, GUY_BOX.y],
			[GUY_BOX.zMax, GUY_BOX.y],
		];
		for (const sx of [-1, 1]) {
			for (const [lz, y] of corners) {
				const lx = sx * GUY_BOX.x;
				pts3.push([
					guy.group.position.x + GUY_SCALE * (lx * cos + lz * sin),
					GUY_SCALE * y,
					guy.group.position.z + GUY_SCALE * (-lx * sin + lz * cos),
				]);
			}
		}
		let sxMin = Infinity, sxMax = -Infinity, syMin = Infinity, syMax = -Infinity;
		for (const [x, y, z] of pts3) {
			const sy = y * Math.cos(ELEVATION) - z * Math.sin(ELEVATION);
			sxMin = Math.min(sxMin, x);
			sxMax = Math.max(sxMax, x);
			syMin = Math.min(syMin, sy);
			syMax = Math.max(syMax, sy);
		}
		fit = { sxMin, sxMax, syMin, syMax };
		target.set((sxMin + sxMax) / 2, 0, -((syMin + syMax) / 2) / Math.sin(ELEVATION));
	}

	// ---- timeline -------------------------------------------------------------------------------

	const depart: number[] = [];
	const speed = Array.from({ length: ROUTES }, (_, r) => (r === DEPLOY ? DEPLOY_SPEED : PACKET_SPEED));
	const arrive: number[] = [];
	let mergeAt = 0;
	let productT = 0;
	let outroAt = 0;
	let cycle = 1;
	const MERGE = 1.25;

	function timeline() {
		// parts pop up in order, ARRIVE_GAP apart; each packet leaves early enough to land on time
		const first = paths[0].length / speed[0] + 0.6;
		const goals = KEYS.map((_, k) => first + k * ARRIVE_GAP);
		const shift = Math.max(0, ...goals.map((g, k) => 0.5 - (g - paths[k].length / speed[k])));
		KEYS.forEach((_, k) => {
			arrive[k] = goals[k] + shift;
			depart[k] = arrive[k] - paths[k].length / speed[k];
		});
		depart[DEPLOY] = arrive[KEYS.length - 1] + 0.6;
		arrive[DEPLOY] = depart[DEPLOY] + paths[DEPLOY].length / speed[DEPLOY];
		mergeAt = arrive[DEPLOY] - 0.2;
		productT = mergeAt + MERGE + 0.25;
		outroAt = productT + 5;
		cycle = outroAt + 0.9 + 0.8;
	}

	const head = new Float32Array(ROUTES);
	const at = new Vector3();

	function pointAt(r: number, d: number, out: Vector3) {
		const p = paths[r];
		const dd = Math.min(Math.max(d, 0), p.length);
		let i = 1;
		while (i < p.cum.length - 1 && p.cum[i] < dd) i++;
		const f = (dd - p.cum[i - 1]) / (p.cum[i] - p.cum[i - 1] || 1);
		out.set(lerp(p.pts[i - 1][0], p.pts[i][0], f), 0, lerp(p.pts[i - 1][1], p.pts[i][1], f));
	}

	const tileDim = new Color(PALETTE.tile);
	const padDim = new Color(PALETTE.trace);
	const padLit = new Color(PALETTE.traceLit);
	const tint = new Color();

	function apply(time: number) {
		const c = frozen !== null || reduced ? time : time % cycle;
		guy.update(time);

		const outro = clamp01((c - outroAt) / 0.9);
		for (let r = 0; r < ROUTES; r++) head[r] = c < depart[r] ? -50 : (c - depart[r]) * speed[r];

		// traces: everything behind a packet stays lit
		for (const e of edges) {
			const heads = e.mat.uniforms.uHeads.value as Float32Array;
			for (let r = 0; r < ROUTES; r++) heads[r] = e.offset[r] < 0 || head[r] < 0 ? -50 : head[r] - e.offset[r];
			e.mat.uniforms.uLitAmt.value = 1 - outro;
		}
		for (const p of pads) {
			let lit = 0;
			for (const [r, d] of p.via) if (head[r] >= d) lit = 1;
			p.mat.color.copy(padDim).lerp(padLit, lit * (1 - outro));
		}

		// packets: hop along the trace until they reach their part
		for (let r = 0; r < ROUTES; r++) {
			const d = head[r];
			const live = d >= 0 && d < paths[r].length;
			packets[r].visible = live;
			if (live) {
				pointAt(r, d, at);
				packets[r].position.set(at.x, 0.75 + Math.abs(Math.sin(d * 0.8)) * 0.9, at.z);
				packets[r].rotation.y = d * 0.6;
			}
		}

		// parts: pop up when their packet lands, hop over to the product when it's deployed
		parts.forEach((part, k) => {
			const age = c - arrive[k];
			const s = pop(age);
			const q = clamp01((c - mergeAt - k * 0.09) / MERGE);
			const e = smooth(q);
			part.group.visible = age > 0 && q < 1;
			part.label.sprite.visible = age > 0.2 && q < 0.05;
			const shrink = lerp(1, 0.3, e);
			const wide = shrink * (1 + (1 - s) * 0.3); // squash and stretch
			part.group.scale.set(wide, Math.max(0.001, s) * shrink, wide);
			part.group.position.set(lerp(sites[k][0], productAt[0], e), Math.sin(Math.PI * q) * 7, lerp(sites[k][1], productAt[1], e));
			part.group.rotation.y = e * Math.PI * 2;
			const land = smooth(age / 0.5) * (1 - smooth(q * 4));
			tint.set(part.color).multiplyScalar(0.28);
			part.tileMat.color.copy(tileDim).lerp(tint, land);
		});

		// product: pops out when the parts land, then shrinks away
		const pr = c - productT;
		const shrinkOut = 1 - smooth((c - outroAt) / 0.8);
		const p = pop(pr);
		const ps = Math.max(0.0001, p * shrinkOut);
		const wide = ps * (1 + (1 - clamp01(p)) * 0.25);
		product.group.visible = pr > 0 && shrinkOut > 0;
		product.group.scale.set(wide, ps, wide);

		for (const k of confetti) {
			k.m.visible = pr > 0 && pr < 2.2;
			if (k.m.visible) {
				k.m.position.set(productAt[0] + k.vx * pr, Math.max(0.2, 3 + k.vy * pr - 12 * pr * pr), productAt[1] + k.vz * pr);
				k.m.rotation.set(pr * k.spin, pr * k.spin * 0.7, 0);
			}
		}
	}

	// ---- rendering ------------------------------------------------------------------------------

	function frameCamera(w: number, h: number) {
		const aspect = w / h;
		const spanX = (fit.sxMax - fit.sxMin) * 1.04;
		const spanY = (fit.syMax - fit.syMin) * 1.04;
		let W = Math.max(spanX, spanY * aspect);
		if (debugView) W = debugView[2];
		const H = W / aspect;
		camera.left = -W / 2;
		camera.right = W / 2;
		camera.top = H / 2;
		camera.bottom = -H / 2;
		camera.updateProjectionMatrix();
		if (debugView) target.set(debugView[0], 0, debugView[1]);
		camera.position.set(target.x, target.y + Math.sin(ELEVATION) * 120, target.z + Math.cos(ELEVATION) * 120);
		camera.lookAt(target);
		// labels are bitmap text: one texel is exactly one buffer pixel, and the sprite is snapped to the pixel grid
		camera.updateMatrixWorld();
		const bufW = renderer.domElement.width;
		const bufH = renderer.domElement.height;
		const snap = (ndc: number, size: number, n: number) => {
			const px = (ndc * 0.5 + 0.5) * n;
			return ((size % 2 ? Math.floor(px) + 0.5 : Math.round(px)) / n - 0.5) * 2;
		};
		parts.forEach((part, k) => {
			const { sprite, w: lw, h: lh } = part.label;
			sprite.scale.set(lw / (bufW / W), lh / (bufW / W), 1);
			sprite.position.set(sites[k][0], part.height + 1.5, sites[k][1]).project(camera);
			sprite.position.x = snap(sprite.position.x, lw, bufW);
			sprite.position.y = snap(sprite.position.y, lh, bufH);
			sprite.position.unproject(camera);
		});
	}

	function resize() {
		const w = canvas.clientWidth || innerWidth;
		const h = canvas.clientHeight || innerHeight;
		// render at a fraction of the screen resolution: chunky pixels are the look
		const pixel = Math.min(6, Math.max(2, Math.round(w / 480)));
		renderer.setPixelRatio(1 / pixel);
		renderer.setSize(w, h, false);
		const wantPortrait = w / h < 1;
		if (wantPortrait !== portrait || edges.length === 0) {
			layout(wantPortrait);
			timeline();
		}
		frameCamera(w, h);
	}

	resize();
	let resizeTimer = 0;
	addEventListener("resize", () => {
		clearTimeout(resizeTimer);
		resizeTimer = window.setTimeout(() => {
			resize();
			if (staticFrame) draw();
		}, 80);
	});

	const staticFrame = frozen !== null || reduced;
	const staticTime = frozen ?? productT + 2;
	const t0 = performance.now();

	const draw = () => {
		apply(staticFrame ? staticTime : ((performance.now() - t0) / 1000) * SPEED);
		renderer.render(scene, camera);
	};

	if (import.meta.env.DEV) (window as unknown as { __bgDraw: () => void }).__bgDraw = draw;
	// first frame is drawn before fading the canvas in
	draw();
	canvas.classList.add("on");
	if (staticFrame) return;

	let last = 0;
	const loop = (now: number) => {
		requestAnimationFrame(loop);
		if (document.hidden || !canvas.clientWidth || now - last < 1000 / 70) return; // ~60fps cap on high-refresh displays
		last = now;
		draw();
	};
	requestAnimationFrame(loop);
}
