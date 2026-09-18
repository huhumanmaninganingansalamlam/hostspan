import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import png2icons from "png2icons";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brandDir = resolve(root, "assets", "brand");
const outputDir = resolve(root, "assets", "icons");
const appSvg = await readFile(resolve(brandDir, "hostspan.svg"));
const traySvg = await readFile(resolve(brandDir, "hostspan-tray.svg"));

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

await sharp(appSvg).resize(32, 32).png().toFile(resolve(outputDir, "tray.png"));
await sharp(appSvg).resize(64, 64).png().toFile(resolve(outputDir, "tray@2x.png"));
await sharp(traySvg).resize(16, 16).png().toFile(resolve(outputDir, "hostspanTemplate.png"));
await sharp(traySvg).resize(32, 32).png().toFile(resolve(outputDir, "hostspanTemplate@2x.png"));

console.log(`Generated HostSpan icons in ${outputDir}`);
