using System.Buffers.Binary;
using System.IO.Compression;
using System.Text.Json;
using PS5Library.Worker;

static void Check(bool value, string message) { if (!value) throw new Exception(message); }
static void Reject(Action action, string code) { try { action(); } catch (WorkerError e) when (e.Code == code) { return; } throw new Exception($"Expected {code}"); }
static bool SameNapsBlockMetadata(LibProsperoPkg.PKG.ProsperoNapsIntegrityBlock a,LibProsperoPkg.PKG.ProsperoNapsIntegrityBlock b)=>
    a.Index==b.Index&&a.CompressedOffset==b.CompressedOffset&&a.StoredSize==b.StoredSize&&a.PlainSize==b.PlainSize&&a.IsHole==b.IsHole
    &&a.OwnerFlag==b.OwnerFlag&&a.Tail==b.Tail&&a.OnDiskOffset==b.OnDiskOffset&&a.OnDiskLength==b.OnDiskLength
    &&a.Sha3Digest.AsSpan().SequenceEqual(b.Sha3Digest)&&a.InputChecksum==b.InputChecksum&&a.RollingHash==b.RollingHash;
static byte[] NapsRecord(byte[] plain,string wantedTag) {
    for(var position=0;position+16<=plain.Length;) {
        var tag=new string([(char)plain[position+3],(char)plain[position+2],(char)plain[position+1],(char)plain[position]]);
        var length=BinaryPrimitives.ReadUInt64LittleEndian(plain.AsSpan(position+8,8));
        if(length>int.MaxValue||position+16L+(long)length>plain.Length)throw new InvalidDataException("Malformed NAPS metadata");
        if(tag==wantedTag)return plain.AsSpan(position+16,(int)length).ToArray();
        position=checked(position+16+(int)length);
    }
    throw new InvalidDataException($"Missing NAPS record {wantedTag}");
}
var root = Path.Combine(Path.GetTempPath(), "ps5library-worker-" + Guid.NewGuid());
Directory.CreateDirectory(root);
var copySource=Path.Combine(root,"copy-source");var copyDestination=Path.Combine(root,"copy-destination");Directory.CreateDirectory(copySource);
var copyPayload=new byte[2*1024*1024+1];copyPayload[^1]=1;var copyInput=Path.Combine(copySource,"large.bin");File.WriteAllBytes(copyInput,copyPayload);
var copyHash=Files.Hash(copyInput);var copiedBytes=new List<long>();var hashBytes=new List<(long Completed,long Total)>();
var combinedHashes=Files.HashWithPrefix(copyInput,1024*1024+1,(completed,total)=>hashBytes.Add((completed,total)));
Check(combinedHashes.Sha256==copyHash&&combinedHashes.PrefixSha256==Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(copyPayload.AsSpan(0,1024*1024+1)))
    &&hashBytes.Count>1&&hashBytes[^1]==(copyPayload.LongLength,copyPayload.LongLength),"One streaming pass produces exact full-file and installed-image hashes with measured byte progress");
var copied=Files.CopyTree(copySource,copyDestination,copiedBytes.Add);
Check(copied.Bytes==copyPayload.LongLength&&copied.Sha256==Files.TreeHash(copySource)
    &&copiedBytes.Count>1&&copiedBytes.Zip(copiedBytes.Skip(1)).All(pair=>pair.First<pair.Second)&&copiedBytes[^1]==copyPayload.LongLength
    &&Files.Hash(copyInput)==copyHash&&Files.Hash(Path.Combine(copyDestination,"large.bin"))==copyHash,"Staging copy reports measured bytes without changing source or destination content");
if(!OperatingSystem.IsWindows()){var mode=UnixFileMode.UserRead|UnixFileMode.UserWrite|UnixFileMode.UserExecute|UnixFileMode.GroupRead;File.SetUnixFileMode(copyInput,mode);var modeCopy=Path.Combine(root,"mode-copy");Files.CopyTree(copySource,modeCopy);Check(File.GetUnixFileMode(Path.Combine(modeCopy,"large.bin"))==mode,"Staging copy preserves Unix file mode");}
var firstInput=Path.Combine(root,"a.bin");var middleInput=Path.Combine(root,"m.bin");var batchInput=Path.Combine(root,"y.bin");var streamedInput=Path.Combine(root,"z.bin");
var firstPayload=Enumerable.Range(0,257).Select(i=>(byte)(i*31)).ToArray();
var middlePayload=new byte[0x28000];var batchPayload=new byte[0x80001];var streamedPayload=new byte[0x20001];
for(var i=0;i<batchPayload.Length;i++)batchPayload[i]=(byte)(i*17);
new byte[]{0x7f,69,76,70}.CopyTo(batchPayload,0);
new byte[]{0x7f,69,76,70}.CopyTo(streamedPayload,0);streamedPayload[^1]=0x5a;
File.WriteAllBytes(firstInput,firstPayload);File.WriteAllBytes(middleInput,middlePayload);File.WriteAllBytes(batchInput,batchPayload);File.WriteAllBytes(streamedInput,streamedPayload);
var streamedTree=new LibProsperoPkg.PFS.FSDir();
streamedTree.Files.Add(new LibProsperoPkg.PFS.FSFile(firstInput){name="a.bin",Parent=streamedTree});
streamedTree.Files.Add(new LibProsperoPkg.PFS.FSFile(middleInput){name="m.bin",Parent=streamedTree});
streamedTree.Files.Add(new LibProsperoPkg.PFS.FSFile(batchInput){name="y.bin",Parent=streamedTree});
streamedTree.Files.Add(new LibProsperoPkg.PFS.FSFile(streamedInput){name="z.bin",Parent=streamedTree});
var streamedAssembler=new LibProsperoPkg.PFS.ProsperoPs5InnerImageAssembler(0,0);
var bufferedResult=streamedAssembler.BuildFromFsTree(streamedTree);var streamedOutput=Path.Combine(root,"streamed-file.pfs");
var streamedResult=streamedAssembler.BuildFromFsTreeToFile(streamedTree,streamedOutput,0x40000);
Check(File.ReadAllBytes(streamedOutput).AsSpan().SequenceEqual(bufferedResult.Image),"File-backed inner assembly matches the in-memory image");
var rawInner=Path.Combine(root,"raw-inner.pfs");var rawLayout=LibProsperoPkg.PKG.ProsperoNapsLayout.Parse(LibProsperoPkg.PKG.ProsperoNwonlyNapsGenerator.Generate(streamedResult));
using(var packed=File.OpenRead(streamedOutput))using(var logical=File.Create(rawInner))LibProsperoPkg.PFS.Compression.ProsperoNapsImage.Decompress(packed,rawLayout,logical);
var recoveredInner=Path.Combine(root,"recovered-inner");var recoveredSize=firstPayload.LongLength+middlePayload.LongLength+batchPayload.LongLength+streamedPayload.LongLength;
PS5Library.Worker.Program.ExtractPfs(rawInner,recoveredInner,streamedResult.MetaBaseLogical,recoveredSize);
Check(!Directory.Exists(Path.Combine(recoveredInner,"uroot"))
    &&File.ReadAllBytes(Path.Combine(recoveredInner,"a.bin")).AsSpan().SequenceEqual(firstPayload)
    &&File.ReadAllBytes(Path.Combine(recoveredInner,"m.bin")).AsSpan().SequenceEqual(middlePayload)
    &&File.ReadAllBytes(Path.Combine(recoveredInner,"y.bin")).AsSpan().SequenceEqual(batchPayload)
    &&File.ReadAllBytes(Path.Combine(recoveredInner,"z.bin")).AsSpan().SequenceEqual(streamedPayload),"Raw PS5 inner-PFS extraction strips uroot and preserves file bytes");
Reject(()=>PS5Library.Worker.Program.ExtractPfs(rawInner,Path.Combine(root,"quota-inner"),streamedResult.MetaBaseLogical,recoveredSize-1),"QUOTA_EXCEEDED");
var existingInner=Path.Combine(root,"existing-inner");Directory.CreateDirectory(existingInner);
Reject(()=>PS5Library.Worker.Program.ExtractPfs(rawInner,existingInner,streamedResult.MetaBaseLogical,recoveredSize),"OUTPUT_EXISTS");
var unsafeInner=Path.Combine(root,"unsafe-inner.pfs");var unsafeBytes=File.ReadAllBytes(rawInner);var unsafeName="a.bin"u8;var unsafeNameOffset=-1;
for(var i=16;i<=unsafeBytes.Length-unsafeName.Length;i++)if(unsafeBytes.AsSpan(i,unsafeName.Length).SequenceEqual(unsafeName)&&BinaryPrimitives.ReadInt32LittleEndian(unsafeBytes.AsSpan(i-12,4))==(int)LibProsperoPkg.PFS.DirentType.File&&BinaryPrimitives.ReadInt32LittleEndian(unsafeBytes.AsSpan(i-8,4))==unsafeName.Length){unsafeNameOffset=i;break;}
Check(unsafeNameOffset>=0,"Raw PS5 inner-PFS fixture contains the expected file dirent");BinaryPrimitives.WriteInt32LittleEndian(unsafeBytes.AsSpan(unsafeNameOffset-8,4),2);".."u8.CopyTo(unsafeBytes.AsSpan(unsafeNameOffset));File.WriteAllBytes(unsafeInner,unsafeBytes);
Reject(()=>PS5Library.Worker.Program.ExtractPfs(unsafeInner,Path.Combine(root,"unsafe-inner"),streamedResult.MetaBaseLogical,recoveredSize),"UNSAFE_PATH");
var offsetOutput=Path.Combine(root,"streamed-offset.pfs");
var offsetResult=streamedAssembler.BuildFromFsTreeToFileAtOffset(streamedTree,offsetOutput,0x10000,0x40000);
using(var offsetImage=offsetResult.OpenImage()){var offsetBytes=new byte[offsetResult.ImageLength];offsetImage.ReadExactly(offsetBytes);Check(offsetImage.ReadByte()==-1&&offsetBytes.AsSpan().SequenceEqual(bufferedResult.Image),"Offset inner assembly exposes only its exact image bytes");}
Check(File.ReadAllBytes(offsetOutput).AsSpan(0,0x10000).IndexOfAnyExcept((byte)0)<0,"Offset inner assembly preserves the reserved FIH header region");
var largeCompressedInput=Path.Combine(root,"large-compressible.bin");var largeCompressedPayload=new byte[0x80001];largeCompressedPayload[^1]=1;File.WriteAllBytes(largeCompressedInput,largeCompressedPayload);
var largeCompressedTree=new LibProsperoPkg.PFS.FSDir();largeCompressedTree.Files.Add(new LibProsperoPkg.PFS.FSFile(largeCompressedInput){name="large-compressible.bin",Parent=largeCompressedTree});
var largeCompressedBuffered=streamedAssembler.BuildFromFsTree(largeCompressedTree);var largeCompressedOutput=Path.Combine(root,"large-compressed-file.pfs");
var largeCompressedStreamed=streamedAssembler.BuildFromFsTreeToFile(largeCompressedTree,largeCompressedOutput,0);
Check(largeCompressedStreamed.Placements.Single().CompressionBlocks?.Count>0
    &&largeCompressedStreamed.Placements.Single().OnDiskSize<largeCompressedPayload.LongLength
    &&File.ReadAllBytes(largeCompressedOutput).AsSpan().SequenceEqual(largeCompressedBuffered.Image),"File-backed large files retain Kraken compression and match the in-memory image");
