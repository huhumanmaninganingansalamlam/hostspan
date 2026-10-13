import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../dist/src/computer/", import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(new URL("../src/computer/portal-worker.py", import.meta.url), new URL("portal-worker.py", destination));
