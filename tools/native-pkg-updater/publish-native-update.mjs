import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import titles from "../../server/shared/native-titles.json" with { type: "json" };
import { pruneSupersededNativeUpdateAssets } from "./native-update-retention.mjs";
const [packageArg, baseContentVersion, deltaArg, ...options] = process.argv.slice(2);
let repair = false,
  titleId,
  iconArg;
for (let i = 0; i < options.length; i++) {
  if (options[i] === "--repair" && !repair) repair = true;
  else if (options[i] === "--title-id" && !titleId) {
    titleId = options[++i];
    if (!titleId || titleId.startsWith("--")) throw Error("Missing --title-id");
  } else if (options[i] === "--icon" && !iconArg) {
    iconArg = options[++i];
    if (!iconArg || iconArg.startsWith("--")) throw Error("Missing --icon");
  } else throw Error("Unknown or duplicate native update option");
}
if (!titleId) throw Error("Missing --title-id");
if (!iconArg) throw Error("Missing --icon");
if (!Object.hasOwn(titles, titleId)) throw Error("Native updates require a registered title");
const { contentId, name } = titles[titleId],
  safeName = (value) =>
    value
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 80) || "Unknown",
  gameFolder = `${safeName(name)} [${safeName(titleId)}]`;
if (!packageArg || !/^\d{2}\.\d{3}\.\d{3}$/.test(baseContentVersion ?? "") || !deltaArg) {
  throw Error(
    "Usage: publish-native-update <remastered.pkg> <base-content-version> <delta.pkg> " +
      "--title-id <registered-title> --icon <png> [--repair]",
  );
}
const toolDirectory = path.dirname(fileURLToPath(import.meta.url)),
  serverDirectory = path.resolve(toolDirectory, "../../server");
const packageFile = path.resolve(packageArg);
const deltaFile = path.resolve(deltaArg);
const worker = path.resolve(
  serverDirectory,
  process.env.PS5LIBRARY_WORKER_DLL ?? "worker/bin/Release/net10.0/PS5Library.Worker.dll",
);
const data = path.resolve(serverDirectory, process.env.DATA_DIR ?? "data"),
  releaseRoot = path.join(data, "native-updates", gameFolder);
const iconSource = path.resolve(iconArg);
const regular = async (file) => {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw Error(`Expected a regular file: ${file}`);
  return info;
};
const sourceInfo = await regular(packageFile);
const deltaInfo = await regular(deltaFile);
if (!sourceInfo.size) throw Error("Package must be non-empty");
if (!deltaInfo.size) throw Error("Delta package must be non-empty");
const delta = await open(deltaFile, "r");
try {
  const header = Buffer.alloc(0x80);
  if (
    (await delta.read(header, 0, header.length, 0)).bytesRead !== header.length ||
    !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x43, 0x4e, 0x54])) ||
    header.readUInt32BE(0x10) !== 8 ||
    header.readUInt16BE(0x14) !== 6 ||
    header.subarray(0x40, 0x64).toString("ascii").replace(/\0.*$/, "") !== contentId ||
    header.readUInt32BE(0x74) !== 0x23
  )
    throw Error("Delta package is not a PS5 delta-distribution container");
  const end = header.readBigUInt64BE(0x20) + header.readBigUInt64BE(0x28),
    rlc = Buffer.alloc(4);
  if (
    end > BigInt(deltaInfo.size - 4) ||
    end > BigInt(Number.MAX_SAFE_INTEGER) ||
    (await delta.read(rlc, 0, 4, Number(end))).bytesRead !== 4 ||
    !rlc.equals(Buffer.from([0x7f, 0x52, 0x4c, 0x43]))
  )
    throw Error("Delta package has no RLC distribution stream");
} finally {
  await delta.close();
}
const releases = path.join(releaseRoot, "releases");
await mkdir(releases, { recursive: true });
const latest = path.join(releaseRoot, "latest.json");
const advertised = await readFile(latest, "utf8")
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
const quarantined =
  !advertised &&
  (await readdir(releaseRoot, { withFileTypes: true })).some(
    (entry) => entry.isFile() && /^latest\.quarantined-.+\.json$/.test(entry.name),
  );
if (quarantined && repair)
  throw Error(
    "--repair cannot reactivate a quarantined native update; publish a newer contentVersion",
  );