var streamedPlacement=streamedResult.Placements.Single(placement=>placement.UncompressedSize==streamedPayload.LongLength);
Check(streamedPlacement.OnDiskOffset>0&&(streamedResult.Nodes.Single(node=>node.FullPath=="/z.bin").Flags&0x40u)!=0,"Streamed executable magic and relative placement are preserved");
var denseFiles=Enumerable.Range(0,600).Select(i=>new LibProsperoPkg.PFS.ProsperoPs5InnerFile{Path=$"/dense/file-{i:D4}.bin",Data=[0x7f,0x45,0x4c,0x46,(byte)i]}).ToArray();
var denseResult=new LibProsperoPkg.PFS.ProsperoPs5InnerImageAssembler(0,0).Build(denseFiles);
var denseLayout=LibProsperoPkg.PKG.ProsperoNapsLayout.Parse(LibProsperoPkg.PKG.ProsperoNwonlyNapsGenerator.Generate(denseResult));
Check(denseLayout.CblockInfoOffsetByUblock.Count>0&&denseResult.SparseAfidHoles.Count>20,"Dense small-file layouts repair overflowing NAPS u2c windows with sparse AFID holes");
var contentFiles=new (string Path,long Size)[]{("a.bin",firstPayload.LongLength),("m.bin",middlePayload.LongLength),("y.bin",batchPayload.LongLength),("z.bin",streamedPayload.LongLength),("*PFSmetadata",streamedResult.MetadataPlaintext.LongLength)};
var pfsImageKey=Enumerable.Range(0,32).Select(i=>(byte)i).ToArray();var pfsImageSeed=Enumerable.Range(32,16).Select(i=>(byte)i).ToArray();
var meta300=LibProsperoPkg.PKG.ProsperoNapsMeta.BuildMeta300(0x12340000);
Check(meta300.Length==72&&Enumerable.Range(0,9).Select(i=>BinaryPrimitives.ReadUInt64LittleEndian(meta300.AsSpan(i*8,8))).SequenceEqual(new ulong[]{0,0,0x12340000,1,0x12340000,0x10000,0x3e9,0x12350000,0x20000}),"NAPS meta300 matches the SDK 2.79 nine-field descriptor");
var largeContentFiles=new (string Path,long Size)[]{("large-compressible.bin",largeCompressedPayload.LongLength),("*PFSmetadata",largeCompressedStreamed.MetadataPlaintext.LongLength)};
var largeBufferedCapture=new CaptureNapsIntegrityProvider();var largeStreamedCapture=new CaptureNapsIntegrityProvider();
var largeBufferedMeta=LibProsperoPkg.PKG.ProsperoNapsMeta.BuildMeta18((ulong)largeCompressedBuffered.ImageLength,largeCompressedBuffered.Image,largeContentFiles,largeCompressedBuffered,largeBufferedCapture,pfsImageKey,pfsImageSeed);
var largeStreamedMeta=LibProsperoPkg.PKG.ProsperoNapsMeta.BuildMeta18((ulong)largeCompressedStreamed.ImageLength,largeCompressedStreamed.ImageLength,largeContentFiles,largeCompressedStreamed,largeStreamedCapture,pfsImageKey,pfsImageSeed);
var largeBufferedIntegrity=largeBufferedCapture.Context??throw new Exception("Buffered compressed NAPS integrity context was not captured");var largeStreamedIntegrity=largeStreamedCapture.Context??throw new Exception("File-backed compressed NAPS integrity context was not captured");
Check(largeStreamedMeta.AsSpan().SequenceEqual(largeBufferedMeta)&&largeStreamedIntegrity.MappingBlocks.Count==largeBufferedIntegrity.MappingBlocks.Count
    &&largeStreamedIntegrity.MappingBlocks.Zip(largeBufferedIntegrity.MappingBlocks).All(pair=>SameNapsBlockMetadata(pair.First,pair.Second)&&largeStreamedIntegrity.ReadPlaintextBlock(pair.First.Index).AsSpan().SequenceEqual(largeBufferedIntegrity.ReadPlaintextBlock(pair.Second.Index))),"File-backed large compressed placement matches buffered Meta18 integrity metadata and plaintext");
var bufferedMeta=LibProsperoPkg.PKG.ProsperoNapsMeta.BuildMeta18((ulong)bufferedResult.ImageLength,bufferedResult.Image,contentFiles,bufferedResult,pfsImageKey:pfsImageKey,pfsImageSeed:pfsImageSeed);
var integrityCapture=new CaptureNapsIntegrityProvider();
var streamedMeta=LibProsperoPkg.PKG.ProsperoNapsMeta.BuildMeta18((ulong)streamedResult.ImageLength,streamedResult.ImageLength,contentFiles,streamedResult,integrityCapture,pfsImageKey,pfsImageSeed);
Check(streamedMeta.AsSpan().SequenceEqual(bufferedMeta),"File-backed BuildMeta18 matches the in-memory NAPS metadata");
Check(streamedMeta.AsSpan(0,4).SequenceEqual("rdhp"u8)&&LibProsperoPkg.PKG.ProsperoNapsMeta.DecryptMeta18(streamedMeta).AsSpan().SequenceEqual(streamedMeta),"NAPS meta18 uses the SDK plaintext TLV format");
var earlyMeta=LibProsperoPkg.PKG.ProsperoNapsMeta.BuildMeta18((ulong)streamedResult.ImageLength,streamedResult.ImageLength+0x10000,contentFiles,streamedResult,pfsImageKey:pfsImageKey,pfsImageSeed:pfsImageSeed);
Check(earlyMeta.AsSpan().SequenceEqual(streamedMeta),"NAPS metadata can be finalized before the complete mount image exists");
var physicalDigests=new byte[streamedResult.ImageLength/0x10000*32];using(var image=streamedResult.OpenImage()){var block=new byte[0x10000];for(var i=0;i<physicalDigests.Length/32;i++){image.ReadExactly(block);LibProsperoPkg.PKG.ProsperoImageDigests.Sha3_256(block).CopyTo(physicalDigests,i*32);}}
var reusedDigestMeta=LibProsperoPkg.PKG.ProsperoNapsMeta.BuildMeta18WithPhysicalBlockDigests((ulong)streamedResult.ImageLength,streamedResult.ImageLength,contentFiles,streamedResult,physicalDigests,pfsImageKey:pfsImageKey,pfsImageSeed:pfsImageSeed);
Check(reusedDigestMeta.AsSpan().SequenceEqual(streamedMeta),"NAPS metadata reuses verified physical-block digests without changing bytes");
var integrity=integrityCapture.Context??throw new Exception("NAPS integrity context was not captured");
var lastFileBlock=integrity.MappingBlocks.Single(block=>block.OnDiskOffset==streamedPlacement.OnDiskOffset&&block.PlainSize==streamedPayload.Length);
Check(lastFileBlock.Plaintext.IsEmpty&&integrity.ReadPlaintextBlock(lastFileBlock.Index).AsSpan().SequenceEqual(streamedPayload),"Aggregate-budget file remains file-backed and readable");
Check(lastFileBlock.Sha3Digest.AsSpan().SequenceEqual(LibProsperoPkg.PKG.ProsperoImageDigests.Sha3_256(streamedPayload))
    &&lastFileBlock.InputChecksum==LibProsperoPkg.PKG.ProsperoNapsMeta.ComputeInputChecksum(streamedPayload)
    &&lastFileBlock.RollingHash==LibProsperoPkg.PKG.ProsperoNapsMeta.ComputeRollingHash(streamedPayload),"Final streamed mapping block digest and checksums are exact");
