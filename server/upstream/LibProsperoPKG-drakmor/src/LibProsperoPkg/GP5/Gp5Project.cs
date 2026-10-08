// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// Model of the PS5 "Prospero" GP5 project format (*.gp5). This is the XML project
// descriptor used to describe a PS5 package, with
// Prospero-specific element/attribute names. The model round-trips byte-compatibly with standard
// GP5 projects, so it can be used as the project model throughout the PS5 PKG builders.

using System;
using System.Collections.Generic;
using System.IO;
using System.Xml;
using System.Xml.Serialization;

namespace LibProsperoPkg.GP5;

/// <summary>
/// The PS5 package volume types expressed by a GP5 project.
/// </summary>
public enum Gp5VolumeType
{
    /// <summary>A standalone PS5 application/game package.</summary>
    prospero_app,

    /// <summary>A PS5 application patch.</summary>
    prospero_patch,

    /// <summary>Additional content (DLC) that ships data.</summary>
    prospero_ac,

    /// <summary>Additional content (DLC) entitlement only, no data.</summary>
    prospero_al,
}

/// <summary>
/// The structural style a GP5 project uses to describe its contents. The reference tool understands
/// two equivalent layouts:
/// <list type="bullet">
/// <item><see cref="Normal"/> — a single <c>&lt;rootdir&gt;</c> with a <c>src_path</c> (and optional
/// exclude masks) that the tool walks recursively, preceded by <c>&lt;global_exclude&gt;</c>.</item>
/// <item><see cref="Flat"/> — an explicit top-level <c>&lt;files&gt;</c> (and optional
/// <c>&lt;folders&gt;</c>) listing that maps each source path to a package destination path, with no
/// <c>&lt;rootdir&gt;</c> / <c>&lt;global_exclude&gt;</c>.</item>
/// </list>
/// </summary>
public enum Gp5Layout
{
    /// <summary>A single recursively-walked <c>&lt;rootdir src_path&gt;</c> (with <c>&lt;global_exclude&gt;</c>).</summary>
    Normal,

    /// <summary>An explicit top-level <c>&lt;files&gt;</c> / <c>&lt;folders&gt;</c> listing.</summary>
    Flat,
}

/// <summary>
/// In-memory representation of a <c>*.gp5</c> project. Use <see cref="Create"/> to build
/// a new project, <see cref="WriteTo(Gp5Project, string)"/> to serialize it and
/// <see cref="ReadFrom(string)"/> to load one back.
/// </summary>
[XmlRoot(ElementName = "psproject")]
public sealed class Gp5Project
{
    [XmlAttribute("fmt")]
    public string Format { get; set; } = "gp5";

    [XmlAttribute("version")]
    public int Version { get; set; } = 1000;

    /// <summary>
    /// Whether the optional <c>version</c> attribute was present. Newly-created projects omit it,
    /// matching current Publishing Tools; older SDK samples that contain <c>version="1000"</c>
    /// retain it when read and written again.
    /// </summary>
    [XmlIgnore]
    public bool VersionSpecified { get; set; }

    [XmlElement(ElementName = "volume", Order = 1)]
    public Gp5Volume Volume { get; set; } = new();

    [XmlElement(ElementName = "global_exclude", Order = 2)]
    public string GlobalExclude { get; set; } = "";

    [XmlElement(ElementName = "rootdir", Order = 3)]
    public Gp5RootDir RootDir { get; set; } = new();

    /// <summary>
    /// The explicit top-level <c>&lt;files&gt;</c> listing (flat layout). When this is non-empty the
    /// project is written in the <see cref="Gp5Layout.Flat"/> style and the <c>&lt;rootdir&gt;</c> /
    /// <c>&lt;global_exclude&gt;</c> elements are omitted.
    /// </summary>
    [XmlArray(ElementName = "files", Order = 4)]
    [XmlArrayItem(ElementName = "file", Type = typeof(Gp5File))]
    public List<Gp5File> Files { get; set; } = [];

    /// <summary>Preserves an explicit empty <c>&lt;files/&gt;</c>, used by blank and AL projects.</summary>
    [XmlIgnore]
    public bool FilesSpecified { get; set; }

