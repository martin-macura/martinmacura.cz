// A rapper on a rooftop in Strašnice (Saratovská 17), with a boombox and the beat going: an easter egg for up close.
import { Color, Group, InstancedMesh, MeshBasicMaterial, MeshLambertMaterial, Object3D, type Scene } from "three";
import { type Box, COLORS, meshFromBoxes, unit } from "./util";
import type { Extras, Focus } from "./world";

/** Saratovská 17 (RÚIAN address point 22614028), Praha-Strašnice */
export const RAPPER = { lat: 50.0745996, lon: 14.4924634 };

/** where the roof is: its top surface, and the way the rapper faces (towards the street) */
export interface Rooftop {
	x: number;
	z: number;
	y: number;
	/** the direction he looks in, as an angle in the world's x/z plane */
	facing: number;
}

const BPM = 92;
/** only up close: from the first view he would be a flicker of a few pixels */
const SEEN_UP_TO = 0.8;
/** he is bigger than life, or he would be a few pixels even at the closest zoom */
const SIZE = 2;
const SKIN = 0xd7a574;
const HOODIE = 0xf08a24;
const JEANS = 0x3a5a9a;
const CAP = 0xd23a2e;
const GOLD = 0xf2c230;

/** a box in the figure's own frame: x is where he looks, z his right, y up from the feet */
const part = (w: number, h: number, d: number, color: number, x: number, y: number, z: number): Box => [w, h, d, color, x, y, z, 0];

