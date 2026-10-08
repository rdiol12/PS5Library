using LibProsperoPkg;
using LibProsperoPkg.GP5;
using LibProsperoPkg.PKG;
using UFS2Tool;
using System.Buffers.Binary;
using System.Text;
namespace PS5Library.Worker;
public sealed class ProsperoPackageBuilderAdapter : IPackageBuilder
{
    public string Version=>"LibProsperoPKG drakmor / 5e26c8ae65f4b3cf88dcc7c84226ea9718c38e5e+ps5library-streaming-kraken-v1";
    public string Format=>"pkg";
    public string Build(string source,string output,Identity identity,Action<long,long>? progress=null)
    {
        var sceSys=Path.Combine(source,"sce_sys");var licenseDat=Path.Combine(sceSys,"license.dat");var licenseInfo=Path.Combine(sceSys,"license.info");
        var hasLicenseDat=File.Exists(licenseDat);var hasLicenseInfo=File.Exists(licenseInfo);var omitOpaqueLicense=false;
        if(hasLicenseDat!=hasLicenseInfo)throw new WorkerError("INCOMPLETE_INPUT","sce_sys/license.dat and license.info must be supplied together.");
        if(hasLicenseDat){
            var dat=File.ReadAllBytes(licenseDat);var info=File.ReadAllBytes(licenseInfo);
            var datValid=ProsperoSystemFiles.ValidateLicenseDat(dat,identity.ContentId,out var datError);var infoValid=ProsperoSystemFiles.ValidateLicenseInfo(info,identity.ContentId,out var infoError);
            if(!datValid||!infoValid){
                omitOpaqueLicense=dat.Length==ProsperoSystemFiles.LicenseDatSize&&info.Length==ProsperoSystemFiles.LicenseInfoSize
                    &&!dat.AsSpan(0,4).SequenceEqual("RIF\0"u8)&&!info.AsSpan(0,identity.ContentId.Length).SequenceEqual(Encoding.ASCII.GetBytes(identity.ContentId));
                if(!omitOpaqueLicense)throw new WorkerError("CORRUPT_INPUT",$"Invalid supplied license records: {datError??infoError}");
                Console.Error.WriteLine("Skipping opaque retail sce_sys license records; the source dump is unchanged.");
            }
        }
        var project=Gp5Project.Create(Gp5VolumeType.prospero_app);var normalized=Path.Combine(output,"gp5-assets","normalized-self");var files=Files.Enumerate(source).ToDictionary(file=>Path.GetRelativePath(source,file).Replace('\\','/'),StringComparer.OrdinalIgnoreCase);
        foreach(var (destination,file) in files.OrderBy(item=>item.Key,StringComparer.Ordinal)){
            var slash=destination.IndexOf('/');if(slash>=0&&Files.ExcludedFromBase(destination[..slash]))continue;
            if(new[]{".gp4",".gp5",".esbak"}.Contains(Path.GetExtension(file),StringComparer.OrdinalIgnoreCase)||GeneratedServiceFile(destination)||HostArtifact(destination))continue;
            if(omitOpaqueLicense&&destination is "sce_sys/license.dat" or "sce_sys/license.info")continue;
            project.Files.Add(new Gp5File {SourcePath=NormalizeSelf(file,Files.SafeRelative(normalized,destination)),DestinationPath=destination});
        }
        Gp5Project.WriteTo(project,Path.Combine(output,"source.gp5"));
        var finalizing=false;Action<long,long>? buildProgress=progress is null?null:(completed,total)=>{progress(completed,total);if(!finalizing&&completed==total){finalizing=true;Progress.Stage("Finalizing package",3,package:"FINALIZING");}};
        var result=ProsperoPackageBuilder.Build(new ProsperoBuildOptions { SourceFolder=output,OutputFolder=output,TitleId=identity.TitleId,ContentId=identity.ContentId,Version=identity.Version,Title=identity.Title,GenerateParamJsonIfMissing=false,OutputFormat=ProsperoOutputFormat.DebugImage,UsePublisherPprNaps=true,EncryptOuterPfs=false,OuterPfsSeed=Encoding.ASCII.GetBytes("PPRPLAIN-NOAUTH!"),Progress=buildProgress },Console.Error.WriteLine);
        foreach(var warning in result.Warnings) Console.Error.WriteLine(warning);
        return result.OutputPath;
    }
    static bool HostArtifact(string path)=>path.Equals("ampr_emu.index",StringComparison.OrdinalIgnoreCase)||path.Equals("ampr_emu.index.tmp",StringComparison.OrdinalIgnoreCase)||path.Equals("entitlements.txt",StringComparison.OrdinalIgnoreCase)||path.Equals("entitlement_key.dat",StringComparison.OrdinalIgnoreCase)||path.Equals("playgo.log",StringComparison.OrdinalIgnoreCase)||path.Equals("playlgo.log",StringComparison.OrdinalIgnoreCase);
    static bool GeneratedServiceFile(string path)=>path.StartsWith("sce_sys/about/",StringComparison.OrdinalIgnoreCase)||path.Equals("sce_sys/keystone",StringComparison.OrdinalIgnoreCase)||path.Equals("sce_sys/pfs-version.dat",StringComparison.OrdinalIgnoreCase)||path.Equals("sce_sys/imagedigs.dat",StringComparison.OrdinalIgnoreCase)||path.Equals("sce_sys/param.sfo",StringComparison.OrdinalIgnoreCase)||path.Equals("sce_sys/playgo-chunk.dat",StringComparison.OrdinalIgnoreCase)||path.Equals("sce_sys/playgo-hash-table.dat",StringComparison.OrdinalIgnoreCase)||path.Equals("sce_sys/playgo-ficm.dat",StringComparison.OrdinalIgnoreCase)||path.Equals("sce_sys/playgo-scenario.json",StringComparison.OrdinalIgnoreCase)||path.Equals("sce_sys/playgo-manifest.xml",StringComparison.OrdinalIgnoreCase)||path.Equals("sce_sys/playgo-chunk.crc",StringComparison.OrdinalIgnoreCase)||path.Equals("sce_sys/pfsimage.xml",StringComparison.OrdinalIgnoreCase)||path.Equals("sce_sys/pfs-region-hints.json",StringComparison.OrdinalIgnoreCase)||path.StartsWith("sce_sys/origin-",StringComparison.OrdinalIgnoreCase)||path.StartsWith("sce_sys/target-",StringComparison.OrdinalIgnoreCase);
    static string NormalizeSelf(string source,string destination)
    {
        using var input=new FileStream(source,FileMode.Open,FileAccess.Read,FileShare.Read,1024*1024,FileOptions.SequentialScan);if(input.Length<0x20)return source;
        Span<byte> header=stackalloc byte[0x20];input.ReadExactly(header);var magic=BinaryPrimitives.ReadUInt32LittleEndian(header);var rewrite=magic==LibProsperoPkg.Content.ProsperoFself.OrbisMagic;
        if(!rewrite&&magic!=LibProsperoPkg.Content.ProsperoFself.Magic)return source;
        long trailer=input.Length;var padding=0;var boundary=BinaryPrimitives.ReadUInt64LittleEndian(header[0x10..]);
        if(boundary>=0x20&&boundary<=(ulong)input.Length){var start=(long)Math.Max(0,boundary-15);var length=input.Length-start;if(length<=64*1024*1024){var tail=new byte[length];input.Position=start;input.ReadExactly(tail);var local=checked((int)(boundary-(ulong)start));for(var back=0;back<=Math.Min(15,local);back++)if(CompleteVersion(tail.AsSpan(local-back))){trailer=checked((long)boundary-back);padding=back;break;}}}
        if(!rewrite&&padding==0)return source;
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);input.Position=0;using var output=new FileStream(destination,FileMode.CreateNew,FileAccess.Write,FileShare.None,1024*1024,FileOptions.SequentialScan);var buffer=new byte[1024*1024];var remaining=trailer;
        while(remaining>0){var read=input.Read(buffer,0,(int)Math.Min(buffer.Length,remaining));if(read==0)throw new EndOfStreamException();output.Write(buffer,0,read);remaining-=read;}
        if(rewrite){output.Position=0;BinaryPrimitives.WriteUInt32LittleEndian(header,LibProsperoPkg.Content.ProsperoFself.Magic);output.Write(header[..4]);output.Position=trailer;}
        if(padding>0)output.Write(new byte[padding]);input.CopyTo(output);return destination;

