import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import png2icons from "png2icons";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brandDir = resolve(root, "assets", "brand");
const outputDir = resolve(root, "assets", "icons");
const markSvg = await readFile(resolve(brandDir, "hostspan-mark.svg"), "utf8");
const appSvg = Buffer.from(markSvg.replace("<path", '<rect x="2" y="2" width="60" height="60" rx="14" fill="#2558D9"/><path'));
const traySvg = markSvg.replace('viewBox="0 0 64 64"', 'viewBox="8 8 48 48"');
// These checked-in previews are derived; edit only hostspan-mark.svg.
await writeFile(resolve(brandDir, "hostspan.svg"), appSvg);
await writeFile(resolve(brandDir, "hostspan-tray.svg"), traySvg.replace("#FFFFFF", "#000000"));

await mkdir(outputDir, { recursive: true });

const appPng = await sharp(appSvg).resize(1024, 1024).png().toBuffer();
await writeFile(resolve(outputDir, "app.png"), appPng);

for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
  await sharp(appSvg).resize(size, size).png().toFile(resolve(outputDir, `app-${size}.png`));
}

const ico = png2icons.createICO(appPng, png2icons.BICUBIC2, 0, true, true);
const icns = png2icons.createICNS(appPng, png2icons.BICUBIC2, 0);
if (!ico || !icns) throw new Error("Failed to generate native application icons.");
await writeFile(resolve(outputDir, "app.ico"), ico);
await writeFile(resolve(outputDir, "app.icns"), icns);

for (const [name, svg, size] of [
  ["tray", appSvg, 32], // Linux panel tint is not exposed by Electron: use the blue app tile.
  ["tray-on-light", Buffer.from(traySvg.replace("#FFFFFF", "#151C2A")), 32],
  ["tray-on-dark", Buffer.from(traySvg), 32],
  ["hostspanTemplate", Buffer.from(traySvg.replace("#FFFFFF", "#000000")), 16],
]) {
  await sharp(svg).resize(size, size).png().toFile(resolve(outputDir, `${name}.png`));
  await sharp(svg).resize(size * 2, size * 2).png().toFile(resolve(outputDir, `${name}@2x.png`));
}

console.log(`Generated HostSpan icons in ${outputDir}`);