export function createRapper(scene: Scene, roof: Rooftop): Extras {
	const root = new Group();
	root.position.set(roof.x, roof.y, roof.z);
	root.rotation.y = -roof.facing;
	root.scale.setScalar(SIZE);
	root.visible = false;
	scene.add(root);
	const hang = (parent: Group, list: Box[]) => {
		const mesh = meshFromBoxes(list);
		parent.add(mesh);
		return mesh;
	};
	const pivot = (parent: Group, x: number, y: number, z: number) => {
		const g = new Group();
		g.position.set(x, y, z);
		parent.add(g);
		return g;
	};

	// legs and shoes stay where they are, the rest of him bobs with the beat
	hang(root, [
		part(0.17, 0.06, 0.11, COLORS.white, 0.02, 0.03, 0.08),
		part(0.17, 0.06, 0.11, COLORS.white, 0.02, 0.03, -0.08),
		part(0.12, 0.3, 0.12, JEANS, 0, 0.21, 0.08),
		part(0.12, 0.3, 0.12, JEANS, 0, 0.21, -0.08),
	]);
	const body = pivot(root, 0, 0.36, 0);
	hang(body, [
		part(0.24, 0.34, 0.34, HOODIE, 0, 0.17, 0),
		part(0.26, 0.05, 0.36, darker(HOODIE, 0.85), 0, 0.02, 0), // the hem of the hoodie
		// the gold chain: a ring around the neck, seen from above, and the pendant on his chest
		part(0.02, 0.02, 0.27, GOLD, 0.12, 0.35, 0),
		part(0.02, 0.02, 0.27, GOLD, -0.12, 0.35, 0),
		part(0.26, 0.02, 0.02, GOLD, 0, 0.35, 0.13),
		part(0.26, 0.02, 0.02, GOLD, 0, 0.35, -0.13),
		part(0.04, 0.09, 0.07, GOLD, 0.125, 0.25, 0),
	]);
	// the head nods: its pivot is the neck
	const head = pivot(body, 0, 0.34, 0);
	hang(head, [
		part(0.2, 0.2, 0.2, SKIN, 0, 0.1, 0),
		part(0.04, 0.05, 0.22, 0x14161c, 0.1, 0.12, 0), // shades
		part(0.22, 0.07, 0.22, CAP, -0.01, 0.23, 0), // a cap, turned back
		part(0.07, 0.025, 0.14, darker(CAP, 0.8), -0.15, 0.2, 0),
	]);
	// the arms: the pivot is the shoulder; a turn about x lifts the hand out to the side, one about z swings it forwards
	const armUp = pivot(body, 0, 0.3, 0.19);
	hang(armUp, [
		part(0.09, 0.3, 0.09, HOODIE, 0, -0.15, 0),
		part(0.08, 0.08, 0.08, SKIN, 0, -0.33, 0),
		part(0.05, 0.12, 0.05, COLORS.dark, 0.02, -0.4, 0), // the microphone
		part(0.08, 0.08, 0.08, 0xb9bec7, 0.02, -0.48, 0),
	]);
	const armDown = pivot(body, 0, 0.3, -0.19);
	hang(armDown, [part(0.09, 0.3, 0.09, HOODIE, 0, -0.15, 0), part(0.08, 0.08, 0.08, SKIN, 0, -0.33, 0)]);

	// the boombox on the roof beside him
	const bx = 0.04;
	const bz = -0.78;
	hang(root, [
		part(0.16, 0.24, 0.5, 0x2b2f3a, bx, 0.12, bz),
		part(0.17, 0.03, 0.51, 0x6b7280, bx, 0.255, bz),
		part(0.04, 0.05, 0.3, 0xb9bec7, bx, 0.3, bz), // the handle
	]);
	const dummy = new Object3D();
	// the speakers pump: a ring and a cone, twice (the colours are set once, below)
	const speakers = new InstancedMesh(unit, new MeshLambertMaterial({ color: 0xffffff }), 4);
	speakers.frustumCulled = false;
	root.add(speakers);
	const coneAt = (i: number, pulse: number) => {
		const side = i ? 1 : -1;
		dummy.position.set(bx + 0.09, 0.13, bz + side * 0.13);
		dummy.scale.set(0.02, 0.15, 0.15);
		dummy.updateMatrix();
		speakers.setMatrixAt(i * 2, dummy.matrix);
		dummy.position.set(bx + 0.1 + pulse * 0.012, 0.13, bz + side * 0.13);
		dummy.scale.set(0.02 + pulse * 0.02, 0.1 + pulse * 0.04, 0.1 + pulse * 0.04);
		dummy.updateMatrix();
		speakers.setMatrixAt(i * 2 + 1, dummy.matrix);
	};
	for (let i = 0; i < 4; i++) speakers.setColorAt(i, new Color(i % 2 ? 0x14161c : 0x8f9aa8));
	// the levels on top of the boombox, going up and down
	const bars = new InstancedMesh(unit, new MeshBasicMaterial({ color: 0xffffff }), 5);
	bars.frustumCulled = false;
	root.add(bars);
	[0x2fd487, 0x2fd487, 0xffcf33, 0xffcf33, 0xff5c4d].forEach((c, i) => bars.setColorAt(i, new Color(c)));
	// notes drifting up from the speakers
	const notes = new InstancedMesh(unit, new MeshBasicMaterial({ color: 0xffffff }), 6);
	notes.frustumCulled = false;
	root.add(notes);
	for (let i = 0; i < 6; i++) notes.setColorAt(i, new Color([0xff7ab8, 0x3dd6ff, 0xffcf33][i >> 1]));

	let focus: Focus | null = null;
	return {
		simulate(_dt, f) {
			focus = f;
		},
		pose() {
			// the view's middle is on the ground, the roof stands up to the side of it by about as much as it is high
			const reach = focus ? focus.r * 1.3 + roof.y : 0;
			const shown = !!focus && focus.k < SEEN_UP_TO && Math.abs(focus.x - roof.x) < reach && Math.abs(focus.z - roof.z) < reach;
			root.visible = shown;
			if (!shown) return;
			const beat = (performance.now() / 1000) * (BPM / 60);
			const kick = Math.exp(-(beat % 1) * 5); // 1 on the beat, dying away
			body.position.y = 0.36 - 0.03 * (1 - kick); // he sinks between the beats and comes up on them
			body.rotation.x = Math.sin(beat * Math.PI) * 0.06; // sways side to side
			head.rotation.z = -0.1 * Math.sin(beat * Math.PI * 2) - 0.05;
			// both hands in the air, the one with the microphone and the free one, pumping in turns
			armUp.rotation.x = -2.35 - 0.25 * Math.sin(beat * Math.PI);
			armUp.rotation.z = 0.15;
			armDown.rotation.x = 2.35 - 0.25 * Math.sin(beat * Math.PI);
			armDown.rotation.z = 0.15;
			coneAt(0, kick);
			coneAt(1, kick);
			speakers.instanceMatrix.needsUpdate = true;
			for (let i = 0; i < 5; i++) {
				const level = 0.02 + 0.07 * (0.5 + 0.5 * Math.sin(beat * 6.3 + i * 1.9)) * (0.4 + 0.6 * kick);
				dummy.position.set(bx + 0.02, 0.27 + level / 2, bz - 0.1 + i * 0.05);
				dummy.scale.set(0.03, level, 0.03);
				dummy.updateMatrix();
				bars.setMatrixAt(i, dummy.matrix);
			}
			bars.instanceMatrix.needsUpdate = true;
			for (let n = 0; n < 3; n++) {
				const t = (beat / 4 + n / 3) % 1; // three notes at a time, each drifting up for four beats
				const s = Math.min(1, (1 - t) * 4) * Math.min(1, t * 8); // grows out of the speaker and shrinks away at the top
				const x = bx + 0.15 + t * 0.35;
				const y = 0.4 + t * 0.9;
				const z = bz + Math.sin(t * 9 + n * 2.1) * 0.12;
				dummy.position.set(x, y + 0.04 * s, z);
				dummy.scale.set(0.025 * s, 0.1 * s, 0.025 * s); // the stem
				dummy.updateMatrix();
				notes.setMatrixAt(n * 2, dummy.matrix);
				dummy.position.set(x - 0.03 * s, y - 0.01 * s, z);
				dummy.scale.set(0.07 * s, 0.045 * s, 0.05 * s); // the head
				dummy.updateMatrix();
				notes.setMatrixAt(n * 2 + 1, dummy.matrix);
			}
			notes.instanceMatrix.needsUpdate = true;
		},
	};
}

function darker(color: number, f: number) {
	return (Math.round(((color >> 16) & 255) * f) << 16) | (Math.round(((color >> 8) & 255) * f) << 8) | Math.round((color & 255) * f);
}
