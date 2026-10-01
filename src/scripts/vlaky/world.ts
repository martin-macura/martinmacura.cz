// What differs between the towns: the land, the water, the streets and the houses, and where the tracks go.
import type { Mesh } from "three";
import type { Layout } from "./rails";

export interface Chunk {
	main: Mesh;
	lights: Mesh | null;
}

export interface World {
	isleX: number; // half the size of the island
	isleZ: number;
	/** the part the first view shows: its middle and half its size */
	fit: { x: number; z: number; hx: number; hz: number };
	/** where the tracks go; the default layout when absent */
	layout?: Layout;
	/** the colour of the ground between things; grass when absent */
	ground?: number;
	isWater(x: number, z: number): boolean;
	hillHeight(x: number, z: number): number;
	roadAt(x: number, z: number): boolean;
	/** dry land is carved out around [x, z, radius] */
	initWater(carves: [number, number, number][]): void;
	createChunkBuilder(railDist: (x: number, z: number) => number, roadOK: (x: number, z: number) => boolean): (cx: number, cz: number) => Chunk;
}
