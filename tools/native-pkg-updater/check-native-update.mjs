import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import titles from "../../server/shared/native-titles.json" with { type: "json" };
const [packageArg, baseVersion, deltaArg, ...options] = process.argv.slice(2);
let titleId, iconArg;
for (let i = 0; i < options.length; i++) {
  const name = options[i],
    value = options[++i];
  if (!value || value.startsWith("--")) throw Error(`Missing ${name}`);
  if (name === "--title-id" && !titleId) titleId = value;
  else if (name === "--icon" && !iconArg) iconArg = value;
  else throw Error("Unknown or duplicate native update option");
}
if (
  !packageArg ||
  !/^\d{2}\.\d{3}\.\d{3}$/.test(baseVersion ?? "") ||
  !deltaArg ||
  !titleId ||
  !iconArg ||
  !Object.hasOwn(titles, titleId)
) {
  throw Error(
    "Usage: check-native-update <remastered.pkg> <base-content-version> <delta.pkg> " +
      "--title-id <registered-title> --icon <png>",
  );
}

const toolDirectory = path.dirname(fileURLToPath(import.meta.url)),
  serverDirectory = path.resolve(toolDirectory, "../../server");
const worker = path.join(
  serverDirectory,
  "worker",
  "bin",
  "Release",
  "net10.0",
  "PS5Library.Worker.dll",
);
const scratch = await mkdtemp(path.join(tmpdir(), "ps5library-native-update-"));
const run = promisify(execFile);
const safeName = (value) =>
    value
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 80) || "Unknown",
  gameFolder = `${safeName(titles[titleId].name)} [${safeName(titleId)}]`;
try {
  if (
    !(await stat(worker).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }))
  )
    await run("dotnet", ["build", "worker/PS5Library.Worker.csproj", "-c", "Release", "--nologo"], {
      cwd: serverDirectory,
      maxBuffer: 4 * 1024 * 1024,
    });
  const { stdout } = await run(
    process.execPath,
    [
      path.join(toolDirectory, "publish-native-update.mjs"),
      path.resolve(packageArg),
      baseVersion,
      path.resolve(deltaArg),
      "--title-id",
      titleId,
      "--icon",
      path.resolve(iconArg),
    ],
    {
      cwd: serverDirectory,
      env: { ...process.env, DATA_DIR: scratch, PS5LIBRARY_WORKER_DLL: worker },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  const latest = JSON.parse(
    await readFile(path.join(scratch, "native-updates", gameFolder, "latest.json"), "utf8"),
  );
  const immutable = JSON.parse(
    await readFile(
      path.join(scratch, "native-updates", gameFolder, "releases", `${latest.revision}.json`),
      "utf8",
    ),
  );
  assert.equal(result.published, true);
  assert.equal(latest.baseContentVersion, baseVersion);
  assert.equal(latest.contentVersion, result.contentVersion);
  assert.equal(latest.package.size % 0x10000, 0);
  assert.equal(latest.delta.size, (await stat(path.resolve(deltaArg))).size);
  assert.deepEqual(immutable, latest);
  console.log(
    JSON.stringify({
      passed: true,
      contentVersion: result.contentVersion,
      packageSize: latest.package.size,
      deltaSize: latest.delta.size,
    }),
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
