type Runtime = { firmware: string | null; runtime: string; capabilities: Record<string, boolean>; shadowMountFakelib?: boolean; standaloneBackPork?: boolean };
type Release = { titleId: string; contentId: string; version: string; sha256: string; sourceTreeSha256?:string; minimumFirmware: string | null; format: string };
type Profile = { id?: string; titleId: string; contentId: string; gameVersion: string; inputHashes: string[]; targetFirmware: string; runtime: string; installationMethod: string; testedState: string; delivery?:'OVERLAY'|'INTEGRATED' };
export function compatibility(release: Release, consoleInfo: Runtime, profiles: Profile[]) {
  const firmware=(value:string|null)=>value&&/^\d{1,2}\.\d{2}$/.test(value)?Number(value.split('.')[0])*100+Number(value.split('.')[1]):null;
  const current=firmware(consoleInfo.firmware),required=firmware(release.minimumFirmware);
  const backportRequired=current!==null&&required!==null?current<required:null;
  const method = release.format === 'pkg' ? 'FPKG' : release.format === 'elf' ? 'HOMEBREW' : ['ffpkg', 'ffpfs', 'ffpfsc', 'exfat', 'folder'].includes(release.format) ? 'SHADOWMOUNT' : null;
  const capability = method === 'FPKG' ? 'fpkgInstall' : method === 'HOMEBREW' ? 'homebrew' : 'shadowMount';
  const result = (status: string, profileId?: string,backportDelivery?:'OVERLAY'|'INTEGRATED') => ({ status, method, profileId: profileId ?? null,backportRequired,backportDelivery:backportDelivery??null });
  if (!method || !consoleInfo.capabilities[capability]) return result('UNSUPPORTED_METHOD');
  if (backportRequired===null || consoleInfo.runtime === 'unknown') return result('UNKNOWN');
  if (!backportRequired) return result('NATIVE_COMPATIBLE');
  const indexed = profiles.filter(p => p.titleId === release.titleId && p.contentId === release.contentId && p.gameVersion === release.version);
  const exactInputHash=release.sourceTreeSha256??release.sha256;
  const matches = indexed.filter(p => p.inputHashes.includes(exactInputHash) && p.targetFirmware === consoleInfo.firmware && p.runtime === consoleInfo.runtime && p.installationMethod === method);
  const conflict=!!consoleInfo.shadowMountFakelib&&!!consoleInfo.standaloneBackPork;
  const usable=matches.filter(p=>(p.delivery??'OVERLAY')==='INTEGRATED'?!!consoleInfo.capabilities.integratedBackportProfiles:!conflict&&!!consoleInfo.capabilities.backportOverlay);
  const match = usable.find(p => p.testedState === 'TESTED') ?? usable[0] ?? matches.find(p => p.testedState === 'TESTED') ?? matches[0];
  if (!match) return result(indexed.length?'BACKPORT_NO_MATCH':'BACKPORT_NOT_INDEXED');
  const delivery=match.delivery??'OVERLAY';
  if (delivery==='INTEGRATED'&&!consoleInfo.capabilities.integratedBackportProfiles) return result('INTEGRATED_BACKPORT_AGENT_REQUIRED',match.id,delivery);
  if (delivery==='OVERLAY'&&conflict) return result('RUNTIME_CONFLICT',match.id,delivery);
  if (delivery==='OVERLAY'&&!consoleInfo.capabilities.backportOverlay) return result('BACKPORT_RUNTIME_UNAVAILABLE',match.id,delivery);
  return result(match.testedState === 'TESTED' ? 'MATCHING_BACKPORT_AVAILABLE' : 'BACKPORT_UNTESTED', match.id,delivery);
}
export function planStorage(storage: { freeBytes: number; writable: boolean; installMethodsSupported: string[] }, method: string, components: Record<string, number>) {
  if (Object.values(components).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid storage size');
  const requiredBytes = Object.values(components).reduce((sum, n) => sum + n, 0);
  if (!Number.isSafeInteger(requiredBytes)) throw new Error('Storage size overflow');
  const reason=!storage.writable?'NOT_WRITABLE':!storage.installMethodsSupported.includes(method)?'UNSUPPORTED_METHOD':requiredBytes>storage.freeBytes?'INSUFFICIENT_SPACE':null;
  return { requiredBytes, freeBytes: storage.freeBytes, allowed: reason===null, reason };
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