const source = await open(packageFile, "r");
let packageSize, packageDigest;
try {
  const header = Buffer.alloc(0x60);
  if (
    (await source.read(header, 0, header.length, 0)).bytesRead !== header.length ||
    !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x46, 0x49, 0x48]))
  )
    throw Error("Native update must be a finalized FIH package");
  const cntOffset = header.readBigUInt64LE(0x58),
    geometry = Buffer.alloc(0xc0);
  if (
    cntOffset > BigInt(Number.MAX_SAFE_INTEGER) ||
    (await source.read(geometry, 0, geometry.length, Number(cntOffset) + 0x400)).bytesRead !==
      geometry.length
  )
    throw Error("Native update has invalid CNT geometry");
  const declared = geometry.readBigUInt64BE(0x30),
    cntRegionOffset = geometry.readBigUInt64BE(0xb0),
    cntRegionSize = geometry.readBigUInt64BE(0xb8);
  if (
    declared !== cntRegionOffset + cntRegionSize ||
    cntRegionOffset !== cntOffset ||
    declared > BigInt(sourceInfo.size) ||
    declared > BigInt(Number.MAX_SAFE_INTEGER) ||
    declared % 0x10000n
  )
    throw Error("Native update has invalid distributable package geometry");
  const internalDigest = Buffer.alloc(32);
  if (
    (await source.read(internalDigest, 0, internalDigest.length, Number(cntOffset) + 0xfe0))
      .bytesRead !== internalDigest.length ||
    internalDigest.every((byte) => byte === 0)
  )
    throw Error("Native update has no internal package digest");
  packageSize = Number(declared);
  packageDigest = internalDigest.toString("hex");
} finally {
  await source.close();
}
const hashes = async (file, length) => {
  const sha256 = createHash("sha256"),
    sha1 = createHash("sha1");
  for await (const chunk of createReadStream(
    file,
    length === undefined ? {} : { start: 0, end: length - 1 },
  )) {
    sha256.update(chunk);
    sha1.update(chunk);
  }
  return { sha256: sha256.digest("hex"), sha1: sha1.digest("hex") };
};
const packageHashes = await hashes(packageFile, packageSize),
  publishedPackage = path.join(
    releaseRoot,
    `${gameFolder} - Full Update - ${packageHashes.sha256.slice(0, 12)}.pkg`,
  );
const deltaHashes = await hashes(deltaFile),
  publishedDelta = path.join(
    releaseRoot,
    `${gameFolder} - Delta Update - ${deltaHashes.sha256.slice(0, 12)}.pkg`,
  );
const publish = async (source, destination, expected, finalSize) => {
  const existing = await lstat(destination).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      (await hashes(destination)).sha256 !== expected
    )
      throw Error(`Immutable update file conflicts: ${destination}`);
    return;
  }
  const temporary = `${destination}.${process.pid}.part`;
  await copyFile(source, temporary);
  if (finalSize !== undefined) await truncate(temporary, finalSize);
  if ((await hashes(temporary)).sha256 !== expected)
    throw Error("Copied update failed hash verification");
  await rename(temporary, destination);
};
const replace = async (bytes, destination, expected) => {
  const existing = await lstat(destination).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw Error(`Expected a regular file: ${destination}`);
  if (existing && (await hashes(destination)).sha256 === expected) return;
  const temporary = `${destination}.${randomUUID()}.part`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    if ((await hashes(temporary)).sha256 !== expected)
      throw Error("Copied update icon failed hash verification");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
};
const iconInfo = await regular(iconSource),
  iconBytes = await readFile(iconSource);
if (
  iconInfo.size < 8 ||
  iconInfo.size > 2 * 1024 * 1024 ||
  !iconBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
)
  throw Error("Native update icon must be a PNG smaller than 2 MiB");
await publish(packageFile, publishedPackage, packageHashes.sha256, packageSize);
await publish(deltaFile, publishedDelta, deltaHashes.sha256);
const { stdout } = await promisify(execFile)("dotnet", [worker, "inspect", publishedPackage], {
  maxBuffer: 1024 * 1024,
});
const inspection = JSON.parse(stdout),
  identity = inspection.identity;
if (
  inspection.format !== "pkg" ||
  inspection.kind !== "UPDATE" ||
  inspection.structurallyRecognized !== true ||
  inspection.metadataVerified !== true ||
  identity?.titleId !== titleId ||
  identity?.contentId !== contentId ||
  !/^\d{2}\.\d{3}\.\d{3}$/.test(identity?.version ?? "") ||
  identity.version <= baseContentVersion
)
  throw Error(`Package is not a verified newer ${titleId} PATCH`);
const crcFile = path.join(releaseRoot, `.package-chunk-${process.pid}.crc`);
await rm(crcFile, { force: true });
await promisify(execFile)("dotnet", [worker, "package-chunk-crc", publishedPackage, crcFile], {
  maxBuffer: 1024 * 1024,
});
const crcInfo = await regular(crcFile);
if (crcInfo.size !== (packageSize / 0x10000) * 4)
  throw Error("Generated package CRC does not cover every 64-KiB block");