var streamedMetaPlain=LibProsperoPkg.PKG.ProsperoNapsMeta.DecryptMeta18(streamedMeta);var ihsh=NapsRecord(streamedMetaPlain,"ihsh");var rhsh=NapsRecord(streamedMetaPlain,"rhsh");
Check(BinaryPrimitives.ReadUInt64LittleEndian(ihsh.AsSpan(lastFileBlock.Index*0x30,8))==lastFileBlock.InputChecksum
    &&ihsh.AsSpan(lastFileBlock.Index*0x30+8,32).SequenceEqual(lastFileBlock.Sha3Digest)
    &&BinaryPrimitives.ReadUInt64LittleEndian(rhsh.AsSpan(lastFileBlock.Index*8,8))==lastFileBlock.RollingHash,"BuildMeta18 serializes streamed ihsh and rhsh values");
var physicalBlock=checked((int)((streamedPlacement.OnDiskOffset+streamedPayload.LongLength-1)/0x10000));var physicalBytes=new byte[0x10000];
using(var image=File.OpenRead(streamedOutput)){image.Position=(long)physicalBlock*0x10000;image.ReadExactly(physicalBytes);}
Check(NapsRecord(streamedMetaPlain,"obdg").AsSpan(physicalBlock*32,32).SequenceEqual(LibProsperoPkg.PKG.ProsperoImageDigests.Sha3_256(physicalBytes)),"BuildMeta18 hashes the streamed physical image block");
Check(NapsRecord(streamedMetaPlain,"obcc").AsSpan().SequenceEqual(LibProsperoPkg.PKG.ProsperoNapsMeta.BuildOuterBlockCheckCodes(integrity)),"BuildMeta18 checks the streamed physical image blocks");
var crcInput=Path.Combine(root,"native-update.pkg");var crcOutput=Path.Combine(root,"native-update.crc");
var crcFixture=new byte[0x10001];crcFixture[^1]=1;File.WriteAllBytes(crcInput,crcFixture);
PS5Library.Worker.Program.WritePackageChunkCrc(crcInput,crcOutput);
Check(new FileInfo(crcOutput).Length==8,"Native update CRC covers the final partial 64-KiB package block");
var knownCrcBytes=Enumerable.Range(0,0x30000).Select(i=>(byte)(i*13)).ToArray();using var knownCrcStream=new MemoryStream(knownCrcBytes);
var completeCrc=LibProsperoPkg.PlayGo.ProsperoPlayGo.BuildChunkCrc(knownCrcStream,knownCrcStream.Length);knownCrcStream.Position=0;
var reusedCrc=LibProsperoPkg.PlayGo.ProsperoPlayGo.BuildChunkCrc(knownCrcStream,knownCrcStream.Length,0x10000,completeCrc.AsSpan(4,4).ToArray());
Check(reusedCrc.AsSpan().SequenceEqual(completeCrc),"PlayGo CRC reuses a verified aligned block range without changing bytes");
Check(typeof(LibProsperoPkg.PlayGo.ProsperoPlayGo).GetMethod("BuildChunkDat",[typeof(string),typeof(ulong),typeof(ulong),typeof(bool),typeof(bool)]) is not null,"PlayGo keeps its five-argument binary API");
Check(!typeof(LibProsperoPkg.PFS.ProsperoOuterPackageFileResult).GetProperty("BlockCrc32C")!.GetCustomAttributesData().Any(attribute=>attribute.AttributeType==typeof(System.Runtime.CompilerServices.RequiredMemberAttribute)),"Outer CRC metadata remains source compatible");
var source = Path.Combine(root, "input"); Directory.CreateDirectory(Path.Combine(source,"sce_sys"));
var identity = new Identity("PPSA99999", "IV0000-PPSA99999_00-PS5LIBRARYDEMO00", "01.00", "PS5Library sample");
File.WriteAllText(Path.Combine(source,"sce_sys","param.json"), JsonSerializer.Serialize(new { titleId=identity.TitleId, contentId=identity.ContentId, contentVersion=identity.Version, masterVersion="01.00", requiredSystemSoftwareVersion="0x0900000000000000", sdkVersion="0x0900000000000000", psml=new {mfsrVersion="09.00"}, localizedParameters=new { defaultLanguage="en-US", en_US=new { titleName=identity.Title } } }));
var elf = new byte[4096]; new byte[] { 0x7f,69,76,70,2,1,1 }.CopyTo(elf,0);
BinaryPrimitives.WriteUInt16LittleEndian(elf.AsSpan(16), 2); BinaryPrimitives.WriteUInt16LittleEndian(elf.AsSpan(18), 62);
BinaryPrimitives.WriteUInt32LittleEndian(elf.AsSpan(20), 1); BinaryPrimitives.WriteUInt64LittleEndian(elf.AsSpan(24), 0x400080);
BinaryPrimitives.WriteUInt64LittleEndian(elf.AsSpan(32), 64); BinaryPrimitives.WriteUInt16LittleEndian(elf.AsSpan(52), 64);
BinaryPrimitives.WriteUInt16LittleEndian(elf.AsSpan(54), 56); BinaryPrimitives.WriteUInt16LittleEndian(elf.AsSpan(56), 1);
BinaryPrimitives.WriteUInt32LittleEndian(elf.AsSpan(64), 1); BinaryPrimitives.WriteUInt32LittleEndian(elf.AsSpan(68), 5);
BinaryPrimitives.WriteUInt64LittleEndian(elf.AsSpan(80), 0x400000); BinaryPrimitives.WriteUInt64LittleEndian(elf.AsSpan(96), 4096);
BinaryPrimitives.WriteUInt64LittleEndian(elf.AsSpan(104), 4096); BinaryPrimitives.WriteUInt64LittleEndian(elf.AsSpan(112), 4096); elf[128] = 0xc3;
var fake = Modules.FakeSign(elf);
File.WriteAllBytes(Path.Combine(source,"eboot.bin"), elf);
Directory.CreateDirectory(Path.Combine(source,"sce_module"));
File.WriteAllBytes(Path.Combine(source,"sce_module","libraw.prx"),elf);
var legacySelf=fake.ToArray();BinaryPrimitives.WriteUInt32LittleEndian(legacySelf,LibProsperoPkg.Content.ProsperoFself.OrbisMagic);
File.WriteAllBytes(Path.Combine(source,"sce_module","liblegacy.prx"),legacySelf);
File.WriteAllText(Path.Combine(source,"Entitlements.TXT"),"Dumper host record; never package");
var icon=Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
File.WriteAllBytes(Path.Combine(source,"sce_sys","icon0.png"),icon);
File.WriteAllBytes(Path.Combine(source,"sce_sys","pic0.png"),icon);
File.WriteAllBytes(Path.Combine(source,"sce_sys","playgo-chunk.dat"),LibProsperoPkg.PlayGo.ProsperoPlayGo.BuildChunkDat(identity.ContentId,0x1234,0x56,true));
File.WriteAllText(Path.Combine(source,"sce_sys","pfs-version.dat"),"00.000.000");
Directory.CreateDirectory(Path.Combine(source,"sce_suppl"));File.WriteAllText(Path.Combine(source,"sce_suppl","stale.bin"),"SDK output must not become game payload");
Directory.CreateDirectory(Path.Combine(source,"decrypted"));File.WriteAllBytes(Path.Combine(source,"decrypted","eboot.elf"),elf);
File.WriteAllText(Path.Combine(source,"playlgo.log"),"Host PlayGo emulator log; never package");
Directory.CreateDirectory(Path.Combine(source,"DLC"));
File.WriteAllText(Path.Combine(source,"DLC","separate.pkg"),"Separate supplied DLC; never embed in the base image");
Directory.CreateDirectory(Path.Combine(source,"backport"));
File.WriteAllText(Path.Combine(source,"backport","patched.bin"),"Package-local backport");
Directory.CreateDirectory(Path.Combine(source,"fakelib"));
File.WriteAllBytes(Path.Combine(source,"fakelib","libsample.sprx"),fake);
Directory.CreateDirectory(Path.Combine(source,"fakelib2"));
File.WriteAllBytes(Path.Combine(source,"fakelib2","libexclusive.sprx"),fake);
var originalHash = Files.TreeHash(source);var originalSize=Files.Enumerate(source).Sum(file=>new FileInfo(file).Length);
var baseSource=Path.Combine(root,"base-source");Files.CopyTree(source,baseSource);foreach(var directory in Directory.GetDirectories(baseSource).Where(Files.ExcludedFromBase))Directory.Delete(directory,true);
var baseHash=Files.TreeHash(baseSource);var baseSize=Files.Enumerate(baseSource).Sum(file=>new FileInfo(file).Length);
var changedSource=Path.Combine(root,"changed-source");Files.CopyTree(source,changedSource);var changed=false;BuildResult? overlayChangedBuild=null;
using(var log=new TriggerWriter(line=>{if(!changed&&line.Contains("\"stage\":\"Checking source manifest\"")){File.AppendAllText(Path.Combine(changedSource,"DLC","separate.pkg"),"changed");changed=true;}})){
    var savedError=Console.Error;try{Console.SetError(log);overlayChangedBuild=Pipeline.Build(changedSource,Path.Combine(root,"changed-build"),"FPKG",identity,expectedHash:baseHash,expectedSize:baseSize);}finally{Console.SetError(savedError);}
    Check(overlayChangedBuild.InputHash==baseHash&&Files.TreeHash(changedSource)!=originalHash&&log.ToString().Contains("Building directly from source"),"Verified FPKG identity excludes a concurrently changed top-level overlay tree");
}
Check(InputInspector.ReadIdentity(System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new {titleId=identity.TitleId,contentId=identity.ContentId,contentVersion="01.005.000"}))).Version=="01.005.000","PS5 three-component version");
Check(InputInspector.ReadIdentity(System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new {titleId=identity.TitleId,contentId=identity.ContentId,contentVersion="01.005.000",targetContentVersion="01.004.000"}))).BaseContentVersion=="01.004.000","Patch identity preserves its exact target version");
Reject(()=>InputInspector.ReadIdentity(System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new {titleId=identity.TitleId,contentId=identity.ContentId,contentVersion="01.005.000",targetContentVersion="01.005.000"}))),"CORRUPT_INPUT");
Check(InputInspector.PackageKind(0x20,0x02020000)=="BASE"&&InputInspector.PackageKind(0x20,0x4a420000)=="UPDATE"&&InputInspector.PackageKind(0x21,0x4a420000)=="DLC","Package kind uses CNT patch flags");
Check(InputInspector.Inspect(source).Identity?.TitleId == identity.TitleId, "Folder identity");
Reject(() => InputInspector.Inspect(source, identity with { TitleId="PPSA11111" }), "METADATA_MISMATCH");
Reject(() => Pipeline.Build(source,Path.Combine(root,"understated"),"FPKG",identity,expectedSize:1),"CORRUPT_INPUT");
var badZip = Path.Combine(root,"bad.zip");
using (var archive = ZipFile.Open(badZip,ZipArchiveMode.Create)) { using var writer = new StreamWriter(archive.CreateEntry("../escaped.txt").Open()); writer.Write("bad"); }
Reject(() => SafeExtract.Zip(badZip,Path.Combine(root,"extract"),100000), "UNSAFE_PATH");
var rar=InputInspector.Inspect("worker/Tests/Fixtures/homebrew.part1.rar");
Check(rar.Format=="rar" && rar.Identity?.TitleId=="PPSA99994","Multipart RAR supplies inspected game identity");
var archiveCopy=Path.Combine(root,"parts");Directory.CreateDirectory(archiveCopy);
foreach(var file in Directory.GetFiles("worker/Tests/Fixtures","*.rar"))File.Copy(file,Path.Combine(archiveCopy,Path.GetFileName(file)));
File.Delete(Path.Combine(archiveCopy,"homebrew.part2.rar"));
Reject(()=>InputInspector.Inspect(Path.Combine(archiveCopy,"homebrew.part1.rar")),"MISSING_ARCHIVE_PART");
File.Copy("worker/Tests/Fixtures/homebrew.part2.rar",Path.Combine(archiveCopy,"homebrew.part2.rar"));File.Delete(Path.Combine(archiveCopy,"homebrew.part4.rar"));
Reject(()=>InputInspector.Inspect(Path.Combine(archiveCopy,"homebrew.part1.rar")),"MISSING_ARCHIVE_PART");
Reject(()=>Archives.Extract("worker/Tests/Fixtures/homebrew.part1.rar",Path.Combine(root,"quota"),100),"QUOTA_EXCEEDED");
Reject(()=>Archives.Extract(badZip,Path.Combine(root,"archive-traversal"),100000),"UNSAFE_PATH");
Archives.Extract("worker/Tests/Fixtures/homebrew.part1.rar",Path.Combine(root,"rar-extracted"),100000);
Check(InputInspector.Inspect(Path.Combine(root,"rar-extracted","Example")).Identity?.TitleId=="PPSA99994","Extracted RAR has a complete game root");
var ufs = Pipeline.Build(source, Path.Combine(root,"ufs"), "SHADOWMOUNT", identity);
Check(ufs.Format == "ffpkg" && ufs.Size > 0 && ufs.Sha256.Length == 64, "Real UFS build");
Check(InputInspector.Inspect(ufs.OutputPath, identity).Identity?.TitleId == identity.TitleId, "UFS embedded metadata");
BuildResult pkg;var originalError=Console.Error;using var progressOutput=new StringWriter();
try { Console.SetError(progressOutput);pkg=Pipeline.Build(source,Path.Combine(root,"pkg"),"FPKG",identity,expectedHash:baseHash,expectedSize:baseSize); }
finally { Console.SetError(originalError); }
var progress=progressOutput.ToString().Split('\n').Where(line=>line.StartsWith("PS5LIBRARY_PROGRESS ")).Select(line=>JsonDocument.Parse(line[20..]).RootElement.Clone()).ToArray();
Check(progressOutput.ToString().Contains("directly into the final package"),"FPKG writes one large final package without inner/outer image intermediates");
Check(progress.All(p=>!p.TryGetProperty("staging",out _))&&progress.Any(p=>p.GetProperty("stage").GetString()=="Building directly from source"),"FPKG builds from the verified source without a full staging copy");
Check(progress.Any(p=>p.GetProperty("package").GetProperty("state").GetString()=="BUILDING"&&p.GetProperty("fakelib").GetProperty("state").GetString()=="SEPARATED"),"Package build and separate libraries have distinct progress");
Check(progress.Any(p=>p.GetProperty("stage").GetString()=="Finalizing package"&&!p.TryGetProperty("operation",out _)
    &&p.GetProperty("package").GetProperty("state").GetString()=="FINALIZING"),"FPKG finalization replaces the completed source-byte bar with an indeterminate stage");