    /// <summary>
    /// The optional explicit top-level <c>&lt;folders&gt;</c> listing (flat layout) that maps whole
    /// source directories to package destination paths, parallel to <see cref="Files"/>.
    /// </summary>
    [XmlArray(ElementName = "folders", Order = 5)]
    [XmlArrayItem(ElementName = "dir", Type = typeof(Gp5Dir))]
    public List<Gp5Dir> Folders { get; set; } = [];

    [XmlIgnore]
    public bool FoldersSpecified { get; set; }

    /// <summary>
    /// The layout this project is in: <see cref="Gp5Layout.Flat"/> when it carries an explicit
    /// <see cref="Files"/> / <see cref="Folders"/> listing, otherwise <see cref="Gp5Layout.Normal"/>
    /// (a recursively-walked <see cref="RootDir"/>).
    /// </summary>
    [XmlIgnore]
    public Gp5Layout Layout =>
        (FilesSpecified || FoldersSpecified || Files.Count > 0 || Folders.Count > 0)
            ? Gp5Layout.Flat
            : Gp5Layout.Normal;

    // Normal-layout elements are emitted only when the project is not an explicit flat listing.
    public bool ShouldSerializeGlobalExclude() => Layout == Gp5Layout.Normal;
    public bool ShouldSerializeRootDir() => Layout == Gp5Layout.Normal;
    public bool ShouldSerializeFiles() => FilesSpecified || Files.Count > 0;
    public bool ShouldSerializeFolders() => FoldersSpecified || Folders.Count > 0;

    /// <summary>The XML namespaces written for a GP5 project (none, matching the reference tool).</summary>
    private static readonly XmlSerializerNamespaces EmptyNamespaces =
        new([XmlQualifiedName.Empty]);

    /// <summary>
    /// Creates a new, valid GP5 project with sensible Prospero defaults for the
    /// supplied volume type.
    /// </summary>
    public static Gp5Project Create(Gp5VolumeType type, string passcode = "00000000000000000000000000000000")
    {
        var project = new Gp5Project
        {
            FilesSpecified = true,
            Volume = new Gp5Volume
            {
                VolumeTypeName = type.ToString(),
                Package = new Gp5Package { Passcode = passcode },
            },
        };

        return project;
    }

    /// <summary>Serializes the project to the given stream.</summary>
    public static void WriteTo(Gp5Project project, Stream stream)
    {
        ArgumentNullException.ThrowIfNull(project);
        ArgumentNullException.ThrowIfNull(stream);

        var settings = new XmlWriterSettings
        {
            Indent = true,
            IndentChars = "  ",
            Encoding = new System.Text.UTF8Encoding(false),
            OmitXmlDeclaration = false,
        };
        using var writer = XmlWriter.Create(stream, settings);
        new XmlSerializer(typeof(Gp5Project)).Serialize(writer, project, EmptyNamespaces);
    }

    /// <summary>Serializes the project to the given file path.</summary>
    public static void WriteTo(Gp5Project project, string path)
    {
        using var fs = File.Create(path);
        WriteTo(project, fs);
    }

    /// <summary>Reads a GP5 project from the given stream.</summary>
    public static Gp5Project ReadFrom(Stream stream)
    {
        ArgumentNullException.ThrowIfNull(stream);
        return (Gp5Project)new XmlSerializer(typeof(Gp5Project)).Deserialize(stream)!;
    }

    /// <summary>Reads a GP5 project from the given file path.</summary>
    public static Gp5Project ReadFrom(string path)
    {
        using var fs = File.OpenRead(path);
        return ReadFrom(fs);
    }
}

/// <summary>The <c>&lt;volume&gt;</c> element of a GP5 project.</summary>
public sealed class Gp5Volume
{
    [XmlElement(ElementName = "volume_type")]
    public string VolumeTypeName { get; set; } = nameof(Gp5VolumeType.prospero_app);

    [XmlIgnore]
    public Gp5VolumeType Type
    {
        get => Enum.TryParse<Gp5VolumeType>(VolumeTypeName, out var t) ? t : Gp5VolumeType.prospero_app;
        set => VolumeTypeName = value.ToString();
    }

    [XmlElement(ElementName = "volume_id")]
    public string? VolumeId { get; set; }

    [XmlElement(ElementName = "volume_ts")]
    public string? VolumeTimestamp { get; set; }

    [XmlElement(ElementName = "package")]
    public Gp5Package Package { get; set; } = new();

