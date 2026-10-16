import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, readFile, writeFile, copyFile, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import titles from "../../server/shared/native-titles.json" with { type: "json" };
let titleId, contentId;
const toolDirectory = path.dirname(fileURLToPath(import.meta.url)),
  serverDirectory = path.resolve(toolDirectory, "../../server"),
  version = /^\d{2}\.\d{3}\.\d{3}$/;
const help = {
  tool: "ps5library-native-update",
  supportedTitles: titles,
  titleOption: "--title-id <registered-title-id> (required for every command)",
  registration: [
    "For another title, add its exact identity to shared/native-titles.json",
    "and rebuild/restart the Library Node. Run configure before packaging",
    "each BASE or PATCH version.",
  ].join(" "),
  commands: {
    prerequisites: "--title-id <title-id> --source <native-title-folder>",
    configure: [
      "--title-id <title-id> --source <native-title-folder>",
      "--update-origin <http(s)://server:port> [--force to replace an existing URI]",
    ].join(" "),
    build: [
      "--title-id <title-id> --source <folder> --output <patch.pkg>",
      "--reference <previous-remastered.pkg> --base-version <MM.mmm.ppp>",
      "[--executable <raw-elf>] [--generate-unsigned-nptitle]",
      "[--toolkit <folder>] [--compression <-4..9>] [--force]",
    ].join(" "),
    inspect: [
      "--title-id <title-id> --package <pkg> [--installed-version <MM.mmm.ppp>]",
      "[--delta <delta.pkg> --base-version <MM.mmm.ppp> --icon <png>]",
    ].join(" "),
    publish: [
      "--title-id <title-id> --package <remastered.pkg> --delta <delta.pkg>",
      "--base-version <MM.mmm.ppp> --icon <png> [--data-dir <folder>] [--repair]",
    ].join(" "),
    status: "--title-id <title-id> [--data-dir <folder>]",
  },
};

class CliError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("--"))
      throw new CliError("INVALID_ARGUMENT", `Expected an option, received: ${token}`);
    const key = token.slice(2);
    if (key in result) throw new CliError("INVALID_ARGUMENT", `Duplicate option: ${token}`);
    if (key === "force" || key === "repair" || key === "generate-unsigned-nptitle")
      result[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new CliError("INVALID_ARGUMENT", `Missing value for ${token}`);
      result[key] = value;
    }
  }
  return result;
}
function allow(value, names) {
  for (const name of Object.keys(value))
    if (!names.includes(name)) throw new CliError("INVALID_ARGUMENT", `Unknown option: --${name}`);
}
function required(value, name) {
  if (typeof value[name] !== "string" || !value[name])
    throw new CliError("INVALID_ARGUMENT", `Missing --${name}`);
  return value[name];
}
function fixedTitle(value) {
  const requested = required(value, "title-id");
  if (!Object.hasOwn(titles, requested))
    throw new CliError("UNSUPPORTED_TITLE", "Native updates require a registered title.", {
      requested,
      supportedTitles: Object.keys(titles),
    });
  titleId = requested;
  contentId = titles[titleId].contentId;
}
function baseVersion(value) {
  const parsed = required(value, "base-version");
  if (!version.test(parsed))
    throw new CliError("INVALID_BASE_VERSION", "--base-version must use MM.mmm.ppp");
  return parsed;
}
async function regular(file) {
  const resolved = path.resolve(file),
    info = await lstat(resolved).catch((error) => {
      if (error.code === "ENOENT")
        throw new CliError("FILE_NOT_FOUND", `File not found: ${resolved}`);
      throw error;
    });
  if (!info.isFile() || info.isSymbolicLink())
    throw new CliError("INVALID_FILE", `Expected a regular file: ${resolved}`);
  return { path: resolved, size: info.size };
}
function jsonOutput(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    return text
      .trim()
      .split(/\r?\n/)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find(Boolean);
  }
}
function run(command, args, environment = process.env) {
  return new Promise((resolve, reject) =>
    execFile(
      command,
      args,
      {
        cwd: serverDirectory,
        env: environment,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout = "", stderr = "") => {
        if (!error) return resolve({ stdout, stderr });
        const json = jsonOutput(stdout) ?? jsonOutput(stderr),
          diagnostic = (stderr.trim() || stdout.trim() || error.message).slice(-4000);
        reject(
          new CliError(json?.code ?? json?.error ?? "COMMAND_FAILED", json?.message ?? diagnostic, {
            exitCode: error.code,
            command: path.basename(command),
          }),
        );
      },
    ),
  );
}
function result(text) {
  const value = jsonOutput(text);
  if (!value) throw new CliError("INVALID_TOOL_OUTPUT", "Child command did not return JSON");
  return value;
}

