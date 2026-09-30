// Draws the whole favicon set into public/ from the pixel art below. No dependencies: every size is drawn straight
// from the grid at a whole-number scale (nothing is resampled), so the pixels stay square and sharp at any size.
// Run it with `npm run favicons` and commit the result.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const PAPER = "#0c0c0c"; // --paper in src/pages/index.astro; also the theme-color and the manifest colours
const INK = "#f2f2f2"; // --ink

// The "M" of Press Start 2P, the font of the page: one character per font pixel.
const M = ["##...##", "###.###", "#######", "##.#.##", "##.#.##", "##...##", "##...##"];
const K = 2; // grid cells per font pixel, so the M is 14 cells wide

/** Ink rectangles [x, y, w, h] of the M centred in a `size` x `size` grid. */
const mark = (size) => {
	const at = (size - M[0].length * K) / 2;
	return M.flatMap((row, y) =>
		[...row.matchAll(/#+/g)].map((run) => [at + run.index * K, at + y * K, run[0].length * K, K]),
	);
};

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** RGBA pixels of the mark on a `size` grid, every cell `scale` pixels wide, with `pad` pixels of paper around. */
const paint = (size, scale, pad = 0) => {
	const px = size * scale + pad * 2;
	const rgba = Buffer.alloc(px * px * 4);
	for (let i = 0; i < px * px; i++) rgba.set([...rgb(PAPER), 255], i * 4);
	for (const [x, y, w, h] of mark(size)) {
		for (let row = pad + y * scale; row < pad + (y + h) * scale; row++) {
			for (let col = pad + x * scale; col < pad + (x + w) * scale; col++) {
				rgba.set([...rgb(INK), 255], (row * px + col) * 4);
			}
		}
	}
	return { px, rgba };
};

const chunk = (type, data) => {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length);
	head.write(type, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
	return Buffer.concat([head, data, crc]);
};

const png = ({ px, rgba }) => {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(px, 0);
	ihdr.writeUInt32BE(px, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	const stride = px * 4;
	const rows = Buffer.alloc((stride + 1) * px); // every row starts with filter type 0 (none)
	for (let y = 0; y < px; y++) rgba.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(rows, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
};

/** An .ico that holds ready-made PNGs, which every browser reads. */
const ico = (images) => {
	const head = Buffer.alloc(6);
	head.writeUInt16LE(1, 2); // type: icon
	head.writeUInt16LE(images.length, 4);
	let offset = head.length + 16 * images.length;
	const entries = images.map(({ px, data }) => {
		const entry = Buffer.alloc(16);
		entry[0] = px;
		entry[1] = px;
		entry.writeUInt16LE(1, 4); // colour planes
		entry.writeUInt16LE(32, 6); // bits per pixel
		entry.writeUInt32LE(data.length, 8);
		entry.writeUInt32LE(offset, 12);
		offset += data.length;
		return entry;
	});
	return Buffer.concat([head, ...entries, ...images.map((image) => image.data)]);
};

const dir = fileURLToPath(new URL("../public/", import.meta.url));
const write = (name, data) => {
	writeFileSync(dir + name, data);
	console.log(name.padEnd(24), `${data.length} B`);
};

// The tab icon is a 16 x 16 grid, so 16, 32 and 48 px are 1x, 2x and 3x with no smearing.
const tile = (scale, pad) => png(paint(16, scale, pad));
// Maskable icons get cropped to a shape by the OS; the M sits in the middle of a bigger grid to stay inside the safe zone.
const safe = (scale) => png(paint(32, scale));

const path = mark(16)
	.map(([x, y, w, h]) => `M${x} ${y}h${w}v${h}h${-w}z`)
	.join("");
write(
	"favicon.svg",
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">\n\t<rect width="16" height="16" fill="${PAPER}" />\n\t<path fill="${INK}" d="${path}" />\n</svg>\n`,
);
write(
	"favicon.ico",
	ico([1, 2, 3].map((scale) => ({ px: 16 * scale, data: tile(scale) }))),
);
write("favicon-16x16.png", tile(1));
write("favicon-32x32.png", tile(2));
write("apple-touch-icon.png", tile(10, 10)); // 180 px; iOS rounds the corners itself, so the M keeps clear of them
write("icon-192.png", tile(12));
write("icon-512.png", tile(32));
write("icon-maskable-192.png", safe(6));
write("icon-maskable-512.png", safe(16));

const icon = (src, size, purpose) => ({ src, sizes: `${size}x${size}`, type: "image/png", ...(purpose && { purpose }) });
write(
	"site.webmanifest",
	`${JSON.stringify(
		{
			name: "Martin Macura",
			start_url: "/",
			display: "browser", // a page, not an app: no install prompt
			background_color: PAPER,
			theme_color: PAPER,
			icons: [
				icon("/icon-192.png", 192),
				icon("/icon-512.png", 512),
				icon("/icon-maskable-192.png", 192, "maskable"),
				icon("/icon-maskable-512.png", 512, "maskable"),
			],
		},
		null,
		"\t",
	)}\n`,
);