Check(progress[^1].GetProperty("fakelib").GetProperty("state").GetString()=="VERIFIED"&&progress[^1].GetProperty("fakelib").GetProperty("size").GetInt64()==fake.Length*2,"Library verification reports its actual size");
var byteStages=progress.Where(p=>p.TryGetProperty("operation",out _)).ToArray();
Check(byteStages.Any(p=>p.GetProperty("stage").GetString()=="Building package"&&p.GetProperty("operation").GetProperty("completedBytes").GetInt64()==p.GetProperty("operation").GetProperty("totalBytes").GetInt64())
    &&byteStages.Any(p=>p.GetProperty("stage").GetString()=="Inspecting output")
    &&byteStages.Any(p=>p.GetProperty("stage").GetString()=="Rechecking source"),"Long converter stages report measured bytes");
Check(pkg.Format == "pkg" && InputInspector.Inspect(pkg.OutputPath,identity).StructurallyRecognized, "Real PKG build and inspection");
var opaqueLicenseSource=Path.Combine(root,"opaque-license");Files.CopyTree(source,opaqueLicenseSource);
var opaqueLicenseDat=Enumerable.Repeat((byte)0x9d,0x400).ToArray();var opaqueLicenseInfo=Enumerable.Repeat((byte)0x44,0x200).ToArray();
File.WriteAllBytes(Path.Combine(opaqueLicenseSource,"sce_sys","license.dat"),opaqueLicenseDat);File.WriteAllBytes(Path.Combine(opaqueLicenseSource,"sce_sys","license.info"),opaqueLicenseInfo);
var opaqueLicenseBuild=Pipeline.Build(opaqueLicenseSource,Path.Combine(root,"opaque-license-pkg"),"FPKG",identity);
Check(InputInspector.Inspect(opaqueLicenseBuild.OutputPath,identity).StructurallyRecognized
    &&File.ReadAllBytes(Path.Combine(opaqueLicenseSource,"sce_sys","license.dat")).AsSpan().SequenceEqual(opaqueLicenseDat)
    &&File.ReadAllBytes(Path.Combine(opaqueLicenseSource,"sce_sys","license.info")).AsSpan().SequenceEqual(opaqueLicenseInfo),"Opaque retail license records are omitted from a base FPKG without changing the dump");
File.Delete(Path.Combine(opaqueLicenseSource,"sce_sys","license.info"));
Reject(()=>Pipeline.Build(opaqueLicenseSource,Path.Combine(root,"incomplete-license-pkg"),"FPKG",identity),"INCOMPLETE_INPUT");
var packageArtwork=Path.Combine(root,"package-artwork");var extractedArtwork=JsonSerializer.SerializeToElement(PackageAssets.Extract(pkg.OutputPath,packageArtwork),PS5Library.Worker.Program.JsonOptions);
Check(extractedArtwork.TryGetProperty("icon",out var extractedIcon)&&File.ReadAllBytes(extractedIcon.GetString()!).AsSpan().SequenceEqual(icon),"FPKG embedded icon extraction");
Check(extractedArtwork.TryGetProperty("hero",out var extractedHero)&&File.ReadAllBytes(extractedHero.GetString()!).AsSpan().SequenceEqual(icon),"FPKG embedded hero extraction");
var packageMap=LibProsperoPkg.PKG.ProsperoPackageArchive.Inspect(pkg.OutputPath);
var splitOuter=Path.Combine(root,"split-outer.pfs");var splitMetadata=Path.Combine(root,"split-metadata.cnt");
using(var input=File.OpenRead(pkg.OutputPath))using(var outer=File.Create(splitOuter))using(var metadata=File.Create(splitMetadata))
    LibProsperoPkg.PKG.ProsperoPackageArchive.Split(input,outer,metadata);