const crcHashes = await hashes(crcFile),
  publishedCrc = path.join(
    releaseRoot,
    `${gameFolder} - PlayGo CRC - ${crcHashes.sha256.slice(0, 12)}.crc`,
  );
await publish(crcFile, publishedCrc, crcHashes.sha256);
const historicalRevision = Math.max(
  0,
  ...(await readdir(releases))
    .map((name) => /^([1-9]\d*)\.json$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number),
);
const historical = historicalRevision
  ? JSON.parse(await readFile(path.join(releases, `${historicalRevision}.json`), "utf8"))
  : null;
const previous =
  !advertised || historical?.revision > advertised.revision ? historical : advertised;
if (quarantined && previous && identity.version === previous.contentVersion)
  throw Error(
    "Quarantined native update contentVersion cannot be republished; build a newer contentVersion",
  );
const alignmentRepair =
  !quarantined &&
  previous &&
  identity.version === previous.contentVersion &&
  previous.package?.size % 0x10000 !== 0;
const explicitRepair =
  repair &&
  previous &&
  identity.version === previous.contentVersion &&
  baseContentVersion === previous.baseContentVersion;
if (repair && !explicitRepair)
  throw Error(
    "--repair requires the same contentVersion and baseContentVersion as the published release",
  );
if (
  previous &&
  (identity.version < previous.contentVersion ||
    (identity.version === previous.contentVersion &&
      packageHashes.sha256 !== previous.package.sha256 &&
      !alignmentRepair &&
      !explicitRepair))
)
  throw Error("Native update contentVersion must increase");
if (
  previous &&
  identity.version === previous.contentVersion &&
  packageHashes.sha256 === previous.package.sha256 &&
  packageDigest === previous.package.digest &&
  crcHashes.sha256 === previous.playgo.sha256 &&
  deltaHashes.sha256 === previous.delta?.sha256
)
  throw Error("Native update is already published");
const firmware = /^(\d{1,2})\.(\d{2})$/.exec(identity.minimumFirmware ?? "0.00");
if (!firmware) throw Error("Invalid package minimum firmware");
const metadata = {
  schemaVersion: 1,
  titleId: identity.titleId,
  contentId: identity.contentId,
  contentVersion: identity.version,
  baseContentVersion,
  revision: (previous?.revision ?? 0) + 1,
  systemVersion: Number.parseInt(`${firmware[1].padStart(2, "0")}${firmware[2]}0000`, 16),
  package: { size: packageSize, ...packageHashes, digest: packageDigest },
  playgo: { size: crcInfo.size, sha256: crcHashes.sha256 },
  delta: { size: deltaInfo.size, sha256: deltaHashes.sha256 },
};
const releaseFile = path.join(releases, `${metadata.revision}.json`);
if (
  await lstat(releaseFile).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  })
)
  throw Error(`Immutable native release already exists: ${metadata.revision}`);
await replace(
  iconBytes,
  path.join(releaseRoot, "icon.png"),
  createHash("sha256").update(iconBytes).digest("hex"),
);
await writeFile(`${releaseFile}.${process.pid}.part`, JSON.stringify(metadata), {
  flag: "wx",
  mode: 0o600,
});
await rename(`${releaseFile}.${process.pid}.part`, releaseFile);
await writeFile(`${latest}.${process.pid}.part`, JSON.stringify(metadata), {
  flag: "wx",
  mode: 0o600,
});
await rename(`${latest}.${process.pid}.part`, latest);
const contents = path.join(releaseRoot, "CONTENTS.txt"),
  description = [
    `${name} [${titleId}]`,
    `Current update: ${metadata.contentVersion}`,
    `Base version: ${metadata.baseContentVersion}`,
    `Revision: ${metadata.revision}`,
    "",
    `Full update package: ${path.basename(publishedPackage)}`,
    `Delta update package: ${path.basename(publishedDelta)}`,
    `PlayGo checksum: ${path.basename(publishedCrc)}`,
    "Icon: icon.png",
    "Current metadata: latest.json",
    "Release history: releases",
    "",
  ].join("\n");
await writeFile(`${contents}.${process.pid}.part`, description, { flag: "wx", mode: 0o600 });
await rename(`${contents}.${process.pid}.part`, contents);
await rm(crcFile, { force: true });
await pruneSupersededNativeUpdateAssets(releaseRoot, [
  path.basename(publishedPackage),
  path.basename(publishedDelta),
  path.basename(publishedCrc),
]);
console.log(
  JSON.stringify({
    published: true,
    contentVersion: identity.version,
    revision: metadata.revision,
    size: packageSize,
    strippedSupplementalBytes: sourceInfo.size - packageSize,
    sha256: packageHashes.sha256,
  }),
);
