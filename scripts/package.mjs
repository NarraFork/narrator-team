/**
 * package.mjs — build the installable .zip for the narrator-team plugin.
 *
 * Usage: bun scripts/package.mjs [outdir]
 * Default outdir: ~/.narrafork/plugin-imports/ (the host's plugin import root,
 * surfaced by GET /api/plugins/install/sources).
 *
 * The archive contains only relative paths rooted at the plugin directory, with
 * the `tests/` folder excluded — matches what the host package store expects.
 */

import { createWriteStream, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// archiver is resolved from the narrafork checkout (it is a host dependency);
// keep it as a dynamic import so this script stays self-contained otherwise.
const ARCHIVER_PATHS = [
	"../../../narrafork/node_modules/archiver/index.js",
	"../../../narrafork/node_modules/archiver",
];
async function loadArchiver() {
	for (const candidate of ARCHIVER_PATHS) {
		try {
			return await import(resolve(import.meta.dir, candidate));
		} catch {
			// try the next candidate
		}
	}
	throw new Error(
		"archiver not found; run this script from a checkout that has narrafork/node_modules installed",
	);
}

const ROOT = resolve(import.meta.dir, "..");
const VERSION = "0.1.45";

const files = [];
(function walk(dir) {
	for (const name of readdirSync(dir)) {
		if (name === "tests" || name === "scripts" || name === ".git") continue;
		const absolute = join(dir, name);
		const relative = absolute.slice(ROOT.length + 1).replaceAll("\\", "/");
		if (statSync(absolute).isDirectory()) {
			walk(absolute);
		} else {
			files.push(relative);
		}
	}
})(ROOT);
files.sort();

const outDir = resolve(process.argv[2] ?? join(homedir(), ".narrafork", "plugin-imports"));
mkdirSync(outDir, { recursive: true });
const destination = join(outDir, `narrator-team-${VERSION}.zip`);

const archiverModule = await loadArchiver();
const createArchive = archiverModule.default ?? archiverModule;
const archive = createArchive("zip", { zlib: { level: 9 } });
const output = createWriteStream(destination);
await new Promise((resolvePromise, reject) => {
	output.on("close", resolvePromise);
	output.on("error", reject);
	archive.on("error", reject);
	archive.pipe(output);
	for (const file of files) {
		archive.file(join(ROOT, file), { name: file });
	}
	archive.finalize();
});

console.log(`Packaged ${files.length} files -> ${destination}`);
console.log(files.join("\n"));
