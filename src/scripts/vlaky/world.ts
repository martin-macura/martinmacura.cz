// What differs between the towns: the land, the water, the streets and the houses, and where the tracks go.
import type { Mesh, Scene } from "three";
import type { Layout } from "./rails";

export interface Chunk {
	main: Mesh;
	lights: Mesh | null;
}

/** what the view shows: its middle, half its size, and whether it is zoomed out so far that the town is coarse */
export interface Focus {
	x: number;
	z: number;
	r: number;
	far: boolean;
}

/** things a town adds that move: they are told what the view shows */
export interface Extras {
	simulate(dt: number, focus: Focus): void;
	pose(): void;
}

export interface World {
	isleX: number; // half the size of the island
	isleZ: number;
	/** the part the first view shows: its middle and half its size */
	fit: { x: number; z: number; hx: number; hz: number };
	/** how far the view may zoom out, relative to the first view; 4 when absent */
	kMax?: number;
	/** where the tracks go; the default layout when absent */
	layout?: Layout;
	/** the colour of the ground between things; grass when absent */
	ground?: number;
	isWater(x: number, z: number): boolean;
	hillHeight(x: number, z: number): number;
	roadAt(x: number, z: number): boolean;
	/** dry land is carved out around [x, z, radius] */
	initWater(carves: [number, number, number][]): void;
	/** `far` builds the coarse version for zoomed-out views: no windows, lamps or small details */
	createChunkBuilder(railDist: (x: number, z: number) => number, roadOK: (x: number, z: number) => boolean): (cx: number, cz: number, far: boolean) => Chunk;
	/** the traffic of the town, when it has any of its own */
	createExtras?(scene: Scene, railDist: (x: number, z: number) => number, roadOK: (x: number, z: number) => boolean): Extras;
}
