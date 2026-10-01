// /vlaky: a European town in 8 bits, ten times the size of a screen, with a railway of irregular curves, switches,
// signals, tunnels and bridges. Trains of all sorts run round it and stop at the stations, where people get off and
// on. Drag to pan, wheel or pinch to zoom. Rendered at a fraction of the screen resolution on purpose, like the
// background of the front page.
import {
	AmbientLight,
	Color,
	DirectionalLight,
	type BufferGeometry,
	Mesh,
	type MeshLambertMaterial,
	OrthographicCamera,
	Scene,
	Vector3,
	WebGLRenderer,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { buildRailScenery, carvePoints, createRails, stationSites, useLayout } from "./rails";
import { createCrossings } from "./crossings";
import { CH, fictionWorld } from "./terrain";
import type { Chunk, World } from "./world";
import { createTraffic } from "./trains";
import { box, clamp, COLORS, glass, glow, rng, unit } from "./util";

export interface Vlaky {
	setNight(on: boolean): void;
}

export async function start(canvas: HTMLCanvasElement, options: { night?: boolean; world?: World } = {}): Promise<Vlaky | null> {
	let renderer: WebGLRenderer;
	try {
		renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "low-power" });
	} catch {
		document.documentElement.classList.add("no-webgl");
		return null;
	}
	renderer.setClearColor(0x000000, 0);
	try {
		await document.fonts.load('8px "Press Start 2P"');
	} catch {
		// the labels fall back to a monospace font
	}
	const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
	const rand = rng(7);

	const scene = new Scene();
	const ambient = new AmbientLight(0xffffff, 1.4);
	const sun = new DirectionalLight(0xffffff, 2.4);
	scene.add(ambient, sun);

	// --- the land, the railway
	const world = options.world ?? fictionWorld;
	const { isleX: ISLE_X, isleZ: ISLE_Z, isWater, roadAt, hillHeight } = world;
	if (world.layout) useLayout(world.layout);
	world.initWater(carvePoints);
	const rails = createRails(isWater);
	box(scene, ISLE_X * 2, 0.3, ISLE_Z * 2, world.ground ?? COLORS.grass, 0, -0.15, 0);
	box(scene, ISLE_X * 2, 1.4, ISLE_Z * 2, COLORS.soil, 0, -1, 0);
	const scenery = buildRailScenery(scene, rails, isWater);
	const sites = stationSites(rails);
	const crossings = createCrossings(scene, rails, sites, isWater, roadAt);

	// thousands of boxes would be thousands of draw calls: merge the track into one mesh per material
	const batches = new Map<MeshLambertMaterial, BufferGeometry[]>();
	for (const child of [...scene.children]) {
		if (!(child instanceof Mesh) || child.geometry !== unit || child.userData.dynamic) continue;
		child.updateMatrix();
		const g = unit.clone().applyMatrix4(child.matrix);
		const list = batches.get(child.material as MeshLambertMaterial);
		if (list) list.push(g);
		else batches.set(child.material as MeshLambertMaterial, [g]);
		scene.remove(child);
	}
	for (const [mat, geos] of batches) scene.add(new Mesh(mergeGeometries(geos), mat));

	const traffic = createTraffic(scene, rails, scenery, sites, rand);
	const cars = crossings.attach(traffic.trains);

	// --- the town around it is built in chunks, where the camera looks
	const buildChunk = world.createChunkBuilder(rails.railDist, crossings.roadOK);
	const chunks = new Map<string, { chunk: Chunk; seen: number }>();
	let tick = 0;
	let night = options.night ? 1 : 0; // 0 is day, 1 is night
	let nightTarget = night;

	const camera = new OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
	const corners3 = (hx: number, hz: number) => [-hx, hx].flatMap((x) => [-hz, hz].flatMap((z) => [-2, 5].map((y) => new Vector3(x, y, z))));
	const fitCorners = corners3(world.fit.hx, world.fit.hz).map((c) => c.add(new Vector3(world.fit.x, 0, world.fit.z))); // what the first view shows
	const isleCorners = corners3(ISLE_X, ISLE_Z);
	const extent = (corners: Vector3[]) => {
		const e = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
		for (const c of corners) {
			const v = c.clone().applyMatrix4(camera.matrixWorldInverse);
			e.minX = Math.min(e.minX, v.x);
			e.maxX = Math.max(e.maxX, v.x);
			e.minY = Math.min(e.minY, v.y);
			e.maxY = Math.max(e.maxY, v.y);
		}
		return e;
	};

	const pa = new Vector3();
	const pb = new Vector3();
	function updateChunks(budget: number) {
		tick++;
		let minX = Infinity;
		let maxX = -Infinity;
		let minZ = Infinity;
		let maxZ = -Infinity;
		for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
			pa.set(nx, ny, -1).unproject(camera);
			pb.set(nx, ny, 1).unproject(camera);
			const t = pa.y / (pa.y - pb.y);
			const gx = pa.x + (pb.x - pa.x) * t;
			const gz = pa.z + (pb.z - pa.z) * t;
			minX = Math.min(minX, gx);
			maxX = Math.max(maxX, gx);
			minZ = Math.min(minZ, gz);
			maxZ = Math.max(maxZ, gz);
		}
		const cx0 = Math.max(Math.floor((minX - 14) / CH), -ISLE_X / CH);
		const cx1 = Math.min(Math.floor((maxX + 14) / CH), ISLE_X / CH - 1);
		const cz0 = Math.max(Math.floor((minZ - 14) / CH), -ISLE_Z / CH);
		const cz1 = Math.min(Math.floor((maxZ + 14) / CH), ISLE_Z / CH - 1);
		const midX = (minX + maxX) / 2;
		const midZ = (minZ + maxZ) / 2;
		const missing: [number, number, number][] = [];
		for (let cz = cz0; cz <= cz1; cz++) {
			for (let cx = cx0; cx <= cx1; cx++) {
				const entry = chunks.get(`${cx},${cz}`);
				if (entry) entry.seen = tick;
				else missing.push([cx, cz, Math.hypot((cx + 0.5) * CH - midX, (cz + 0.5) * CH - midZ)]);
			}
		}
		missing.sort((a, b) => a[2] - b[2]);
		for (const [cx, cz] of missing.slice(0, budget)) {
			const chunk = buildChunk(cx, cz);
			scene.add(chunk.main);
			if (chunk.lights) {
				chunk.lights.visible = night > 0.5;
				scene.add(chunk.lights);
			}
			chunks.set(`${cx},${cz}`, { chunk, seen: tick });
		}
		if (chunks.size > 260) {
			const old = [...chunks.entries()].filter(([, e]) => e.seen < tick).sort((a, b) => a[1].seen - b[1].seen);
			for (const [key, e] of old) {
				if (chunks.size <= 200) break;
				scene.remove(e.chunk.main);
				e.chunk.main.geometry.dispose();
				if (e.chunk.lights) {
					scene.remove(e.chunk.lights);
					e.chunk.lights.geometry.dispose();
				}
				chunks.delete(key);
			}
		}
	}

	// --- day and night: light, windows, lamps
	const DAY = { ambient: new Color(0xffffff), sun: new Color(0xffffff), ambientI: 1.4, sunI: 2.4, sunPos: new Vector3(-8, 14, 10) };
	const NIGHT = { ambient: new Color(0x6a7cc4), sun: new Color(0x9fb4ff), ambientI: 0.85, sunI: 0.75, sunPos: new Vector3(10, 14, -6) };
	const windowGlow = new Color(0xffd27a);
	const headGlow = new Color(0xffcf33);
	function applyLight() {
		ambient.color.copy(DAY.ambient).lerp(NIGHT.ambient, night);
		ambient.intensity = DAY.ambientI + (NIGHT.ambientI - DAY.ambientI) * night;
		sun.color.copy(DAY.sun).lerp(NIGHT.sun, night);
		sun.intensity = DAY.sunI + (NIGHT.sunI - DAY.sunI) * night;
		sun.position.copy(DAY.sunPos).lerp(NIGHT.sunPos, night);
		glass.emissive.copy(windowGlow).multiplyScalar(night > 0.5 ? (night - 0.5) * 1.6 : 0);
		glow.emissive.copy(headGlow).multiplyScalar(night);
		for (const { chunk } of chunks.values()) if (chunk.lights) chunk.lights.visible = night > 0.5;
	}
	applyLight();

	// --- view: drag to pan, wheel or pinch to zoom
	const KMIN = 0.25;
	const view = { cx: 0, cy: 0, k: 1 }; // centre in camera space, zoom factor
	let baseHalf = 1; // half the height of the first view
	let kMax = 1;
	let aspect = 1;
	let portrait: boolean | null = null;
	let isle = extent([]);
	let viewW = 1;
	let viewH = 1;

	function applyView() {
		view.k = clamp(view.k, KMIN, kMax);
		const half = baseHalf * view.k;
		const hw = half * aspect;
		// the centre may roam over most of the island, never off into the void
		const offX = Math.max(0, (isle.maxX - isle.minX) / 2 - hw) * 0.9;
		const offY = Math.max(0, (isle.maxY - isle.minY) / 2 - half) * 0.9;
		const midX = (isle.minX + isle.maxX) / 2;
		const midY = (isle.minY + isle.maxY) / 2;
		view.cx = clamp(view.cx, midX - offX, midX + offX);
		view.cy = clamp(view.cy, midY - offY, midY + offY);
		camera.left = view.cx - hw;
		camera.right = view.cx + hw;
		camera.top = view.cy + half;
		camera.bottom = view.cy - half;
		camera.updateProjectionMatrix();
	}

	function frame(w: number, h: number) {
		const wantPortrait = w / h < 1;
		const yaw = wantPortrait ? Math.PI / 2 - 0.35 : 0.35;
		const pitch = 0.85;
		camera.position.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(120);
		camera.lookAt(0, 0, 0);
		camera.updateMatrixWorld(true);
		aspect = w / h;
		viewW = w;
		viewH = h;
		const fit = extent(fitCorners);
		isle = extent(isleCorners);
		baseHalf = Math.max((fit.maxY - fit.minY) / 2, (fit.maxX - fit.minX) / 2 / aspect) * 1.04;
		kMax = 4;
		if (portrait !== wantPortrait) {
			portrait = wantPortrait;
			view.cx = (fit.minX + fit.maxX) / 2;
			view.cy = (fit.minY + fit.maxY) / 2;
			view.k = 1;
		}
		applyView();
	}

	function resize() {
		const w = canvas.clientWidth || innerWidth;
		const h = canvas.clientHeight || innerHeight;
		const pixel = Math.min(6, Math.max(2, Math.round(Math.max(w, h) / 560)));
		renderer.setPixelRatio(1 / pixel);
		renderer.setSize(w, h, false);
		frame(w, h);
	}
	resize();
	let resizeTimer = 0;
	addEventListener("resize", () => {
		clearTimeout(resizeTimer);
		resizeTimer = window.setTimeout(() => {
			resize();
			if (reduced) draw();
		}, 80);
	});

	const unitsPerPx = () => (2 * baseHalf * view.k) / viewH;
	/** zoom by `factor` (> 1 zooms out) keeping the point under the pointer where it is */
	function zoomAt(clientX: number, clientY: number, factor: number) {
		const nx = (clientX / viewW) * 2 - 1;
		const ny = (clientY / viewH) * 2 - 1;
		const px = view.cx + nx * baseHalf * view.k * aspect;
		const py = view.cy - ny * baseHalf * view.k;
		view.k = clamp(view.k * factor, KMIN, kMax);
		view.cx = px - nx * baseHalf * view.k * aspect;
		view.cy = py + ny * baseHalf * view.k;
	}

	const pointers = new Map<number, { x: number; y: number }>();
	const vel = { x: 0, y: 0 }; // coasting after a flick, camera units per second
	let pinch = 0;
	let lastMove = 0;
	const pinchDistance = () => {
		const [a, b] = [...pointers.values()];
		return Math.hypot(a.x - b.x, a.y - b.y);
	};
	const touched = () => document.documentElement.classList.add("touched");
	const redraw = () => {
		if (reduced) draw();
	};

	canvas.addEventListener("pointerdown", (e) => {
		canvas.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		vel.x = vel.y = 0;
		pinch = pointers.size === 2 ? pinchDistance() : 0;
		canvas.classList.add("drag");
		touched();
	});
	canvas.addEventListener("pointermove", (e) => {
		const p = pointers.get(e.pointerId);
		if (!p) return;
		const dx = e.clientX - p.x;
		const dy = e.clientY - p.y;
		p.x = e.clientX;
		p.y = e.clientY;
		if (pointers.size === 1) {
			const upp = unitsPerPx();
			view.cx -= dx * upp;
			view.cy += dy * upp;
			const now = performance.now();
			const secs = Math.max(0.008, (now - lastMove) / 1000);
			lastMove = now;
			vel.x = vel.x * 0.5 + ((-dx * upp) / secs) * 0.5;
			vel.y = vel.y * 0.5 + ((dy * upp) / secs) * 0.5;
		} else if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			const d = pinchDistance();
			if (pinch > 0 && d > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch / d);
			pinch = d;
		}
		applyView();
		redraw();
	});
	const release = (e: PointerEvent) => {
		pointers.delete(e.pointerId);
		pinch = 0;
		if (pointers.size === 0) {
			canvas.classList.remove("drag");
			if (performance.now() - lastMove > 90) vel.x = vel.y = 0; // held still before letting go: no coasting
		} else {
			vel.x = vel.y = 0;
		}
	};
	canvas.addEventListener("pointerup", release);
	canvas.addEventListener("pointercancel", release);
	canvas.addEventListener(
		"wheel",
		(e) => {
			e.preventDefault();
			zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
			applyView();
			redraw();
			touched();
		},
		{ passive: false },
	);
	const coast = (dt: number) => {
		if (pointers.size > 0 || (Math.abs(vel.x) < 0.05 && Math.abs(vel.y) < 0.05)) return;
		view.cx += vel.x * dt;
		view.cy += vel.y * dt;
		const decay = Math.exp(-4 * dt);
		vel.x *= decay;
		vel.y *= decay;
		applyView();
	};

	const draw = () => {
		updateChunks(reduced ? Infinity : 4);
		traffic.pose();
		cars.pose();
		renderer.render(scene, camera);
	};

	if (import.meta.env.DEV) (window as unknown as { __vlaky: unknown }).__vlaky = { ...traffic, crossings: crossings.crossings, cars, rails, chunks, view, draw, camera, hillHeight, roadAt, isWater, setNight: (on: boolean) => (nightTarget = on ? 1 : 0) };

	// the trains start out mid-journey rather than at a standstill
	for (let i = 0; i < 30 * 12; i++) {
		traffic.simulate(1 / 30);
		cars.simulate(1 / 30);
	}
	updateChunks(Infinity);
	draw();
	canvas.classList.add("on");

	const controller: Vlaky = {
		setNight(on) {
			nightTarget = on ? 1 : 0;
			if (reduced) {
				night = nightTarget;
				applyLight();
				draw();
			}
		},
	};
	if (reduced) return controller;

	let last = performance.now();
	let lastDraw = 0;
	const loop = (now: number) => {
		requestAnimationFrame(loop);
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;
		if (document.hidden || !canvas.clientWidth) return;
		traffic.simulate(dt);
		cars.simulate(dt);
		coast(dt);
		if (night !== nightTarget) {
			night = clamp(night + Math.sign(nightTarget - night) * dt * 2.5, Math.min(night, nightTarget), Math.max(night, nightTarget));
			applyLight();
		}
		if (now - lastDraw < 1000 / 70) return;
		lastDraw = now;
		draw();
	};
	requestAnimationFrame(loop);
	return controller;
}
