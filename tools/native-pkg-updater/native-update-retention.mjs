import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

const nativeUpdateAsset =
  /^(?:[0-9a-f]{64}(?:\.pkg|\.delta\.pkg|\.crc)|.+ - (?:Full Update|Delta Update|PlayGo CRC) - [0-9a-f]{12}\.(?:pkg|crc))$/;

export async function pruneSupersededNativeUpdateAssets(directory, keep) {
  const current = new Set(keep),
    entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) => entry.isFile() && nativeUpdateAsset.test(entry.name) && !current.has(entry.name),
      )
      .map((entry) => unlink(path.join(directory, entry.name))),
  );
}
