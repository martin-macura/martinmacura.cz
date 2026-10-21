// A crossing in Vysočany where two cars did not quite make it: the police are there, their lights going.
import { Color, InstancedMesh, MeshBasicMaterial, Object3D, type Scene } from "three";
import type { RoadNet } from "./praha-roads";
import { type Box, COLORS, meshFromBoxes, unit } from "./util";
import type { Extras, Focus } from "./world";

/** Freyova x U Vysočanského pivovaru (OpenStreetMap node 130488095), in world units */
export const ACCIDENT = { x: 1081.47, z: -394.92, r: 4 };

export function createAccident(scene: Scene, net: RoadNet, groundAt: (x: number, z: number) => number): Extras {
	const { x: ax, z: az } = ACCIDENT;
	// which way the two streets run: the edges that meet at the node of the crossing
	let node = 0;
	let best = Infinity;
	for (let i = 0; i < net.nx.length; i++) {
		const d = (net.nx[i] - ax) ** 2 + (net.nz[i] - az) ** 2;
		if (d < best) {
			best = d;
			node = i;
		}
	}
	const dirs: number[] = [];
	for (let e = 0; e < net.ea.length; e++) {
		const a = net.start[e];
		const b = net.start[e + 1] - 1;
		if (net.ea[e] === node) dirs.push(Math.atan2(net.pz[a + 1] - net.pz[a], net.px[a + 1] - net.px[a]));
		if (net.eb[e] === node) dirs.push(Math.atan2(net.pz[b - 1] - net.pz[b], net.px[b - 1] - net.px[b]));
	}
	const along = dirs[0] ?? 0; // one street
	const across = dirs.find((d) => Math.abs(Math.sin(d - along)) > 0.6) ?? along + Math.PI / 2; // the other one
	const x0 = net.nx[node];
	const z0 = net.nz[node];
	const y = groundAt(x0, z0);
	const at = (dir: number, d: number, side = 0): [number, number] => [x0 + Math.cos(dir) * d - Math.sin(dir) * side, z0 + Math.sin(dir) * d + Math.cos(dir) * side];

	const list: Box[] = [];
	// a car along `dir` at (x, z): a body and a cabin, turned by `twist`
	const car = (x: number, z: number, dir: number, color: number, cabin = 0x1c2232) => {
		const ry = -dir;
		list.push([0.95, 0.26, 0.5, color, x, y + 0.16, z, ry]);
		list.push([0.5, 0.2, 0.42, cabin, x - Math.cos(dir) * 0.05, y + 0.38, z - Math.sin(dir) * 0.05, ry]);
	};
	// the two that met: one in the middle, one turned askew into its side
	car(x0 + Math.cos(along) * 0.2, z0 + Math.sin(along) * 0.2, along + 0.25, COLORS.red);
	const [bx, bz] = at(across, 0.75, 0.15);
	car(bx, bz, across + Math.PI + 0.7, 0xb9b9b9);
	list.push([0.3, 0.06, 0.3, 0x14161c, x0 + 0.5, y + 0.06, z0 - 0.3, 0.4]); // a bit of the bumper
	// the police: white with a blue stripe, on the streets around
	const police: [number, number, number][] = [];
	for (const [dir, d, side] of [
		[along, 3.2, 0.3],
		[along + Math.PI, 3, -0.3],
		[across + Math.PI, 3.4, 0.3],
	] as const) {
		const [px, pz] = at(dir, d, side);
		const heading = dir + Math.PI + 0.15;
		car(px, pz, heading, COLORS.white, 0x2a3a6a);
		list.push([0.97, 0.06, 0.52, 0x2f62c8, px, y + 0.2, pz, -heading]);
		police.push([px, pz, heading]);
	}
	// cones on the corners and two policemen
	for (const [dir, d, side] of [
		[along, 1.6, 0.7],
		[along, 1.6, -0.7],
		[along + Math.PI, 1.6, 0.7],
		[along + Math.PI, 1.6, -0.7],
		[across, 1.8, 0.6],
		[across + Math.PI, 1.6, -0.6],
	] as const) {
		const [cx, cz] = at(dir, d, side);
		list.push([0.16, 0.24, 0.16, 0xff7a1a, cx, y + 0.12, cz, 0]);
		list.push([0.18, 0.05, 0.18, COLORS.white, cx, y + 0.16, cz, 0]);
	}
	for (const [dir, d, side] of [
		[along, 1.9, -0.9],
		[across + Math.PI, 2.1, 0.9],
	] as const) {
		const [px, pz] = at(dir, d, side);
		list.push([0.2, 0.14, 0.14, COLORS.dark, px, y + 0.07, pz, 0]);
		list.push([0.28, 0.34, 0.2, 0x26365e, px, y + 0.31, pz, 0]);
		list.push([0.22, 0.22, 0.22, 0xf1c27d, px, y + 0.59, pz, 0]);
		list.push([0.26, 0.08, 0.26, 0x1b2440, px, y + 0.73, pz, 0]);
		list.push([0.3, 0.05, 0.22, 0xd8ff3a, px, y + 0.36, pz, 0]); // the vest
	}
	const still = meshFromBoxes(list);
	still.userData.dynamic = true;
	still.visible = false;
	scene.add(still);

	// the beacons: a blue and a red light on every roof, taking turns
	const beacons = new InstancedMesh(unit, new MeshBasicMaterial({ color: 0xffffff }), police.length * 2);
	beacons.frustumCulled = false;
	beacons.userData.dynamic = true;
	beacons.visible = false;
	const dummy = new Object3D();
	police.forEach(([px, pz, heading], i) => {
		for (const k of [0, 1]) {
			const side = k ? 0.12 : -0.12;
			dummy.position.set(px - Math.sin(heading) * side, y + 0.53, pz + Math.cos(heading) * side);
			dummy.rotation.set(0, -heading, 0);
			dummy.scale.set(0.16, 0.12, 0.18);
			dummy.updateMatrix();
			beacons.setMatrixAt(i * 2 + k, dummy.matrix);
		}
	});
	scene.add(beacons);
	const blue = new Color(0x2f7bff);
	const red = new Color(0xff2a2a);
	const dim = new Color(0x1b1b2a);

	let focus: Focus | null = null;
	return {
		simulate(_dt, f) {
			focus = f;
		},
		pose() {
			const shown = !!focus && !focus.far && Math.abs(focus.x - x0) < focus.r * 1.3 && Math.abs(focus.z - z0) < focus.r * 1.3;
			still.visible = beacons.visible = shown;
			if (!shown) return;
			const t = performance.now() / 1000;
			police.forEach((_, i) => {
				const on = Math.floor(t * 3 + i * 0.7) % 2;
				beacons.setColorAt(i * 2, on ? blue : dim);
				beacons.setColorAt(i * 2 + 1, on ? dim : red);
			});
			if (beacons.instanceColor) beacons.instanceColor.needsUpdate = true;
		},
	};
}