var metadataBytes=File.ReadAllBytes(splitMetadata);BinaryPrimitives.WriteUInt64BigEndian(metadataBytes.AsSpan(0x410,8),(ulong)metadataBytes.LongLength);File.WriteAllBytes(splitMetadata,metadataBytes);
var combinedCnt=Path.Combine(root,"combined.cnt");using(var combined=File.Create(combinedCnt)){combined.Write(metadataBytes);using var outer=File.OpenRead(splitOuter);outer.CopyTo(combined);}
var legacyFih=Path.Combine(root,"legacy-fih.pkg");var splitFih=Path.Combine(root,"split-fih.pkg");
LibProsperoPkg.PKG.ProsperoFihBuilder.BuildFromCnt(combinedCnt,legacyFih,outerSuperblockIndex:packageMap.OuterSuperblockIndex);
LibProsperoPkg.PKG.ProsperoFihBuilder.BuildFromParts(splitMetadata,splitOuter,splitFih,outerSuperblockIndex:packageMap.OuterSuperblockIndex);
Check(File.ReadAllBytes(splitFih).AsSpan().SequenceEqual(File.ReadAllBytes(legacyFih)),"Split metadata + outer FIH finalization is byte-identical to the legacy CNT route");
var inPlaceFih=Path.Combine(root,"in-place-fih.pkg");
using(var prepared=File.Create(inPlaceFih)){prepared.SetLength(0x10000);prepared.Position=0x10000;using var outer=File.OpenRead(splitOuter);outer.CopyTo(prepared);}
LibProsperoPkg.PKG.ProsperoFihBuilder.BuildFromParts(splitMetadata,inPlaceFih,inPlaceFih,outerSuperblockIndex:packageMap.OuterSuperblockIndex,pfsAlreadyAtOutput:true);
Check(File.ReadAllBytes(inPlaceFih).AsSpan().SequenceEqual(File.ReadAllBytes(legacyFih)),"In-place finalization is byte-identical without an outer-image copy");
var packageBytes=File.ReadAllBytes(pkg.OutputPath);var cnt=packageBytes.AsSpan(checked((int)packageMap.CntOffset));
var packageInspection=JsonSerializer.SerializeToElement(InputInspector.Inspect(pkg.OutputPath,identity),PS5Library.Worker.Program.JsonOptions);
Check(packageInspection.TryGetProperty("installedImage",out var installedImage)
    && installedImage.GetProperty("size").GetInt64()==packageMap.SupplementOffset
    && installedImage.GetProperty("sha256").GetString()==Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(packageBytes.AsSpan(0,checked((int)packageMap.SupplementOffset)))),
    "FPKG inspection identifies the exact image prefix retained by the console");
var outerSuperblock=BinaryPrimitives.ReadUInt64LittleEndian(packageBytes.AsSpan(0x20));
Check(packageBytes.AsSpan(checked((int)outerSuperblock+0x370),16).SequenceEqual("PPRPLAIN-NOAUTH!"u8),"FPKG carries the kstuff-lite plaintext PPR marker");
var packageSize=BinaryPrimitives.ReadUInt64BigEndian(cnt[0x430..]);var cntOffset=BinaryPrimitives.ReadUInt64BigEndian(cnt[0x4b0..]);var cntSize=BinaryPrimitives.ReadUInt64BigEndian(cnt[0x4b8..]);
Check(BinaryPrimitives.ReadUInt64BigEndian(cnt[0x30..])>0&&packageSize>0&&cntOffset+cntSize==packageSize,"FPKG declares complete install geometry");
var entryCount=BinaryPrimitives.ReadUInt32BigEndian(cnt[0x10..]);var entryTable=BinaryPrimitives.ReadUInt32BigEndian(cnt[0x18..]);
ReadOnlySpan<byte> playgo=default,scenario=default;
for(var i=0;i<entryCount;i++) {
    var entry=cnt[checked((int)(entryTable+i*32))..];var id=BinaryPrimitives.ReadUInt32BigEndian(entry);
    var offset=BinaryPrimitives.ReadUInt32BigEndian(entry[0x10..]);var size=BinaryPrimitives.ReadUInt32BigEndian(entry[0x14..]);
    if(id==0x1001)playgo=cnt.Slice(checked((int)offset),checked((int)size));
    if(id==0x3000)scenario=cnt.Slice(checked((int)offset),checked((int)size));
}
Check(playgo.Length>=0x100&&playgo[..4].SequenceEqual("plgx"u8)&&BinaryPrimitives.ReadUInt16LittleEndian(playgo[0x0a..])==100,"Application FPKG uses the current 100-chunk PlayGo profile");
for(var pointer=0xc0;pointer<=0xf0;pointer+=8) {
    var offset=BinaryPrimitives.ReadUInt32LittleEndian(playgo[pointer..]);var size=BinaryPrimitives.ReadUInt32LittleEndian(playgo[(pointer+4)..]);
    Check((ulong)offset+size<=(ulong)playgo.Length,"PlayGo section stays inside its descriptor");
}
var rangesOffset=BinaryPrimitives.ReadUInt32LittleEndian(playgo[0xd8..]);var rangesSize=BinaryPrimitives.ReadUInt32LittleEndian(playgo[0xdc..]);ulong rangeEnd=0;
for(var offset=0;offset<rangesSize;offset+=16) {
    var range=playgo.Slice(checked((int)(rangesOffset+offset)),16);var start=BinaryPrimitives.ReadUInt64LittleEndian(range);var size=BinaryPrimitives.ReadUInt64LittleEndian(range[8..]);
    Check(start==rangeEnd,"PlayGo extents are contiguous");rangeEnd=checked(rangeEnd+size);
}
Check(rangeEnd==cntOffset&&scenario.Length==370&&Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(scenario))=="050790553a5125b02c60ea967f9ee6fbc369e6072f9f98663a7b764ce6cf3b2a","PlayGo extents cover the mount image and include the SDK 2.79 scenario metadata");
var siReadback=Path.Combine(root,"si-readback");LibProsperoPkg.PKG.ProsperoPackageArchive.ExtractSiEntries(pkg.OutputPath,siReadback);
Check(File.ReadAllBytes(Path.Combine(siReadback,"config",identity.ContentId,"playgo-scenario.json")).AsSpan().SequenceEqual(scenario),"FPKG SI preserves the CNT PlayGo scenario metadata");
var unpacked=Path.Combine(root,"pkg-readback");
LibProsperoPkg.PKG.ProsperoPackageArchive.ExtractInnerFiles(pkg.OutputPath,unpacked,new string('0',32));
Check(!Directory.Exists(Path.Combine(unpacked,"fakelib")),"FPKG excludes the dump's ShadowMount libraries");
Check(!Directory.Exists(Path.Combine(unpacked,"fakelib2")),"FPKG excludes exclusive ShadowMount libraries");
Check(!Directory.Exists(Path.Combine(unpacked,"DLC")),"FPKG excludes separate DLC packages");
Check(!Directory.Exists(Path.Combine(unpacked,"backport")),"FPKG excludes supplied backport folders");
Check(!File.Exists(Path.Combine(unpacked,"patched.bin")),"FPKG requires a verified profile before applying supplied backport files");
Check(!Directory.Exists(Path.Combine(unpacked,"sce_suppl")),"FPKG excludes extracted publisher service output");
Check(!Directory.Exists(Path.Combine(unpacked,"decrypted")),"FPKG excludes raw decrypted host artifacts");
Check(!File.Exists(Path.Combine(unpacked,"playlgo.log")),"FPKG excludes PlayGo emulator logs");
Check(!File.Exists(Path.Combine(unpacked,"Entitlements.TXT")),"FPKG excludes case-insensitive dumper host records");
Check(System.Text.Encoding.ASCII.GetString(File.ReadAllBytes(Path.Combine(unpacked,"sce_sys","pfs-version.dat")))==identity.Version,"FPKG regenerates pfs-version.dat from current package metadata");
Check(BinaryPrimitives.ReadUInt32LittleEndian(File.ReadAllBytes(Path.Combine(unpacked,"sce_module","liblegacy.prx")))==LibProsperoPkg.Content.ProsperoFself.Magic,"FPKG normalizes legacy SELF magic without changing the source dump");
Check(Modules.ToElf(File.ReadAllBytes(Path.Combine(unpacked,"eboot.bin"))).AsSpan().SequenceEqual(elf),"Read back the actual FPKG executable");
Check(Modules.ToElf(File.ReadAllBytes(Path.Combine(unpacked,"sce_module","libraw.prx"))).AsSpan().SequenceEqual(elf),"FPKG converts loose ELF modules without changing the source");
var completeSource=Path.Combine(root,"complete-backport-source");Files.CopyTree(source,completeSource);Directory.Delete(Path.Combine(completeSource,"fakelib"),true);Directory.Delete(Path.Combine(completeSource,"fakelib2"),true);
File.WriteAllBytes(Path.Combine(completeSource,"backport","eboot.bin"),fake);
Directory.CreateDirectory(Path.Combine(completeSource,"backport","fakelib"));File.WriteAllBytes(Path.Combine(completeSource,"backport","fakelib","libcomplete.sprx"),fake);
Directory.CreateDirectory(Path.Combine(completeSource,"backport","sce_module"));File.WriteAllText(Path.Combine(completeSource,"backport","sce_module","replacement.prx"),"exact replacement");
Directory.CreateDirectory(Path.Combine(completeSource,"backport","sce_sys","about"));File.WriteAllText(Path.Combine(completeSource,"backport","sce_sys","about","right.sprx"),"supplied rights module");
var completeHash=Files.TreeHash(completeSource);var completeProfile=BackportDiscovery.Generate(completeSource,identity,"4.51","kstuff","FPKG",completeHash);
var completePreparation=Pipeline.PrepareBackport(completeSource,Path.Combine(root,"complete-backport"),"FPKG",identity,Files.BaseTreeHash(completeSource),completeProfile);
var suppliedFiles=Files.Enumerate(Path.Combine(completeSource,"backport")).ToDictionary(file=>Path.GetRelativePath(Path.Combine(completeSource,"backport"),file).Replace('\\','/'),file=>file,StringComparer.OrdinalIgnoreCase);
Check(completeProfile.RequiredFiles is not null&&completeProfile.RequiredFiles.Length==suppliedFiles.Count
    &&completeProfile.RequiredFiles.All(file=>suppliedFiles.TryGetValue(file.Path,out var sourceFile)&&Files.Hash(sourceFile)==file.Sha256&&Files.Hash(Path.Combine(completePreparation.ShadowMountBackport.OutputPath,file.Path.Replace('/',Path.DirectorySeparatorChar)))==file.Sha256)
    &&!Directory.Exists(Path.Combine(unpacked,"backport"))&&Modules.ToElf(File.ReadAllBytes(Path.Combine(unpacked,"eboot.bin"))).AsSpan().SequenceEqual(elf)
    &&Files.TreeHash(completeSource)==completeHash,"Complete supplied backport tree is exact-hash bound, copied outside the clean FPKG and leaves the dump unchanged");