    [XmlElement(ElementName = "chunk_info")]
    public Gp5ChunkInfo? ChunkInfo { get; set; }
}

/// <summary>The <c>&lt;package&gt;</c> element. PS5 packages carry the content id in param.json, not here.</summary>
public sealed class Gp5Package
{
    [XmlAttribute("content_id")]
    public string? ContentId { get; set; }

    [XmlAttribute("passcode")]
    public string Passcode { get; set; } = "00000000000000000000000000000000";

    [XmlAttribute("c_date")]
    public string? CreationDate { get; set; }

    [XmlAttribute("entitlement_key")]
    public string? EntitlementKey { get; set; }

    [XmlAttribute("storage_type")]
    public string? StorageType { get; set; }

    [XmlAttribute("app_path")]
    public string? AppPath { get; set; }

    public bool ShouldSerializeContentId() => !string.IsNullOrEmpty(ContentId);
    public bool ShouldSerializeCreationDate() => !string.IsNullOrEmpty(CreationDate);
    public bool ShouldSerializeEntitlementKey() => !string.IsNullOrEmpty(EntitlementKey);
    public bool ShouldSerializeStorageType() => !string.IsNullOrEmpty(StorageType);
    public bool ShouldSerializeAppPath() => !string.IsNullOrEmpty(AppPath);

    [XmlAnyAttribute]
    public XmlAttribute[]? AdditionalAttributes { get; set; }
}

/// <summary>PlayGo chunk/scenario metadata; present only for application packages.</summary>
public sealed class Gp5ChunkInfo
{
    [XmlAttribute("chunk_count")]
    public int ChunkCount { get; set; }

    [XmlAttribute("scenario_count")]
    public int ScenarioCount { get; set; }

    [XmlElement(ElementName = "chunks")]
    public Gp5Chunks ChunkSet { get; set; } = new();

    /// <summary>Compatibility view over <see cref="ChunkSet"/>.</summary>
    [XmlIgnore]
    public List<Gp5Chunk> Chunks
    {
        get => ChunkSet.Items;
        set => ChunkSet.Items = value ?? [];
    }

    [XmlElement(ElementName = "scenarios")]
    public Gp5Scenarios Scenarios { get; set; } = new();
}

/// <summary>The <c>&lt;chunks&gt;</c> container and its PlayGo language defaults.</summary>
public sealed class Gp5Chunks
{
    [XmlAttribute("supported_languages")]
    public string? SupportedLanguages { get; set; }

    [XmlAttribute("default_language")]
    public string? DefaultLanguage { get; set; }

    [XmlElement(ElementName = "chunk", Type = typeof(Gp5Chunk))]
    public List<Gp5Chunk> Items { get; set; } = [];

    public bool ShouldSerializeSupportedLanguages() => !string.IsNullOrEmpty(SupportedLanguages);
    public bool ShouldSerializeDefaultLanguage() => !string.IsNullOrEmpty(DefaultLanguage);

    [XmlAnyAttribute]
    public XmlAttribute[]? AdditionalAttributes { get; set; }
}

/// <summary>A single PlayGo chunk.</summary>
public sealed class Gp5Chunk
{
    [XmlAttribute("id")]
    public int Id { get; set; }

    [XmlAttribute("label")]
    public string Label { get; set; } = "";

    [XmlAttribute("layer_no")]
    public int LayerNumber { get; set; }

    [XmlIgnore]
    public bool LayerNumberSpecified { get; set; }

    [XmlAttribute("languages")]
    public string? Languages { get; set; }

    [XmlAttribute("use")]
    public bool Use { get; set; }

    [XmlIgnore]
    public bool UseSpecified { get; set; }

    public bool ShouldSerializeLabel() => !string.IsNullOrEmpty(Label);
    public bool ShouldSerializeLanguages() => !string.IsNullOrEmpty(Languages);

    [XmlAnyAttribute]
    public XmlAttribute[]? AdditionalAttributes { get; set; }
}

/// <summary>The <c>&lt;scenarios&gt;</c> container.</summary>
public sealed class Gp5Scenarios
{
    [XmlAttribute("default_id")]
    public int DefaultId { get; set; }

    [XmlElement(ElementName = "scenario", Type = typeof(Gp5Scenario))]
    public List<Gp5Scenario> Items { get; set; } = [];
}