        static bool CompleteVersion(ReadOnlySpan<byte> records){if(records.Length==0)return false;var offset=0;while(offset<records.Length){if(records.Length-offset<5||records[offset]!=0||records[offset+1]!=0)return false;var payload=BinaryPrimitives.ReadUInt16LittleEndian(records[(offset+2)..]);var size=payload+4;if(payload<18||size>records.Length-offset||records[offset+4]!=8)return false;var nameSize=payload-17;var name=records.Slice(offset+5,nameSize);var version=offset+5+nameSize;if(name.Length==0||name[^1]!=(byte)':'||name[..^1].IndexOfAnyExceptInRange((byte)0x20,(byte)0x7e)>=0||!records.Slice(version,8).SequenceEqual(records.Slice(version+8,8)))return false;offset+=size;}return true;}
    }
}
public sealed class UFS2ImageBuilderAdapter : IPackageBuilder
{
    public string Version=>"UFS2Tool 4.1.0 / b5307a60d5b4e3a68ba680e0e33cfadf05017c77";
    public string Format=>"ffpkg";
    public string Build(string staging,string output,Identity identity,Action<long,long>? progress=null)
    {
        var filename=Path.Combine(output,identity.TitleId+".ffpkg");
        new Ufs2ImageCreator { FilesystemFormat=2,InputDirectory=staging,VolumeName=identity.TitleId,CopyProgress=progress }.MakeFsImage(filename,staging,freeblockpc:5,minimumSize:32*1024*1024);
        return filename;
    }
}