using(var image=new UFS2Tool.Ufs2Image(ufs.OutputPath,readOnly:true)) {
    Check(!image.Find("libsample.sprx","/","f").Any(),"Native-compatible ShadowMount download excludes backport libraries");
    Check(!image.Find("libexclusive.sprx","/","f").Any(),"Native-compatible ShadowMount download excludes fakelib2");
    Check(!image.Find("separate.pkg","/","f").Any(),"ShadowMount image excludes separate DLC packages");
    Check(!image.Find("patched.bin","/","f").Any(),"ShadowMount image excludes supplied backport folders");
}
foreach(var built in new[]{pkg,ufs}) {
    var backport=built.ShadowMountBackport??throw new Exception("Missing separate ShadowMount backport");
    Check(Files.TreeHash(backport.OutputPath)==backport.Sha256 && backport.Size==fake.Length*2,"Separate backport hash and size");
    Check(File.ReadAllBytes(Path.Combine(backport.OutputPath,"fakelib","libsample.sprx")).AsSpan().SequenceEqual(fake),"Separate fakelib preserved byte for byte");
    Check(File.ReadAllBytes(Path.Combine(backport.OutputPath,"fakelib2","libexclusive.sprx")).AsSpan().SequenceEqual(fake),"Separate fakelib2 preserved byte for byte");
}
Check(Files.TreeHash(source) == originalHash, "Original source unchanged");
Check(BinaryPrimitives.ReadUInt32LittleEndian(File.ReadAllBytes(Path.Combine(source,"sce_module","liblegacy.prx")))==LibProsperoPkg.Content.ProsperoFself.OrbisMagic&&File.ReadAllText(Path.Combine(source,"sce_sys","pfs-version.dat"))=="00.000.000","GP5 preparation leaves source SELF and stale service metadata untouched");
var sourceBackportRoot=Path.Combine(source,"backport");var sourceBackportFiles=Files.Enumerate(sourceBackportRoot).Select(file=>new BackportFile(Path.GetRelativePath(sourceBackportRoot,file).Replace('\\','/'),Files.Hash(file))).ToArray();
var profile=new BackportProfile("11111111-1111-4111-8111-111111111111",identity.TitleId,identity.ContentId,identity.Version,new[]{originalHash},"4.51","kstuff","FPKG","TESTED",
    new[]{new BackportLibrary("fakelib/libsample.sprx",Files.Hash(Path.Combine(source,"fakelib","libsample.sprx")))},Array.Empty<BackportPatch>(),RequiredFiles:sourceBackportFiles);