/// <summary>A single PlayGo scenario; the chunk list is stored as element text.</summary>
public sealed class Gp5Scenario
{
    [XmlAttribute("id")]
    public int Id { get; set; }

    [XmlAttribute("type")]
    public string Type { get; set; } = "playmode";

    [XmlAttribute("initial_chunk_count")]
    public int InitialChunkCount { get; set; }

    [XmlAttribute("label")]
    public string Label { get; set; } = "";

    [XmlText]
    public string Chunks { get; set; } = "0";
}

/// <summary>
/// The <c>&lt;rootdir&gt;</c> element of the <see cref="Gp5Layout.Normal"/> layout: a single source
/// directory the reference tool walks recursively, with optional directory- and file-exclude masks.
/// The explicit per-file/per-folder listing of the flat layout lives in
/// <see cref="Gp5Project.Files"/> / <see cref="Gp5Project.Folders"/>, not here.
/// </summary>
public sealed class Gp5RootDir
{
    [XmlAttribute("dir_exclude")]
    public string? DirExclude { get; set; }

    [XmlAttribute("file_exclude")]
    public string? FileExclude { get; set; }

    [XmlAttribute("src_path")]
    public string? SourcePath { get; set; }

    /// <summary>Overlay and virtual directories nested directly under <c>rootdir</c>.</summary>
    [XmlElement(ElementName = "dir", Type = typeof(Gp5Dir))]
    public List<Gp5Dir> Directories { get; set; } = [];

    /// <summary>Overlay files nested directly under <c>rootdir</c>.</summary>
    [XmlElement(ElementName = "file", Type = typeof(Gp5File))]
    public List<Gp5File> Files { get; set; } = [];

    public bool ShouldSerializeSourcePath() => !string.IsNullOrEmpty(SourcePath);
    public bool ShouldSerializeDirExclude() => !string.IsNullOrEmpty(DirExclude);
    public bool ShouldSerializeFileExclude() => !string.IsNullOrEmpty(FileExclude);
}

/// <summary>An explicit file entry mapping a source path to a package destination path.</summary>
public sealed class Gp5File
{
    [XmlAttribute("dst_path")]
    public string DestinationPath { get; set; } = "";

    [XmlAttribute("src_path")]
    public string? SourcePath { get; set; }

    [XmlAttribute("chunk")]
    public int Chunk { get; set; }

    [XmlIgnore]
    public bool ChunkSpecified { get; set; }

    [XmlAttribute("content_config_label")]
    public string? ContentConfigLabel { get; set; }

    [XmlAttribute("pfs_compression")]
    public string? PfsCompression { get; set; }

    public bool ShouldSerializeSourcePath() => !string.IsNullOrEmpty(SourcePath);
    public bool ShouldSerializeContentConfigLabel() => !string.IsNullOrEmpty(ContentConfigLabel);
    public bool ShouldSerializePfsCompression() => !string.IsNullOrEmpty(PfsCompression);

    [XmlAnyAttribute]
    public XmlAttribute[]? AdditionalAttributes { get; set; }
}

/// <summary>An explicit directory entry mapping a source folder to a package destination path.</summary>
public sealed class Gp5Dir
{
    [XmlAttribute("dst_path")]
    public string DestinationPath { get; set; } = "";

    [XmlAttribute("src_path")]
    public string? SourcePath { get; set; }

    [XmlAttribute("virtual")]
    public bool Virtual { get; set; }

    [XmlIgnore]
    public bool VirtualSpecified { get; set; }

    [XmlAttribute("chunk")]
    public int Chunk { get; set; }

    [XmlIgnore]
    public bool ChunkSpecified { get; set; }

    [XmlAttribute("content_config_label")]
    public string? ContentConfigLabel { get; set; }

    [XmlElement(ElementName = "dir", Type = typeof(Gp5Dir))]
    public List<Gp5Dir> Directories { get; set; } = [];

    [XmlElement(ElementName = "file", Type = typeof(Gp5File))]
    public List<Gp5File> Files { get; set; } = [];

    public bool ShouldSerializeSourcePath() => !string.IsNullOrEmpty(SourcePath);
    public bool ShouldSerializeContentConfigLabel() => !string.IsNullOrEmpty(ContentConfigLabel);

    [XmlAnyAttribute]
    public XmlAttribute[]? AdditionalAttributes { get; set; }
}
