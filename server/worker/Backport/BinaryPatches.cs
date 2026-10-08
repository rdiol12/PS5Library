using System.Buffers.Binary;
using System.Security.Cryptography;
namespace PS5Library.Worker;

public static class BinaryPatches
{
    // ponytail: bounded in-memory modules match the server's 512 MiB backport-file ceiling; use file-backed patching before raising it.
    public const int MaximumModule=512*1024*1024,MaximumPatch=64*1024,MaximumGrowth=64*1024;
    static string Sha(byte[] data)=>Convert.ToHexStringLower(SHA256.HashData(data));
    public static bool Automatic(BackportPatch p)=>p.Bps is not null||p.Sdk is not null||p.OutputFormat is not null;
    public static byte[]? ValidateRecipe(BackportPatch p)
    {
        if(p.OutputFormat is not null and not "ELF" and not "FSELF"||p.Sdk is not null&&(p.OutputFormat is null||p.Sdk.Ps5==0||p.Sdk.Ps4==0))throw new WorkerError("PROFILE_MISMATCH");
        if(p.Bps is null)return null;
        if(p.Bps.Data.Length>87384)throw new WorkerError("INPUT_TOO_LARGE");
        byte[] bytes;try{bytes=Convert.FromBase64String(p.Bps.Data);}catch(FormatException){throw new WorkerError("BACKPORT_PATCH_CORRUPT");}
        if(bytes.Length>MaximumPatch||Convert.ToBase64String(bytes)!=p.Bps.Data||Sha(bytes)!=p.Bps.Sha256)throw new WorkerError("BACKPORT_PATCH_CORRUPT");
        CheckPatch(bytes);return bytes;
    }
    public static byte[] Apply(byte[] input,BackportPatch recipe)
    {
        var patch=ValidateRecipe(recipe);
        if(input.Length>MaximumModule)throw new WorkerError("INPUT_TOO_LARGE");
        var hash=Sha(input);if(hash==recipe.OutputSha256)return input;
        if(hash!=recipe.InputSha256)throw new WorkerError("BACKPORT_PATCH_INPUT_MISMATCH");
        if(!Automatic(recipe))throw new WorkerError("BACKPORT_PATCH_MISSING");
        var result=recipe.OutputFormat is null?input:Modules.ToElf(input);
        if(result.Length>MaximumModule)throw new WorkerError("INPUT_TOO_LARGE");
        if(patch is not null)result=ApplyBps(result,patch);
        if(recipe.Sdk is not null)result=PatchSdk(result,recipe.Sdk);
        if(recipe.OutputFormat=="FSELF")result=Modules.FakeSign(result);
        // Reserve this ceiling before starting a job; larger growth needs explicit size-aware reservations.
        if(result.Length-input.Length>MaximumGrowth)throw new WorkerError("BACKPORT_PATCH_EXPANSION_UNSUPPORTED");
        if(result.Length>MaximumModule||Sha(result)!=recipe.OutputSha256)throw new WorkerError("BACKPORT_PATCH_OUTPUT_MISMATCH");
        return result;
    }
    static readonly uint[] CrcTable=Enumerable.Range(0,256).Select(n=>{var c=(uint)n;for(int i=0;i<8;i++)c=(c>>1)^((c&1)!=0?0xedb88320u:0);return c;}).ToArray();
    static uint Crc(ReadOnlySpan<byte> bytes){uint crc=uint.MaxValue;foreach(var b in bytes)crc=(crc>>8)^CrcTable[(crc^b)&255];return ~crc;}
    static uint U32(ReadOnlySpan<byte> bytes,int offset)=>BinaryPrimitives.ReadUInt32LittleEndian(bytes[offset..]);
    static void CheckPatch(byte[] patch)
    {
        if(patch.Length<19||patch.Length>MaximumPatch||!patch.AsSpan(0,4).SequenceEqual("BPS1"u8)||Crc(patch.AsSpan(0,patch.Length-4))!=U32(patch,patch.Length-4))throw new WorkerError("BACKPORT_PATCH_CORRUPT");
    }
    // BPS1 public-domain specification: all four actions, signed relative offsets and all three CRCs.
    public static byte[] ApplyBps(byte[] source,byte[] patch)
    {
        CheckPatch(patch);if(source.Length>MaximumModule)throw new WorkerError("INPUT_TOO_LARGE");
        int pos=4,end=patch.Length-12;
        long Number(){long value=0,shift=1;for(int i=0;i<9;i++){
            if(pos>=end)throw new WorkerError("BACKPORT_PATCH_CORRUPT");var b=patch[pos++];
            try{value=checked(value+(b&127)*shift);if((b&128)!=0)return value;shift=checked(shift*128);value=checked(value+shift);}catch(OverflowException){throw new WorkerError("BACKPORT_PATCH_CORRUPT");}
        }throw new WorkerError("BACKPORT_PATCH_CORRUPT");}
        var sourceSize=Number();var targetSize=Number();var metadata=Number();
        if(sourceSize!=source.Length||Crc(source)!=U32(patch,end))throw new WorkerError("BACKPORT_PATCH_INPUT_MISMATCH");
        if(targetSize>MaximumModule)throw new WorkerError("INPUT_TOO_LARGE");
        if(metadata>end-pos)throw new WorkerError("BACKPORT_PATCH_CORRUPT");pos+=(int)metadata;
        var target=new byte[(int)targetSize];int written=0;long sourceOffset=0,targetOffset=0;
        while(pos<end){
            var instruction=Number();var length=(instruction>>2)+1;var action=instruction&3;
            if(length>target.Length-written)throw new WorkerError("BACKPORT_PATCH_CORRUPT");var count=(int)length;
            if(action==0){if(count>source.Length-written)throw new WorkerError("BACKPORT_PATCH_CORRUPT");source.AsSpan(written,count).CopyTo(target.AsSpan(written));}
            else if(action==1){if(count>end-pos)throw new WorkerError("BACKPORT_PATCH_CORRUPT");patch.AsSpan(pos,count).CopyTo(target.AsSpan(written));pos+=count;}
            else{
                var n=Number();var delta=(n&1)==0?n>>1:-(n>>1);
                if(action==2){sourceOffset+=delta;if(sourceOffset<0||sourceOffset>source.Length-count)throw new WorkerError("BACKPORT_PATCH_CORRUPT");source.AsSpan((int)sourceOffset,count).CopyTo(target.AsSpan(written));sourceOffset+=count;}
                else{targetOffset+=delta;if(targetOffset<0||targetOffset>=written)throw new WorkerError("BACKPORT_PATCH_CORRUPT");for(int i=0;i<count;i++)target[written+i]=target[(int)targetOffset++];}
            }
            written+=count;
        }
        if(written!=target.Length||Crc(target)!=U32(patch,end+4))throw new WorkerError("BACKPORT_PATCH_OUTPUT_MISMATCH");
        return target;
    }
    // idlesauce's source-verified SCE process/module parameter layout. SDK values are explicit profile data.
    public static byte[] PatchSdk(byte[] elf,ElfSdk sdk)
    {
        if(elf.Length<64||elf.Length>MaximumModule||!elf.AsSpan(0,7).SequenceEqual(new byte[]{127,69,76,70,2,1,1})||BinaryPrimitives.ReadUInt16LittleEndian(elf.AsSpan(18))!=62||BinaryPrimitives.ReadUInt16LittleEndian(elf.AsSpan(54))!=56)throw new WorkerError("UNSUPPORTED_INPUT");
        var start=BinaryPrimitives.ReadUInt64LittleEndian(elf.AsSpan(32));var count=BinaryPrimitives.ReadUInt16LittleEndian(elf.AsSpan(56));
        if(start<64||start>(ulong)elf.Length||count==0||count>8192||(ulong)count*56>(ulong)elf.Length-start)throw new WorkerError("CORRUPT_INPUT");
        var output=elf.ToArray();int changed=0;
        for(int i=0;i<count;i++){
            int header=(int)start+i*56;var type=U32(elf,header);if(type!=0x61000001&&type!=0x61000002)continue;
            var offset=BinaryPrimitives.ReadUInt64LittleEndian(elf.AsSpan(header+8));var size=BinaryPrimitives.ReadUInt64LittleEndian(elf.AsSpan(header+32));
            if(offset>(ulong)elf.Length||size>(ulong)elf.Length-offset||size<24)throw new WorkerError("CORRUPT_INPUT");
            int at=(int)offset;var structureSize=U32(elf,at);var magic=U32(elf,at+8);
            if(structureSize<24||structureSize>size||magic!=(type==0x61000001?0x4942524Fu:0x3C13F4BFu))throw new WorkerError("CORRUPT_INPUT");
            uint Lower(uint current,uint target)=>current==0||current>target?target:current;
            BinaryPrimitives.WriteUInt32LittleEndian(output.AsSpan(at+16),Lower(U32(elf,at+16),sdk.Ps4));BinaryPrimitives.WriteUInt32LittleEndian(output.AsSpan(at+20),Lower(U32(elf,at+20),sdk.Ps5));changed++;
        }
        if(changed==0)throw new WorkerError("BACKPORT_SDK_RECORD_MISSING");return output;
    }
}
