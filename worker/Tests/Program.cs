using System.Buffers.Binary;
using System.IO.Compression;
using System.Text.Json;
using PS5Library.Worker;

static void Check(bool value, string message) { if (!value) throw new Exception(message); }
static void Reject(Action action, string code) { try { action(); } catch (WorkerError e) when (e.Code == code) { return; } throw new Exception($"Expected {code}"); }
var root = Path.Combine(Path.GetTempPath(), "ps5library-worker-" + Guid.NewGuid());
var source = Path.Combine(root, "input"); Directory.CreateDirectory(Path.Combine(source,"sce_sys"));
var identity = new Identity("PPSA99999", "IV0000-PPSA99999_00-PS5LIBRARYDEMO00", "01.00", "PS5Library sample");
File.WriteAllText(Path.Combine(source,"sce_sys","param.json"), JsonSerializer.Serialize(new { titleId=identity.TitleId, contentId=identity.ContentId, contentVersion=identity.Version, masterVersion="01.00", localizedParameters=new { defaultLanguage="en-US", en_US=new { titleName=identity.Title } } }));
var elf = new byte[4096]; new byte[] { 0x7f,69,76,70,2,1,1 }.CopyTo(elf,0);
BinaryPrimitives.WriteUInt16LittleEndian(elf.AsSpan(16), 2); BinaryPrimitives.WriteUInt16LittleEndian(elf.AsSpan(18), 62);
BinaryPrimitives.WriteUInt32LittleEndian(elf.AsSpan(20), 1); BinaryPrimitives.WriteUInt64LittleEndian(elf.AsSpan(24), 0x400080);
BinaryPrimitives.WriteUInt64LittleEndian(elf.AsSpan(32), 64); BinaryPrimitives.WriteUInt16LittleEndian(elf.AsSpan(52), 64);
BinaryPrimitives.WriteUInt16LittleEndian(elf.AsSpan(54), 56); BinaryPrimitives.WriteUInt16LittleEndian(elf.AsSpan(56), 1);
BinaryPrimitives.WriteUInt32LittleEndian(elf.AsSpan(64), 1); BinaryPrimitives.WriteUInt32LittleEndian(elf.AsSpan(68), 5);
BinaryPrimitives.WriteUInt64LittleEndian(elf.AsSpan(80), 0x400000); BinaryPrimitives.WriteUInt64LittleEndian(elf.AsSpan(96), 4096);
BinaryPrimitives.WriteUInt64LittleEndian(elf.AsSpan(104), 4096); BinaryPrimitives.WriteUInt64LittleEndian(elf.AsSpan(112), 4096); elf[128] = 0xc3;
File.WriteAllBytes(Path.Combine(source,"eboot.bin"), elf);
var originalHash = Files.TreeHash(source);
Check(InputInspector.Inspect(source).Identity?.TitleId == identity.TitleId, "Folder identity");
Reject(() => InputInspector.Inspect(source, identity with { TitleId="PPSA11111" }), "METADATA_MISMATCH");
Reject(() => Pipeline.Build(source,Path.Combine(root,"understated"),"FPKG",identity,expectedSize:1),"CORRUPT_INPUT");
var badZip = Path.Combine(root,"bad.zip");
using (var archive = ZipFile.Open(badZip,ZipArchiveMode.Create)) { using var writer = new StreamWriter(archive.CreateEntry("../escaped.txt").Open()); writer.Write("bad"); }
Reject(() => SafeExtract.Zip(badZip,Path.Combine(root,"extract"),100000), "UNSAFE_PATH");
var ufs = Pipeline.Build(source, Path.Combine(root,"ufs"), "SHADOWMOUNT", identity);
Check(ufs.Format == "ffpkg" && ufs.Size > 0 && ufs.Sha256.Length == 64, "Real UFS build");
Check(InputInspector.Inspect(ufs.OutputPath, identity).Identity?.TitleId == identity.TitleId, "UFS embedded metadata");
var pkg = Pipeline.Build(source,Path.Combine(root,"pkg"),"FPKG",identity);
Check(pkg.Format == "pkg" && InputInspector.Inspect(pkg.OutputPath,identity).StructurallyRecognized, "Real PKG build and inspection");
Check(Files.TreeHash(source) == originalHash, "Original source unchanged");
var fake = Modules.FakeSign(elf); Check(Modules.ToElf(fake).AsSpan().SequenceEqual(elf), "FSELF round trip");
Console.WriteLine(JsonSerializer.Serialize(new { passed=true, checks=new[]{"identity mismatch","zip traversal","UFS build/read","FPKG build/validate","immutable source","FSELF round-trip"}, ufs=ufs.OutputPath, pkg=pkg.OutputPath }));
