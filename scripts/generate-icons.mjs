#!/usr/bin/env node

/**
 * Generate favicon and app icon PNGs from the Conduit "C vertical bars" design.
 *
 * Design: 4 horizontal bands of 10 vertical bars forming a "C" shape.
 *   - Band 0: cyan, full width  (top cap)
 *   - Band 1: cyan, short arm   (opening)
 *   - Band 2: pink, short arm   (opening)
 *   - Band 3: pink, full width  (bottom cap)
 *
 * Usage: node scripts/generate-icons.mjs
 */

import { writeFileSync } from "fs";
import { join } from "path";
import sharp from "sharp";

const PINK = { r: 255, g: 45, b: 123 };
const CYAN = { r: 0, g: 229, b: 255 };

const OUTPUTS = [
	{ name: "favicon-96x96.png", size: 96 },
	{ name: "apple-touch-icon.png", size: 180 },
	{ name: "web-app-manifest-192x192.png", size: 192 },
	{ name: "web-app-manifest-512x512.png", size: 512 },
];

const STATIC_DIR = join(
	import.meta.dirname,
	"..",
	"src",
	"lib",
	"frontend",
	"static",
);

function generateSVG(size) {
	const hRows = 4;
	const fullTop = 1;
	const fullBottom = 1;
	const armWidth = 0.42;
	const vBars = 10;
	const barFill = 0.5;

	const padding = size * 0.08;
	const hGap = Math.max(0.5, size * 0.025);
	const totalHGap = hGap * (hRows - 1);
	const availH = size - padding * 2 - totalHGap;
	const bandH = availH / hRows;
	const fullW = size - padding * 2;
	const barR = Math.max(0.3, Math.min(size * 0.012, 2));
	const cyanRows = hRows / 2;

	const rects = [];

	for (let band = 0; band < hRows; band++) {
		const by = padding + band * (bandH + hGap);
		const isFull = band < fullTop || band >= hRows - fullBottom;
		const bandW = isFull ? fullW : fullW * armWidth;
		const color = band < cyanRows ? CYAN : PINK;
		const hex = `rgb(${color.r},${color.g},${color.b})`;

		const barsInBand = isFull
			? vBars
			: Math.max(2, Math.round(vBars * armWidth));
		const slotW = bandW / barsInBand;
		const bw = slotW * barFill;

		for (let i = 0; i < barsInBand; i++) {
			const bx = padding + i * slotW;
			if (bx + bw > padding + bandW + 0.5) continue;

			rects.push(
				`<rect x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${bw.toFixed(2)}" height="${bandH.toFixed(2)}" rx="${barR.toFixed(2)}" fill="${hex}"/>`,
			);
		}
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rects.join("")}</svg>`;
}

async function main() {
	console.log("Generating Conduit icons...\n");

	// Generate SVG favicon (for modern browsers)
	const svgFavicon = generateSVG(32);
	const svgPath = join(STATIC_DIR, "favicon.svg");
	writeFileSync(svgPath, svgFavicon);
	console.log(`  ✓ favicon.svg`);

	// Generate PNGs at each size
	for (const { name, size } of OUTPUTS) {
		const svg = generateSVG(size);
		const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
		writeFileSync(join(STATIC_DIR, name), pngBuffer);
		console.log(`  ✓ ${name} (${size}×${size})`);
	}

	// Generate ICO (contains 16, 32, 48)
	// ICO format: header + entries + PNG data
	const icoSizes = [16, 32, 48];
	const pngBuffers = [];
	for (const s of icoSizes) {
		const svg = generateSVG(s);
		const png = await sharp(Buffer.from(svg)).png().toBuffer();
		pngBuffers.push(png);
	}

	const icoBuffer = createICO(pngBuffers, icoSizes);
	writeFileSync(join(STATIC_DIR, "favicon.ico"), icoBuffer);
	console.log(`  ✓ favicon.ico (${icoSizes.join(", ")}px)`);

	console.log("\nDone! All icons written to src/lib/frontend/static/");
}

/**
 * Create a minimal ICO file from PNG buffers.
 * ICO format: 6-byte header + 16-byte entry per image + raw PNG data.
 */
function createICO(pngBuffers, sizes) {
	const numImages = pngBuffers.length;
	const headerSize = 6;
	const entrySize = 16;
	const dataOffset = headerSize + entrySize * numImages;

	let totalSize = dataOffset;
	for (const buf of pngBuffers) totalSize += buf.length;

	const ico = Buffer.alloc(totalSize);

	// ICO header
	ico.writeUInt16LE(0, 0); // reserved
	ico.writeUInt16LE(1, 2); // type: 1 = ICO
	ico.writeUInt16LE(numImages, 4); // count

	let offset = dataOffset;
	for (let i = 0; i < numImages; i++) {
		const entryOffset = headerSize + i * entrySize;
		const s = sizes[i] >= 256 ? 0 : sizes[i];

		ico.writeUInt8(s, entryOffset); // width
		ico.writeUInt8(s, entryOffset + 1); // height
		ico.writeUInt8(0, entryOffset + 2); // color palette
		ico.writeUInt8(0, entryOffset + 3); // reserved
		ico.writeUInt16LE(1, entryOffset + 4); // color planes
		ico.writeUInt16LE(32, entryOffset + 6); // bits per pixel
		ico.writeUInt32LE(pngBuffers[i].length, entryOffset + 8); // size
		ico.writeUInt32LE(offset, entryOffset + 12); // offset

		pngBuffers[i].copy(ico, offset);
		offset += pngBuffers[i].length;
	}

	return ico;
}

main().catch((err) => {
	console.error("Error generating icons:", err);
	process.exit(1);
});