const missingUri = (id) => ({
  code: "MISSING_VERSION_FILE_URI",
  message: [
    "No versionFileUri: Home cannot discover future patches.",
    `Before building a BASE or PATCH, run native-update.mjs configure --title-id ${id}`,
    "--source <folder> --update-origin <http(s)://server:port>.",
    "An already-installed title needs a bootstrap reinstall to acquire the URI.",
  ].join(" "),
});
async function readSource(folder) {
  const root = path.resolve(folder),
    rootInfo = await lstat(root).catch((error) => {
      if (error.code === "ENOENT")
        throw new CliError("SOURCE_NOT_FOUND", `Source folder not found: ${root}`);
      throw error;
    });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new CliError("INVALID_SOURCE", "--source must be a regular directory");
  const sys = await lstat(path.join(root, "sce_sys"));
  if (!sys.isDirectory() || sys.isSymbolicLink())
    throw new CliError("INVALID_SOURCE", "sce_sys must be a regular directory");
  const file = path.join(root, "sce_sys", "param.json"),
    info = await regular(file);
  if (!info.size || info.size > 64 * 1024)
    throw new CliError("INVALID_SOURCE_METADATA", "sce_sys/param.json has an invalid size");
  let metadata;
  try {
    metadata = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new CliError("INVALID_SOURCE_METADATA", "sce_sys/param.json is not valid JSON");
  }
  if (metadata?.titleId !== titleId || metadata?.contentId !== contentId)
    throw new CliError("UNSUPPORTED_TITLE", `Source must identify ${titleId}/${contentId}`, {
      titleId: metadata?.titleId ?? null,
      contentId: metadata?.contentId ?? null,
    });
  const nptitleFile = path.join(root, "sce_sys", "nptitle.dat"),
    nptitleInfo = await lstat(nptitleFile).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (nptitleInfo) {
    if (!nptitleInfo.isFile() || nptitleInfo.isSymbolicLink())
      throw new CliError("INVALID_NPTITLE", "sce_sys/nptitle.dat must be a regular file");
    const data = await readFile(nptitleFile),
      expected = Buffer.alloc(16);
    expected.write(`${metadata.titleId}_00`);
    if (
      data.length !== 160 ||
      data.toString("ascii", 0, 4) !== "NPTD" ||
      data.readUInt32BE(4) !== 0x80 ||
      !data.subarray(0x10, 0x20).equals(expected)
    )
      throw new CliError(
        "INVALID_NPTITLE",
        `sce_sys/nptitle.dat is not the exact 160-byte NPTD for ${metadata.titleId}_00; ` +
          "remove it if no title-specific file is available",
      );
  }
  if (!version.test(metadata.contentVersion ?? ""))
    throw new CliError("INVALID_SOURCE_METADATA", "contentVersion must use MM.mmm.ppp");
  return { root, file, metadata, nptitlePresent: Boolean(nptitleInfo) };
}
async function sourceMetadata(folder, requireOrigin = false) {
  const { root, file, metadata, nptitlePresent } = await readSource(folder),
    source = {
      source: root,
      metadataFile: file,
      titleId,
      contentId,
      contentVersion: metadata.contentVersion,
      nptitlePresent,
    };
  if (
    !metadata.versionFileUri ||
    (typeof metadata.versionFileUri === "string" && !metadata.versionFileUri.trim())
  ) {
    const warning = missingUri(titleId);
    if (requireOrigin) throw new CliError(warning.code, warning.message);
    return { ...source, versionFileUri: null, originVerified: false, warnings: [warning] };
  }
  let uri;
  try {
    uri = new URL(metadata.versionFileUri);
  } catch {
    throw new CliError(
      "INVALID_VERSION_FILE_URI",
      "versionFileUri must be an absolute HTTP(S) URL",
    );
  }
  const expected = `/api/v1/native-updates/${titleId}/from/${metadata.contentVersion}/version.xml`;
  if (
    uri.toString().length > 255 ||
    !["http:", "https:"].includes(uri.protocol) ||
    uri.username ||
    uri.password ||
    uri.hash ||
    uri.search ||
    uri.pathname !== expected
  )
    throw new CliError(
      "INVALID_VERSION_FILE_URI",
      `versionFileUri must be at most 255 characters and target the exact installed-version feed: ${expected}`,
      { versionFileUri: metadata.versionFileUri },
    );
  const explicit =
      titleId === "PPSA99051" ? process.env.PS5LIBRARY_NATIVE_VERSION_URI?.trim() : null,
    configuredOrigin = (
      titleId === "PPSA99051"
        ? process.env.COMMUNITY_MASTER_URL || process.env.PUBLIC_URL
        : process.env.PUBLIC_URL
    )?.trim();
  let expectedUri = null;
  try {
    expectedUri = explicit
      ? new URL(explicit)
      : configuredOrigin
        ? new URL(expected, new URL(configuredOrigin))
        : null;
  } catch {
    throw new CliError(
      "INVALID_UPDATE_ORIGIN_CONFIG",
      "Configured native update URL/origin is invalid",
    );
  }
  const originVerified = Boolean(
    expectedUri &&
      (explicit ? uri.toString() === expectedUri.toString() : uri.origin === expectedUri.origin),
  );
  if (expectedUri && !originVerified)
    throw new CliError(
      "UPDATE_ORIGIN_MISMATCH",
      "versionFileUri does not match the configured update server",
      {
        versionFileUri: uri.toString(),
        expected: explicit ? expectedUri.toString() : expectedUri.origin,
      },
    );
  if (requireOrigin && !expectedUri)
    throw new CliError(
      "UPDATE_ORIGIN_NOT_CONFIGURED",
      "Configure the update origin before building: PUBLIC_URL for games; " +
        "PS5LIBRARY_NATIVE_VERSION_URI, COMMUNITY_MASTER_URL, or PUBLIC_URL for PS5Library.",
    );
  return { ...source, versionFileUri: uri.toString(), originVerified };
}
async function configureSource(value) {
  const { root, file, metadata } = await readSource(required(value, "source"));
  let origin;
  try {
    origin = new URL(required(value, "update-origin"));
  } catch {
    throw new CliError(
      "INVALID_UPDATE_ORIGIN",
      "--update-origin must be an absolute HTTP(S) server origin",
    );
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new CliError(
      "INVALID_UPDATE_ORIGIN",
      "Use only the HTTP(S) server origin, without credentials, path, query or fragment",
    );
  const uri = `${origin.origin}/api/v1/native-updates/${titleId}/from/${metadata.contentVersion}/version.xml`,
    backup = `${root}.param-before-update-uri.json`;
  if (uri.length > 255)
    throw new CliError(
      "INVALID_VERSION_FILE_URI",
      "The native update URI must be at most 255 characters",
    );
  const previous =
    typeof metadata.versionFileUri === "string"
      ? metadata.versionFileUri.trim()
      : metadata.versionFileUri;
  if (previous === uri) return { changed: false, metadataFile: file, versionFileUri: uri };
  if (previous && !value.force)
    throw new CliError(
      "VERSION_FILE_URI_EXISTS",
      "An existing update URI would change; use --force only if replacing it is intended",
      { existing: metadata.versionFileUri, proposed: uri },
    );
  await copyFile(file, backup, constants.COPYFILE_EXCL).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify({ ...metadata, versionFileUri: uri }, null, 2) + "\n",
      { flag: "wx" },
    );
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return { changed: true, metadataFile: file, backup, versionFileUri: uri };
}
const prerequisites = (metadata) => ({
  ready: Boolean(metadata?.originVerified),
  titleId,
  contentId,
  sourceMetadata: "sce_sys/param.json",
  versionFileUri: {
    requiredBeforePackaging: true,
    route: `/api/v1/native-updates/${titleId}/from/<installed-content-version>/version.xml`,
  },
  package: { kind: "PATCH", format: "finalized FIH", alignment: 65536 },
  delta: { containerType: 0x23, stream: "RLC" },
  warnings: metadata?.warnings ?? [],
  ...(metadata
    ? {
        validated: metadata,
        ...(!metadata.originVerified
          ? {
              missing: [
                metadata.warnings?.[0]?.message ??
                  "Update path is valid, but no configured server origin was available to verify its host.",
              ],
            }
          : {}),
      }
    : {
        missing: [
          "--source was not supplied; requirements were reported but no source was validated",
        ],
      }),
});
async function inspectCandidate(pkg, base, delta, icon) {
  const output = await run(process.execPath, [
    path.join(toolDirectory, "check-native-update.mjs"),
    pkg,
    base,
    delta,
    "--title-id",
    titleId,
    "--icon",
    icon,
  ]);
  return result(output.stdout);
}
async function workerInspect(file) {
  const dll = path.join(
    serverDirectory,
    "worker",
    "bin",
    "Release",
    "net10.0",
    "PS5Library.Worker.dll",
  );
  if (!(await lstat(dll).catch(() => null)))
    await run("dotnet", ["build", "worker/PS5Library.Worker.csproj", "-c", "Release", "--nologo"]);
  return result((await run("dotnet", [dll, "inspect", file])).stdout);
}
async function inspectReference(file, base) {
  const inspected = await workerInspect(file),
    identity = inspected.identity;
  if (
    inspected.format !== "pkg" ||
    inspected.structurallyRecognized !== true ||
    inspected.metadataVerified !== true ||
    identity?.titleId !== titleId ||
    identity?.contentId !== contentId ||
    identity?.version !== base
  )
    throw new CliError(
      "REFERENCE_MISMATCH",
      "Reference package identity must exactly match --base-version and the selected native title",
      { identity: identity ?? null, baseVersion: base },
    );
  return identity;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "help" || command === "--help" || !command)
    return { ok: true, command: "help", ...help };
  const value = options(args);
  fixedTitle(value);
  if (command === "configure") {
    allow(value, ["source", "update-origin", "force", "title-id"]);
    return { ok: true, command, titleId, ...(await configureSource(value)) };
  }
  if (command === "prerequisites") {
    allow(value, ["source", "title-id"]);
    return { ok: true, command, ...prerequisites(await sourceMetadata(required(value, "source"))) };
  }
  if (command === "inspect") {
    allow(value, ["package", "delta", "base-version", "installed-version", "icon", "title-id"]);
    const pkg = (await regular(required(value, "package"))).path,
      hasNativeInputs = Boolean(value.delta || value["base-version"] || value.icon);
    if (hasNativeInputs && (!value.delta || !value["base-version"] || !value.icon))
      throw new CliError(
        "INCOMPLETE_NATIVE_UPDATE",
        "--delta, --base-version, and --icon must be supplied together",
      );
    if (hasNativeInputs) {
      const base = baseVersion(value),
        delta = (await regular(value.delta)).path,
        icon = (await regular(value.icon)).path;
      return {
        ok: true,
        command,
        titleId,
        nativeHomeUpdateEligible: true,
        validation: await inspectCandidate(pkg, base, delta, icon),
      };
    }
    const inspected = await workerInspect(pkg),
      identity = inspected.identity ?? {},
      installed = value["installed-version"];
    if (installed && !version.test(installed))
      throw new CliError("INVALID_INSTALLED_VERSION", "--installed-version must use MM.mmm.ppp");
    const operation =
      inspected.kind === "BASE"
        ? installed
          ? identity.version > installed
            ? "REPLACE_BASE"
            : identity.version === installed
              ? "ALREADY_INSTALLED"
              : "DOWNGRADE_BASE"
          : "INSTALL_OR_REPLACE_BASE"
        : inspected.kind === "UPDATE"
          ? "INSTALL_PATCH"
          : inspected.kind === "DLC"
            ? "INSTALL_DLC"
            : "UNSUPPORTED";
    return {
      ok: true,
      command,
      package: {
        path: pkg,
        kind: inspected.kind ?? null,
        identity,
        structurallyRecognized: inspected.structurallyRecognized === true,
        metadataVerified: inspected.metadataVerified === true,
      },
      operation,
      nativeHomeUpdateEligible: false,
      nativeHomeUpdateReason:
        identity.titleId === titleId
          ? "DELTA_AND_BASE_VERSION_REQUIRED"
          : inspected.kind === "BASE"
            ? "BASE_PACKAGE_IS_A_REGULAR_INSTALL_OR_REPLACEMENT"
            : "SELECT_MATCHING_TITLE_AND_SUPPLY_DELTA_AND_BASE_VERSION",
    };
  }
  if (command === "publish") {
    allow(value, ["package", "delta", "base-version", "icon", "data-dir", "repair", "title-id"]);
    const iconArg = required(value, "icon"),
      base = baseVersion(value),
      pkg = (await regular(required(value, "package"))).path,
      delta = (await regular(required(value, "delta"))).path,
      icon = (await regular(iconArg)).path;
    const environment = {
        ...process.env,
        ...(value["data-dir"] ? { DATA_DIR: path.resolve(value["data-dir"]) } : {}),
      },
      publish = await run(
        process.execPath,
        [
          path.join(toolDirectory, "publish-native-update.mjs"),
          pkg,
          base,
          delta,
          "--title-id",
          titleId,
          "--icon",
          icon,
          ...(value.repair ? ["--repair"] : []),
        ],
        environment,
      );
    return { ok: true, command, titleId, published: result(publish.stdout) };
  }
  if (command === "build") {
    allow(value, [
      "source",
      "output",
      "reference",
      "base-version",
      "executable",
      "generate-unsigned-nptitle",
      "toolkit",
      "compression",
      "force",
      "title-id",
    ]);
    if (process.platform !== "win32")
      throw new CliError(
        "UNSUPPORTED_HOST",
        "Native package building currently requires Windows and the configured PS5 package toolkit.",
      );
    const base = baseVersion(value),
      source = await sourceMetadata(required(value, "source"), true),
      output = path.resolve(required(value, "output")),
      reference = (await regular(required(value, "reference"))).path,
      executable = value.executable ? (await regular(value.executable)).path : null;
    if (source.contentVersion <= base)
      throw new CliError(
        "VERSION_NOT_NEWER",
        "Source contentVersion must be newer than --base-version",
        { contentVersion: source.contentVersion, baseVersion: base },
      );
    await inspectReference(reference, base);
    const compression = value.compression ?? "9";
    if (!/^-?[0-9]$/.test(compression) || Number(compression) < -4)
      throw new CliError("INVALID_ARGUMENT", "--compression must be an integer from -4 through 9");
    const shell = process.env.SystemRoot
        ? path.join(
            process.env.SystemRoot,
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          )
        : "powershell.exe",
      script = path.join(toolDirectory, "build-native-update.ps1");
    await run(shell, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-SourceFolder",
      source.source,
      ...(executable ? ["-Executable", executable] : []),
      ...(value["generate-unsigned-nptitle"] && !source.nptitlePresent
        ? ["-GenerateUnsignedNptitle"]
        : []),
      "-OutputPackage",
      output,
      "-ReferencePackage",
      reference,
      "-BaseContentVersion",
      base,
      "-TitleId",
      titleId,
      "-CompressionLevel",
      compression,
      ...(value.toolkit ? ["-ToolkitDirectory", path.resolve(value.toolkit)] : []),
      ...(value.force ? ["-Force"] : []),
    ]);
    const files = await Promise.all(
      [output, `${output}.remastered.pkg`, `${output}.delta.pkg`].map(regular),
    );
    return {
      ok: true,
      command,
      titleId,
      contentVersion: source.contentVersion,
      baseContentVersion: base,
      files: { patch: files[0], package: files[1], delta: files[2] },
    };
  }
  if (command === "status") {
    allow(value, ["data-dir", "title-id"]);
    const require = createRequire(path.join(serverDirectory, "package.json"));
    await import(pathToFileURL(require.resolve("tsx/esm")).href);
    const { nativeReleaseLoader, nativeUpdateFolder } = await import(
        pathToFileURL(path.join(serverDirectory, "app/src/updates/native.ts")).href
      ),
      data = path.resolve(value["data-dir"] ?? process.env.DATA_DIR ?? "data"),
      release = await nativeReleaseLoader(
        path.join(data, "native-updates", nativeUpdateFolder(titleId)),
        titleId,
      )();
    return { ok: true, command, titleId, served: Boolean(release), release };
  }
  throw new CliError("UNKNOWN_COMMAND", `Unknown command: ${command}`, help);
}

try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  const code = error?.code && typeof error.code === "string" ? error.code : "NATIVE_UPDATE_FAILED";
  console.error(
    JSON.stringify({
      ok: false,
      code,
      message: error instanceof Error ? error.message : String(error),
      ...(error?.details ? { details: error.details } : {}),
    }),
  );
  process.exitCode = 1;
}
