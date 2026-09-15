using System.Buffers.Binary;
using System.Text.Json;
using System.Text.RegularExpressions;
using LibProsperoPkg.PKG;
using UFS2Tool;
namespace PS5Library.Worker;
public static class InputInspector
{
    public static Identity ReadIdentity(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length > 2*1024*1024) throw new WorkerError("CORRUPT_INPUT");
        using var json = JsonDocument.Parse(bytes.ToArray()); var root = json.RootElement;
        string Get(string key) => root.TryGetProperty(key,out var value) && value.ValueKind == JsonValueKind.String ? value.GetString()! : "";
        var titleId=Get("titleId"); var contentId=Get("contentId"); var version=Get("contentVersion");
        if (version == "") version=Get("masterVersion");
        if (!Regex.IsMatch(titleId,"^[A-Z]{4}[0-9]{5}$") || !Regex.IsMatch(contentId,"^[A-Z]{2}[0-9]{4}-[A-Z]{4}[0-9]{5}_[0-9]{2}-[A-Z0-9]{16}$") || contentId.Substring(7,9)!=titleId || !Regex.IsMatch(version,"^[0-9]{2}\\.[0-9]{2}(?:\\.[0-9]{3})?$")) throw new WorkerError("CORRUPT_INPUT","Invalid package identity");
        var title=titleId;
        if (root.TryGetProperty("localizedParameters",out var localized))
            foreach (var lang in localized.EnumerateObject())
                if (lang.Value.ValueKind==JsonValueKind.Object && lang.Value.TryGetProperty("titleName",out var name)) { title=name.GetString()??titleId; break; }
        return new(titleId,contentId,version,title);
    }
    public static Inspection Inspect(string input, Identity? expected=null)
    {
        try { var result=InspectCore(input); if (expected is not null && result.Identity is { } actual && (actual.TitleId!=expected.TitleId || actual.ContentId!=expected.ContentId || actual.Version!=expected.Version)) throw new WorkerError("METADATA_MISMATCH"); return result; }
        catch (WorkerError) { throw; }
        catch (FileNotFoundException) { throw new WorkerError("INCOMPLETE_INPUT"); }
        catch (Exception e) when (e is InvalidDataException or EndOfStreamException or JsonException or OverflowException or ArgumentException) { throw new WorkerError("CORRUPT_INPUT",e.Message); }
    }
    static Inspection InspectCore(string input)
    {
        if (Directory.Exists(input))
        {
            _=Files.Enumerate(input).Count();
            var param=Path.Combine(input,"sce_sys","param.json");
            if (!File.Exists(param) || !File.Exists(Path.Combine(input,"eboot.bin"))) throw new WorkerError("INCOMPLETE_INPUT","Prepared folders require sce_sys/param.json and eboot.bin");
            if (new FileInfo(param).Length>2*1024*1024) throw new WorkerError("CORRUPT_INPUT");
            return new("folder",true,true,ReadIdentity(File.ReadAllBytes(param)));
        }
        using var stream=File.OpenRead(input); if (stream.Length<4) throw new WorkerError("INCOMPLETE_INPUT");
        var header=new byte[64]; stream.ReadExactly(header.AsSpan(0,(int)Math.Min(64,stream.Length)));
        var magic=BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (magic==0x464c457f) return new("elf",true,false,null,Note:"ELF identity is supplied separately; no launch claim.");
        if (magic==0xeef51454) { if(stream.Length>512*1024*1024) throw new WorkerError("UNSUPPORTED_INPUT"); _=Modules.ToElf(File.ReadAllBytes(input)); return new("fself",true,false,null); }
        if (magic==0x4849467f || magic==0x544e437f)
        {
            var pkg=ProsperoPkgReader.Read(input);
            if (pkg.Fih?.IsOfficial==true) throw new WorkerError("ENCRYPTED_INPUT","Retail input requires an authorized decrypted dump; no keys are inferred.");
            var report=ProsperoPkgValidator.Validate(pkg);
            if (!report.Accepted) throw new WorkerError("CORRUPT_INPUT",string.Join("; ",report.Checks.Where(c=>c.Status==ProsperoCheckStatus.Fail).Select(c=>c.Detail)));
            var entry=pkg.Entries.SingleOrDefault(e=>e.Id==ProsperoEntryId.ParamJson)??throw new WorkerError("INCOMPLETE_INPUT","param.json missing");
            if(entry.Encrypted) throw new WorkerError("ENCRYPTED_INPUT");
            if(entry.DataSize>2*1024*1024) throw new WorkerError("CORRUPT_INPUT");
            stream.Position=checked((long)(pkg.Fih?.EmbeddedCntOffset??0)+entry.DataOffset);
            var bytes=new byte[entry.DataSize]; stream.ReadExactly(bytes);
            return new("pkg",true,true,ReadIdentity(bytes),Note:"Structural acceptance only; console installation and launch untested.");
        }
        if(stream.Length>Ufs2Constants.SuperblockOffset+0x560)
        {
            stream.Position=Ufs2Constants.SuperblockOffset+0x55c; Span<byte> bytes=stackalloc byte[4]; stream.ReadExactly(bytes);
            if(BinaryPrimitives.ReadInt32LittleEndian(bytes) is Ufs2Constants.Ufs2Magic or Ufs2Constants.Ufs1Magic)
            {
                stream.Close(); using var image=new Ufs2Image(input,readOnly:true);
                var check=image.FsckUfs(); if(!check.Clean) throw new WorkerError("CORRUPT_INPUT",string.Join("; ",check.Errors));
                var param=image.Find("param.json","/sce_sys","f").SingleOrDefault(e=>e.Path=="/sce_sys/param.json")??throw new WorkerError("INCOMPLETE_INPUT","Image must have sce_sys/param.json directly at its root");
                if(param.Size>2*1024*1024) throw new WorkerError("CORRUPT_INPUT");
                return new("ffpkg",true,true,ReadIdentity(image.ReadFile(param.Inode)),Note:"UFS image validated on desktop; ShadowMount execution untested.");
            }
        }
        var name=Path.GetFileName(input);
        var multipart=Regex.Match(name,@"^(.*?)(?:\.part(\d+)\.rar|\.(?:7z|zip)\.(\d{3}))$",RegexOptions.IgnoreCase);
        if(multipart.Success) throw new WorkerError("UNSUPPORTED_INPUT","Multipart archives require an explicit complete part manifest; automatic extraction is disabled.");
        if(magic==0x04034b50) return new("zip",true,false,null,Note:"ZIP requires safe extraction and inspection before preparation.");
        throw new WorkerError("UNSUPPORTED_INPUT","No verified converter for this input signature.");
    }
}
