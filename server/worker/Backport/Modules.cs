using System.Buffers.Binary;
using LibProsperoPkg.Content;
namespace PS5Library.Worker;
public static class Modules
{
    public static byte[] FakeSign(byte[] elf)=>ProsperoFself.MakeFself(elf);
    public static byte[] ToElf(byte[] self)
    {
        if(ProsperoFself.IsElf(self)) return self.ToArray();
        var image=ProsperoFself.Parse(self);
        if(image.Segments.Any(s=>s.Encrypted)) throw new WorkerError("ENCRYPTED_INPUT");
        if(image.Segments.Any(s=>s.Compressed) || image.ExtInfo is null) throw new WorkerError("UNSUPPORTED_INPUT","Only plaintext SELF with a verifiable ELF digest is supported.");
        var parts=image.Segments.Where(s=>(s.Flags&0x800)!=0).ToArray();
        long length=image.Elf.Length;
        foreach(var part in parts) { var header=checked(64+part.Id*56); if(header+56>image.Elf.Length) throw new WorkerError("CORRUPT_INPUT"); var offset=BinaryPrimitives.ReadUInt64LittleEndian(image.Elf.AsSpan(header+8)); length=Math.Max(length,checked((long)(offset+part.FileSize))); }
        // ponytail: bound module reconstruction to 512 MiB; use file-backed segments for larger modules.
        if(length>512*1024*1024) throw new WorkerError("INPUT_TOO_LARGE");
        var elf=new byte[length]; image.Elf.CopyTo(elf,0);
        foreach(var part in parts) { var offset=BinaryPrimitives.ReadUInt64LittleEndian(image.Elf.AsSpan(64+part.Id*56+8)); if(part.FileOffset+part.FileSize>(ulong)self.Length) throw new WorkerError("CORRUPT_INPUT"); self.AsSpan(checked((int)part.FileOffset),checked((int)part.FileSize)).CopyTo(elf.AsSpan(checked((int)offset))); }
        if(image.ExtInfo is not null && !System.Security.Cryptography.SHA256.HashData(elf).AsSpan().SequenceEqual(image.ExtInfo.Digest)) throw new WorkerError("UNSUPPORTED_INPUT","SELF omits data needed for a lossless ELF reconstruction.");
        return elf;
    }
}
