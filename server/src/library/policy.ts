type Runtime = { firmware: string | null; runtime: string; capabilities: Record<string, boolean>; shadowMountFakelib?: boolean; standaloneBackPork?: boolean };
type Release = { titleId: string; contentId: string; version: string; sha256: string; minimumFirmware: string | null; format: string };
type Profile = { id?: string; titleId: string; contentId: string; gameVersion: string; inputHashes: string[]; targetFirmware: string; runtime: string; installationMethod: string; testedState: string };
export function compatibility(release: Release, consoleInfo: Runtime, profiles: Profile[]) {
  const method = release.format === 'pkg' ? 'FPKG' : release.format === 'elf' ? 'HOMEBREW' : ['ffpkg', 'ffpfs', 'ffpfsc', 'exfat', 'folder'].includes(release.format) ? 'SHADOWMOUNT' : null;
  const capability = method === 'FPKG' ? 'fpkgInstall' : method === 'HOMEBREW' ? 'homebrew' : 'shadowMount';
  const result = (status: string, profileId?: string) => ({ status, method, profileId: profileId ?? null });
  if (!method || !consoleInfo.capabilities[capability]) return result('UNSUPPORTED_METHOD');
  if (consoleInfo.shadowMountFakelib && consoleInfo.standaloneBackPork) return result('RUNTIME_CONFLICT');
  if (!release.minimumFirmware || !consoleInfo.firmware || consoleInfo.runtime === 'unknown') return result('UNKNOWN');
  // Firmware has exactly two fractional digits in the shared schema, e.g. 9.60 < 10.01.
  if (Number(consoleInfo.firmware) >= Number(release.minimumFirmware)) return result('NATIVE_COMPATIBLE');
  const matches = profiles.filter(p => p.titleId === release.titleId && p.contentId === release.contentId && p.gameVersion === release.version && p.inputHashes.includes(release.sha256) && p.targetFirmware === consoleInfo.firmware && p.runtime === consoleInfo.runtime && p.installationMethod === method);
  const match = matches.find(p => p.testedState === 'TESTED') ?? matches[0];
  if (!match || !consoleInfo.capabilities.backportOverlay) return result('BACKPORT_NO_MATCH');
  return result(match.testedState === 'TESTED' ? 'MATCHING_BACKPORT_AVAILABLE' : 'BACKPORT_UNTESTED', match.id);
}
export function planStorage(storage: { freeBytes: number; writable: boolean; installMethodsSupported: string[] }, method: string, components: Record<string, number>) {
  if (Object.values(components).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid storage size');
  const requiredBytes = Object.values(components).reduce((sum, n) => sum + n, 0);
  if (!Number.isSafeInteger(requiredBytes)) throw new Error('Storage size overflow');
  return { requiredBytes, freeBytes: storage.freeBytes, allowed: storage.writable && storage.installMethodsSupported.includes(method) && requiredBytes <= storage.freeBytes };
}
export function presence(lastSeen: number | null, now = Date.now()) {
  if (lastSeen === null || now - lastSeen > 120_000) return 'OFFLINE';
  return now - lastSeen > 30_000 ? 'STALE' : 'ONLINE';
}
export function resolveMetadata(records: { rank: number; data: Record<string, unknown> }[]) {
  const verified = records.find(r => r.rank === 1)?.data;
  for (const record of records) for (const key of ['titleId', 'contentId', 'version']) {
    if (verified?.[key] && record.data[key] && verified[key] !== record.data[key]) throw new Error('METADATA_MISMATCH');
  }
  return Object.assign({}, ...[...records].sort((a, b) => b.rank - a.rank).map(r => r.data)) as Record<string, unknown>;
}