var integratedSource=Path.Combine(root,"integrated-source");Files.CopyTree(source,integratedSource);Directory.Delete(Path.Combine(integratedSource,"fakelib"),true);Directory.Delete(Path.Combine(integratedSource,"fakelib2"),true);Directory.Delete(Path.Combine(integratedSource,"backport"),true);
var integratedHash=Files.TreeHash(integratedSource);var integrated=profile with {InputHashes=new[]{integratedHash},RequiredLibraries=Array.Empty<BackportLibrary>(),RequiredFiles=Array.Empty<BackportFile>(),Delivery="INTEGRATED"};
Backports.Validate(integrated,integratedSource,integratedHash,identity,"FPKG");Check(Backports.Digest(integrated)!=Backports.Digest(profile),"Integrated compatibility is distinct from an external overlay");
var integratedVariant=Pipeline.Build(integratedSource,Path.Combine(root,"integrated-pkg"),"FPKG",identity,profile:integrated,profileInputHash:integratedHash);
Check(integratedVariant.ProfileId==integrated.Id&&integratedVariant.ShadowMountBackport is null,"Integrated compatibility stays inside the package and creates no overlay");
var variant=Pipeline.Build(source,Path.Combine(root,"backported-pkg"),"FPKG",identity,profile:profile);
var variantFiles=Path.Combine(root,"variant-readback");LibProsperoPkg.PKG.ProsperoPackageArchive.ExtractInnerFiles(variant.OutputPath,variantFiles,new string('0',32));
Check(!Directory.Exists(Path.Combine(variantFiles,"fakelib")),"Matched library stays outside the reusable FPKG");
Check(Files.Hash(Path.Combine(variant.ShadowMountBackport!.OutputPath,"fakelib","libsample.sprx"))==profile.RequiredLibraries[0].Sha256,"Matched library is in the installed-PKG overlay");
Check(!Directory.Exists(Path.Combine(variantFiles,"fakelib2")),"Unselected exclusive libraries stay outside the package");
Check(variant.ProfileId==profile.Id&&variant.ProfileHash==Backports.Digest(profile),"Variant records the applied profile and its content hash");
Reject(()=>Pipeline.Build(source,Path.Combine(root,"wrong-profile"),"FPKG",identity,profile:profile with {InputHashes=new[]{new string('a',64)}}),"PROFILE_MISMATCH");
Reject(()=>Pipeline.Build(source,Path.Combine(root,"bad-library"),"FPKG",identity,profile:profile with {RequiredLibraries=new[]{new BackportLibrary("fakelib/libsample.sprx",new string('a',64))}}),"BACKPORT_FILES_MISMATCH");
Reject(()=>Pipeline.Build(source,Path.Combine(root,"missing-library"),"FPKG",identity,profile:profile with {RequiredLibraries=new[]{new BackportLibrary("fakelib/missing.sprx",new string('a',64))}}),"BACKPORT_FILES_MISSING");
Check(Files.TreeHash(source)==originalHash,"Backport preparation never modifies the dump");
var patchVectors=JsonDocument.Parse(File.ReadAllText("worker/Tests/Fixtures/patches.json")).RootElement;
var patchedElf=elf.ToArray();patchedElf[129]=0x90;var patchedLibrary=Modules.FakeSign(patchedElf);
var patchBytes=Convert.FromBase64String(patchVectors.GetProperty("module").GetString()!);
string Sha(byte[] bytes)=>Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes));
var automaticProfile=JsonSerializer.Deserialize<BackportProfile>(JsonSerializer.Serialize(new {
    profile.Id,profile.TitleId,profile.ContentId,profile.GameVersion,profile.InputHashes,profile.TargetFirmware,profile.Runtime,profile.InstallationMethod,profile.TestedState,profile.RequiredFiles,
    RequiredLibraries=new[]{new {Path="fakelib/libsample.sprx",Sha256=Sha(patchedLibrary)}},
    RequiredPatches=new[]{new {Path="fakelib/libsample.sprx",InputSha256=Sha(fake),OutputSha256=Sha(patchedLibrary),Bps=new {Data=Convert.ToBase64String(patchBytes),Sha256=Sha(patchBytes)},OutputFormat="FSELF"}}
}),PS5Library.Worker.Program.JsonOptions)!;
var automatic=Pipeline.Build(source,Path.Combine(root,"automatic-patch"),"FPKG",identity,profile:automaticProfile);
var overlayOnly=Pipeline.PrepareBackport(source,Path.Combine(root,"overlay-only"),"FPKG",identity,baseHash,automaticProfile);
Check(overlayOnly.InputHash==baseHash&&overlayOnly.ProfileId==automaticProfile.Id&&Files.Hash(Path.Combine(overlayOnly.ShadowMountBackport.OutputPath,"fakelib","libsample.sprx"))==Sha(patchedLibrary),"An existing clean package can prepare only its exact external overlay");
Check(!Directory.EnumerateFiles(Path.Combine(root,"overlay-only"),"*.pkg",SearchOption.AllDirectories).Any(),"Overlay-only preparation does not rebuild the package");
var automaticFiles=Path.Combine(root,"automatic-readback");LibProsperoPkg.PKG.ProsperoPackageArchive.ExtractInnerFiles(automatic.OutputPath,automaticFiles,new string('0',32));
Check(!Directory.Exists(Path.Combine(automaticFiles,"fakelib")),"Patched libraries stay outside the reusable FPKG");
Check(Files.Hash(Path.Combine(automatic.ShadowMountBackport!.OutputPath,"fakelib","libsample.sprx"))==Sha(patchedLibrary),"BPS patch and fake signing are automatic inside the external overlay");
Check(Files.TreeHash(source)==originalHash,"Automatic patches preserve the original dump");
var unsignedProfile=automaticProfile with {RequiredLibraries=new[]{new BackportLibrary("fakelib/libsample.sprx",Sha(patchedElf))},RequiredPatches=new[]{automaticProfile.RequiredPatches[0] with {OutputFormat="ELF",OutputSha256=Sha(patchedElf)}}};
var unsigned=Pipeline.Build(source,Path.Combine(root,"explicit-elf-overlay"),"FPKG",identity,profile:unsignedProfile);
Check(Files.Hash(Path.Combine(unsigned.ShadowMountBackport!.OutputPath,"fakelib","libsample.sprx"))==Sha(patchedElf),"Explicit ELF overlay output is preserved without package-builder transforms");
var gamePatch=new BackportPatch("eboot.bin",Sha(elf),Sha(patchedElf),new(Convert.ToBase64String(patchBytes),Sha(patchBytes)),OutputFormat:"ELF");
var shadowProfile=automaticProfile with {InstallationMethod="SHADOWMOUNT",RequiredPatches=automaticProfile.RequiredPatches.Append(gamePatch).ToArray()};
var patchedImage=Pipeline.Build(source,Path.Combine(root,"automatic-image"),"SHADOWMOUNT",identity,profile:shadowProfile);
Check(Files.Hash(Path.Combine(patchedImage.ShadowMountBackport!.OutputPath,"fakelib","libsample.sprx"))==Sha(patchedLibrary),"ShadowMount publishes the automatically patched library separately");
Check(Files.Hash(Path.Combine(patchedImage.ShadowMountBackport.OutputPath,"eboot.bin"))==Sha(patchedElf),"ShadowMount publishes patched game executables in the external title overlay");
var shadowMetadata=JsonDocument.Parse(File.ReadAllText(Path.Combine(patchedImage.ShadowMountBackport.OutputPath,"sce_sys","param.json"))).RootElement;
Check(shadowMetadata.GetProperty("requiredSystemSoftwareVersion").GetString()=="0x0451000000000000"&&shadowMetadata.GetProperty("sdkVersion").GetString()=="0x0400000000000000","ShadowMount publishes the exact target firmware and selected SDK family");
using(var cleanImage=new UFS2Tool.Ufs2Image(patchedImage.OutputPath,readOnly:true)) {
    var imageEboot=cleanImage.Find("eboot.bin","/","f").Single(e=>e.Path=="/eboot.bin");
    Check(cleanImage.ReadFile(imageEboot.Inode).AsSpan().SequenceEqual(elf),"ShadowMount keeps the reusable image executable clean");
}
var externalProfile=shadowProfile with {InstallationMethod="FPKG"};
var externalPackage=Pipeline.Build(source,Path.Combine(root,"external-package"),"FPKG",identity,profile:externalProfile);
var externalReadback=Path.Combine(root,"external-package-readback");LibProsperoPkg.PKG.ProsperoPackageArchive.ExtractInnerFiles(externalPackage.OutputPath,externalReadback,new string('0',32));
Check(Modules.ToElf(File.ReadAllBytes(Path.Combine(externalReadback,"eboot.bin"))).AsSpan().SequenceEqual(elf),"Installed-PKG overlay keeps the reusable package executable clean");
Check(!Directory.Exists(Path.Combine(externalReadback,"fakelib")),"Installed-PKG overlay keeps compatibility libraries outside app0");
Check(Files.Hash(Path.Combine(externalPackage.ShadowMountBackport!.OutputPath,"eboot.bin"))==Sha(patchedElf),"Installed-PKG overlay carries the patched executable");
Check(Files.Hash(Path.Combine(externalPackage.ShadowMountBackport.OutputPath,"fakelib","libsample.sprx"))==Sha(patchedLibrary),"Installed-PKG overlay carries the selected compatibility library");
Check(InputInspector.ReadIdentity(File.ReadAllBytes(Path.Combine(externalPackage.ShadowMountBackport.OutputPath,"sce_sys","param.json"))).MinimumFirmware=="4.51","Installed-PKG overlay carries target metadata");
Check(System.Text.Encoding.ASCII.GetString(BinaryPatches.ApplyBps("ABCDEFGH"u8.ToArray(),Convert.FromBase64String(patchVectors.GetProperty("allActions").GetString()!)))=="ABCxyxyxyxyGHABABC","Independent BPS vector covers all actions, overlap and negative offsets");
Reject(()=>BinaryPatches.ApplyBps("ABCDEFGH"u8.ToArray(),Convert.FromBase64String(patchVectors.GetProperty("forwardCopy").GetString()!)),"BACKPORT_PATCH_CORRUPT");
Reject(()=>BinaryPatches.ApplyBps("ABCDEFGH"u8.ToArray(),Convert.FromBase64String(patchVectors.GetProperty("oversize").GetString()!)),"INPUT_TOO_LARGE");
var damagedPatch=patchBytes.ToArray();damagedPatch[^1]^=1;
Reject(()=>BinaryPatches.ApplyBps(elf,damagedPatch),"BACKPORT_PATCH_CORRUPT");
Reject(()=>BinaryPatches.ApplyBps(patchedElf,patchBytes),"BACKPORT_PATCH_INPUT_MISMATCH");
Reject(()=>BinaryPatches.ApplyBps(elf,Convert.FromBase64String(patchVectors.GetProperty("wrongOutputCrc").GetString()!)),"BACKPORT_PATCH_OUTPUT_MISMATCH");
var expansion=Convert.FromBase64String(patchVectors.GetProperty("expansion").GetString()!);
var expanded="ABCDEFGH"u8.ToArray().Concat(Enumerable.Repeat((byte)'Z',65537)).ToArray();
Reject(()=>BinaryPatches.Apply("ABCDEFGH"u8.ToArray(),new("sample.bin",Sha("ABCDEFGH"u8.ToArray()),Sha(expanded),new(Convert.ToBase64String(expansion),Sha(expansion)))),"BACKPORT_PATCH_EXPANSION_UNSUPPORTED");
Reject(()=>BinaryPatches.Apply(fake,automaticProfile.RequiredPatches[0] with {OutputSha256=new string('0',64)}),"BACKPORT_PATCH_OUTPUT_MISMATCH");
Check(BinaryPatches.Apply(patchedLibrary,automaticProfile.RequiredPatches[0]).AsSpan().SequenceEqual(patchedLibrary),"Already-patched exact output is idempotent");
var sdkElf=elf.ToArray();BinaryPrimitives.WriteUInt16LittleEndian(sdkElf.AsSpan(56),2);
BinaryPrimitives.WriteUInt32LittleEndian(sdkElf.AsSpan(120),0x61000001);BinaryPrimitives.WriteUInt64LittleEndian(sdkElf.AsSpan(128),512);
BinaryPrimitives.WriteUInt64LittleEndian(sdkElf.AsSpan(152),48);BinaryPrimitives.WriteUInt32LittleEndian(sdkElf.AsSpan(512),48);
BinaryPrimitives.WriteUInt32LittleEndian(sdkElf.AsSpan(520),0x4942524f);BinaryPrimitives.WriteUInt32LittleEndian(sdkElf.AsSpan(528),0x12090001);BinaryPrimitives.WriteUInt32LittleEndian(sdkElf.AsSpan(532),0x10000040);
var sdkExpected=sdkElf.ToArray();BinaryPrimitives.WriteUInt32LittleEndian(sdkExpected.AsSpan(528),0x09040001);BinaryPrimitives.WriteUInt32LittleEndian(sdkExpected.AsSpan(532),0x04000031);
var sdkRecipe=new BackportPatch("eboot.bin",Sha(Modules.FakeSign(sdkElf)),Sha(Modules.FakeSign(sdkExpected)),Sdk:new(0x04000031,0x09040001),OutputFormat:"FSELF");
Check(Modules.ToElf(BinaryPatches.Apply(Modules.FakeSign(sdkElf),sdkRecipe)).AsSpan().SequenceEqual(sdkExpected),"System SDK fields are patched between verified SELF decoding and fake signing");
var olderSdk=sdkElf.ToArray();BinaryPrimitives.WriteUInt32LittleEndian(olderSdk.AsSpan(528),0x08050001);BinaryPrimitives.WriteUInt32LittleEndian(olderSdk.AsSpan(532),0x02000009);
Check(BinaryPatches.PatchSdk(olderSdk,sdkRecipe.Sdk!).AsSpan().SequenceEqual(olderSdk),"Backport SDK patching never raises an older module requirement");
var sdkPresets=new Dictionary<int,ElfSdk>{
    [1]=new(0x01000050,0x07590001),[2]=new(0x02000009,0x08050001),[3]=new(0x03000027,0x08540001),[4]=new(0x04000031,0x09040001),[5]=new(0x05000033,0x09590001),
    [6]=new(0x06000038,0x10090001),[7]=new(0x07000038,0x10590001),[8]=new(0x08000041,0x11090001),[9]=new(0x09000040,0x11590001),[10]=new(0x10000040,0x12090001),
};
foreach(var preset in sdkPresets)Check(BackportDiscovery.SdkForFirmware($"{preset.Key}.99")==preset.Value,$"Firmware {preset.Key}.x resolves its verified SDK pair");
Reject(()=>BackportDiscovery.SdkForFirmware("11.00"),"BACKPORT_TARGET_UNVERIFIED");
Reject(()=>BinaryPatches.PatchSdk(elf,sdkRecipe.Sdk!),"BACKPORT_SDK_RECORD_MISSING");
var badSdk=sdkElf.ToArray();badSdk[520]^=1;Reject(()=>BinaryPatches.PatchSdk(badSdk,sdkRecipe.Sdk!),"CORRUPT_INPUT");
BinaryPrimitives.WriteUInt64LittleEndian(badSdk.AsSpan(128),ulong.MaxValue);Reject(()=>BinaryPatches.PatchSdk(badSdk,sdkRecipe.Sdk!),"CORRUPT_INPUT");
var sdkSource=Path.Combine(root,"sdk-source");Files.CopyTree(source,sdkSource);File.WriteAllBytes(Path.Combine(sdkSource,"eboot.bin"),Modules.FakeSign(sdkElf));
var discoverySource=Path.Combine(root,"discovery-source");Files.CopyTree(sdkSource,discoverySource);Directory.Delete(Path.Combine(discoverySource,"fakelib2"),true);Directory.Delete(Path.Combine(discoverySource,"backport"),true);
var lockedAsset=Path.Combine(discoverySource,"unrelated-game-data.pak");File.WriteAllBytes(lockedAsset,new byte[4096]);
var discoveryHash=Files.TreeHash(discoverySource);
BackportProfile discovered;using(var locked=File.Open(lockedAsset,FileMode.Open,FileAccess.Read,FileShare.None))discovered=BackportDiscovery.Generate(discoverySource,identity,"4.51","kstuff","FPKG",discoveryHash);
Check(discovered.TestedState=="UNTESTED"&&discovered.InputHashes.SequenceEqual(new[]{discoveryHash}),"Generated profile is exact-input and never claims testing");
Reject(()=>BackportDiscovery.Generate(discoverySource,identity,"4.51","kstuff","FPKG","not-a-hash"),"PROFILE_MISMATCH");
var discoveryArchive=Path.Combine(root,"discovery.zip");ZipFile.CreateFromDirectory(discoverySource,discoveryArchive);
var archiveHash=Archives.Hash(discoveryArchive).Sha256;
var archiveProfile=BackportDiscovery.GenerateArchive(discoveryArchive,Path.Combine(root,"profile-extraction"),identity,"4.51","kstuff","FPKG",archiveHash,1024*1024);
Check(archiveProfile.InputHashes.SequenceEqual(new[]{archiveHash})&&!Directory.Exists(Path.Combine(root,"profile-extraction")),"Archive profile discovery binds the immutable archive digest and removes staging");
Check(discovered.RequiredLibraries.Length==1&&discovered.RequiredLibraries[0].Path=="fakelib/libsample.sprx"&&discovered.RequiredLibraries[0].Sha256==Files.Hash(Path.Combine(discoverySource,"fakelib","libsample.sprx")),"Generated profile binds supplied fakelib by path and hash");
var oversizedSource=Path.Combine(root,"oversized-source");Files.CopyTree(discoverySource,oversizedSource);var oversizedEboot=Path.Combine(oversizedSource,"eboot.bin");
var exactOnlyLibrary=fake.ToArray();exactOnlyLibrary[^1]^=1;File.WriteAllBytes(Path.Combine(oversizedSource,"fakelib","libsample.sprx"),exactOnlyLibrary);Reject(()=>Modules.ToElf(exactOnlyLibrary),"UNSUPPORTED_INPUT");
var unresignableLibrary=elf.ToArray();BinaryPrimitives.WriteUInt64LittleEndian(unresignableLibrary.AsSpan(40),4090);BinaryPrimitives.WriteUInt16LittleEndian(unresignableLibrary.AsSpan(58),64);BinaryPrimitives.WriteUInt16LittleEndian(unresignableLibrary.AsSpan(60),1);File.WriteAllBytes(Path.Combine(oversizedSource,"fakelib","unresignable.sprx"),unresignableLibrary);
using(var oversized=File.Open(oversizedEboot,FileMode.Create,FileAccess.Write)){oversized.Write(new byte[]{0x7f,69,76,70,2,1,1});oversized.SetLength(BinaryPatches.MaximumModule+1L);}
var oversizedHash=new string('b',64);BackportProfile oversizedProfile;
try{oversizedProfile=BackportDiscovery.Generate(oversizedSource,identity,"4.51","kstuff","FPKG",oversizedHash);}finally{File.Delete(oversizedEboot);}
Check(oversizedProfile.TestedState=="UNTESTED"&&oversizedProfile.TitleId==identity.TitleId&&oversizedProfile.ContentId==identity.ContentId&&oversizedProfile.GameVersion==identity.Version&&oversizedProfile.TargetFirmware=="4.51"&&oversizedProfile.Runtime=="kstuff"&&oversizedProfile.InstallationMethod=="FPKG"&&oversizedProfile.InputHashes.SequenceEqual(new[]{oversizedHash}),"Supplied fakelib fallback stays untested and binds the exact release, input, firmware and runtime");
var oversizedLibraries=oversizedProfile.RequiredLibraries.ToDictionary(f=>f.Path);Check(oversizedLibraries.Count==2&&oversizedLibraries["fakelib/libsample.sprx"].Sha256==Sha(exactOnlyLibrary)&&oversizedLibraries["fakelib/unresignable.sprx"].Sha256==Sha(unresignableLibrary)&&!oversizedProfile.RequiredPatches.Any(),"Supplied fakelib fallback preserves exact libraries and never patches unsupported or oversized modules");
Directory.Delete(Path.Combine(oversizedSource,"fakelib"),true);Directory.CreateDirectory(Path.Combine(oversizedSource,"fakelib"));File.WriteAllText(Path.Combine(oversizedSource,"fakelib","junk.sprx"),"not a module");
using(var oversized=File.Open(oversizedEboot,FileMode.Create,FileAccess.Write)){oversized.Write(new byte[]{0x7f,69,76,70,2,1,1});oversized.SetLength(BinaryPatches.MaximumModule+1L);}
try{Reject(()=>BackportDiscovery.Generate(oversizedSource,identity,"4.51","kstuff","FPKG",oversizedHash),"BACKPORT_FILES_MISSING");}finally{File.Delete(oversizedEboot);}
Directory.Delete(Path.Combine(oversizedSource,"fakelib"),true);using(var oversized=File.Open(oversizedEboot,FileMode.Create,FileAccess.Write)){oversized.Write(new byte[]{0x7f,69,76,70,2,1,1});oversized.SetLength(BinaryPatches.MaximumModule+1L);}
try{Reject(()=>BackportDiscovery.Generate(oversizedSource,identity,"4.51","kstuff","FPKG",oversizedHash),"INPUT_TOO_LARGE");}finally{File.Delete(oversizedEboot);}
var discoveredPatch=discovered.RequiredPatches.Single(p=>p.Path=="eboot.bin");
Check(Modules.ToElf(BinaryPatches.Apply(File.ReadAllBytes(Path.Combine(discoverySource,"eboot.bin")),discoveredPatch)).AsSpan().SequenceEqual(sdkExpected),"Discovered executable recipe patches SDK and re-signs deterministically");
Check(Files.TreeHash(discoverySource)==discoveryHash,"Profile discovery never modifies source content");
var conflictingLibraries=Path.Combine(root,"conflicting-libraries");Files.CopyTree(sdkSource,conflictingLibraries);Directory.Delete(Path.Combine(conflictingLibraries,"backport"),true);Reject(()=>BackportDiscovery.Generate(conflictingLibraries,identity,"4.51","kstuff","FPKG"),"PROFILE_MISMATCH");
var unsupportedDiscovery=Path.Combine(root,"unsupported-discovery");Files.CopyTree(source,unsupportedDiscovery);Directory.Delete(Path.Combine(unsupportedDiscovery,"fakelib"),true);Directory.Delete(Path.Combine(unsupportedDiscovery,"fakelib2"),true);Directory.Delete(Path.Combine(unsupportedDiscovery,"backport"),true);
Reject(()=>BackportDiscovery.Generate(unsupportedDiscovery,identity,"4.51","kstuff","FPKG"),"BACKPORT_FILES_MISSING");
var rawLibrarySource=Path.Combine(root,"raw-library-source");Files.CopyTree(discoverySource,rawLibrarySource);File.WriteAllBytes(Path.Combine(rawLibrarySource,"fakelib","libsample.sprx"),elf);
var rawLibraryProfile=BackportDiscovery.Generate(rawLibrarySource,identity,"4.51","kstuff","FPKG");
Check(rawLibraryProfile.RequiredLibraries.Single().Sha256==Sha(fake)&&rawLibraryProfile.RequiredPatches.Any(p=>p.Path=="fakelib/libsample.sprx"&&p.OutputFormat=="FSELF"),"Raw ELF compatibility libraries are normalized to exact fake SELF output");
Pipeline.Build(rawLibrarySource,Path.Combine(root,"raw-library-build"),"FPKG",identity,profile:rawLibraryProfile);
var sdkBuild=Pipeline.Build(discoverySource,Path.Combine(root,"sdk-build"),"FPKG",identity,profile:discovered);var sdkReadback=Path.Combine(root,"sdk-readback");
LibProsperoPkg.PKG.ProsperoPackageArchive.ExtractInnerFiles(sdkBuild.OutputPath,sdkReadback,new string('0',32));
Check(Modules.ToElf(File.ReadAllBytes(Path.Combine(sdkReadback,"eboot.bin"))).AsSpan().SequenceEqual(sdkElf),"Reusable package keeps the original executable");
Check(Modules.ToElf(File.ReadAllBytes(Path.Combine(sdkBuild.ShadowMountBackport!.OutputPath,"eboot.bin"))).AsSpan().SequenceEqual(sdkExpected),"SDK patch survives external overlay read-back");
Check(Files.TreeHash(discoverySource)==discoveryHash,"SDK patch never modifies the original executable");
Check(Modules.ToElf(fake).AsSpan().SequenceEqual(elf), "FSELF round trip");
Console.WriteLine(JsonSerializer.Serialize(new { passed=true, checks=new[]{"identity mismatch","zip traversal","UFS build/read","FPKG build/readback","separate ShadowMount libraries","immutable source","FSELF round-trip","automatic BPS and SDK patches","clean-room profile discovery","BPS bounds, CRCs and overlap","clean package plus external overlay readback","patch growth reservation"}, ufs=ufs.OutputPath, pkg=pkg.OutputPath }));

sealed class CaptureNapsIntegrityProvider : LibProsperoPkg.PKG.IProsperoNapsIntegrityProvider
{
    public LibProsperoPkg.PKG.ProsperoNapsIntegrityContext? Context { get; private set; }
    public byte[]? BuildIhshPrefixes(LibProsperoPkg.PKG.ProsperoNapsIntegrityContext context){Context=context;return null;}
    public byte[]? BuildRollingHashes(LibProsperoPkg.PKG.ProsperoNapsIntegrityContext context){Context=context;return null;}
    public byte[]? BuildOuterBlockCheckCodes(LibProsperoPkg.PKG.ProsperoNapsIntegrityContext context){Context=context;return null;}
}

sealed class TriggerWriter(Action<string> trigger) : StringWriter
{
    public override void WriteLine(string? value){if(value is not null)trigger(value);base.WriteLine(value);}
}
