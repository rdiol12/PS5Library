# Publishes an update for a registered native PS5 title so consoles can install it themselves.
# With no -Source it first builds the PS5Library app from the current source; with -Source it
# takes any registered title's ready folder. See docs/NATIVE_APP_RELEASE.md.
param(
    [ValidatePattern('^[A-Z]{4}\d{5}$')][string]$TitleId = 'PPSA99051',
    [string]$Source,
    [ValidatePattern('^\d{2}\.\d{3}\.\d{3}$')][string]$ContentVersion,
    [string]$DataDir = $env:DATA_DIR,
    [string]$UpdateOrigin = $env:PUBLIC_URL,
    # Where releases are kept, and where the app's non-repository build inputs live.
    [string]$ReleasesDir = $env:PS5LIBRARY_NATIVE_RELEASES_DIR,
    [string]$AssetsDir = $env:PS5LIBRARY_NATIVE_ASSETS_DIR,
    [string]$Upstream = $env:PS5LIBRARY_PROSPEROTV_DIR,
    [string]$Executable,
    [switch]$GenerateUnsignedNptitle,
    [switch]$Base
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$appTitle = 'PPSA99051'
$pin = 'fdee81e746308f7f2b27f7914a84eab678088fb6'

function Read-Env([string]$name) {
    $file = Join-Path $repo '.env'
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    $line = Get-Content -LiteralPath $file | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
    if ($line) { return $line.Substring($name.Length + 1).Trim() }
    return $null
}
function Resolve-Setting([string]$value, [string]$name, [string]$fallback) {
    if (-not $value) { $value = Read-Env $name }
    if (-not $value) { $value = $fallback }
    if (-not $value) { return $null }
    if (-not [IO.Path]::IsPathRooted($value)) { $value = Join-Path $repo $value }
    return [IO.Path]::GetFullPath($value)
}
function Invoke-Step([string]$label, [scriptblock]$run) {
    Write-Host "== $label"
    & $run
    if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" }
}
function ConvertTo-Mount([string]$path) { return $path.Replace('\', '/') }

$titles = Get-Content -LiteralPath (Join-Path $repo 'shared/native-titles.json') -Raw | ConvertFrom-Json
$title = $titles.$TitleId
if (-not $title) {
    throw "$TitleId is not registered. Add it to shared/native-titles.json, then rebuild and restart the server."
}
if (-not $UpdateOrigin) { $UpdateOrigin = Read-Env 'PUBLIC_URL' }
if (-not $UpdateOrigin) { throw 'Set PUBLIC_URL in .env or pass -UpdateOrigin.' }
$UpdateOrigin = $UpdateOrigin.TrimEnd('/')
$DataDir = Resolve-Setting $DataDir 'DATA_DIR' $null
$toolkit = Resolve-Setting $env:PS5_PKG_TOOLKIT_DIR 'PS5_PKG_TOOLKIT_DIR' $null
$ReleasesDir = Resolve-Setting $ReleasesDir 'PS5LIBRARY_NATIVE_RELEASES_DIR' 'data/developer/native-releases'
$AssetsDir = Resolve-Setting $AssetsDir 'PS5LIBRARY_NATIVE_ASSETS_DIR' 'data/developer/native-assets'
$Upstream = Resolve-Setting $Upstream 'PS5LIBRARY_PROSPEROTV_DIR' 'upstream/ProsperoTV'
if (-not $DataDir) { throw 'Set DATA_DIR in .env or pass -DataDir.' }
if (-not $toolkit) { throw 'Set PS5_PKG_TOOLKIT_DIR in .env.' }

# The last published package of a title is the reference its next update is built against. It is
# recorded relative to the title's release folder so the folder can be moved.
$releases = Join-Path $ReleasesDir $TitleId
$stateFile = Join-Path $releases 'latest.json'
$state = if (Test-Path -LiteralPath $stateFile) { Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } else { $null }
if (-not $Base -and -not $state) {
    throw "No previous $TitleId release is recorded. Run once with -Base, install that package, then run again for updates."
}
$previous = if ($state) { [IO.Path]::GetFullPath((Join-Path $releases $state.reference)) } else { $null }
if (-not $Base -and -not (Test-Path -LiteralPath $previous -PathType Leaf)) {
    throw "The previous package is missing: $previous. Build and install a new base with -Base."
}

$buildApp = -not $Source
if ($buildApp -and $TitleId -ne $appTitle) { throw "Pass -Source with the ready folder for $TitleId." }

if ($buildApp) {
    foreach ($name in 'snd0.at9', 'right.sprx', 'keystone') {
        if (-not (Test-Path -LiteralPath (Join-Path $AssetsDir $name) -PathType Leaf)) {
            throw "Missing $(Join-Path $AssetsDir $name)."
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Upstream '.git'))) {
        throw "Clone ProsperoTV at $pin into $Upstream first."
    }
    if (-not $ContentVersion) {
        if (-not $state) { throw 'Pass -ContentVersion for the first base package (for example 01.000.000).' }
        $parts = $state.contentVersion.Split('.')
        $ContentVersion = '{0}.{1:d3}.000' -f $parts[0], ([int]$parts[1] + 1)
    }
} else {
    $Source = [IO.Path]::GetFullPath($Source)
    $param = Join-Path $Source 'sce_sys/param.json'
    if (-not (Test-Path -LiteralPath $param -PathType Leaf)) { throw "Not a title folder (no sce_sys/param.json): $Source" }
    $metadata = Get-Content -LiteralPath $param -Raw | ConvertFrom-Json
    if ($metadata.titleId -ne $TitleId) { throw "The folder is $($metadata.titleId), not $TitleId." }
    if ($ContentVersion -and $ContentVersion -ne $metadata.contentVersion) {
        throw "The folder's contentVersion is $($metadata.contentVersion); raise it there instead of passing $ContentVersion."
    }
    $ContentVersion = $metadata.contentVersion
}
if ($state -and [string]::CompareOrdinal($ContentVersion, $state.contentVersion) -le 0) {
    throw "Content version $ContentVersion must be higher than the published $($state.contentVersion)."
}

if ($buildApp) {
    $mount = ConvertTo-Mount $repo
    docker image inspect ps5library-build:0.43 *> $null
    if ($LASTEXITCODE -ne 0) {
        Invoke-Step 'Build image' { docker build -q -f (Join-Path $repo 'docker/ps5-build.Dockerfile') -t ps5library-build:0.43 $repo }
    }
    docker image inspect ps5library-native-build:0.2 *> $null
    if ($LASTEXITCODE -ne 0) {
        # .dockerignore keeps docker/ out of the repository context, so use a minimal one.
        $context = Join-Path ([IO.Path]::GetTempPath()) ("ps5library-native-" + [Guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Force (Join-Path $context 'docker') | Out-Null
        Copy-Item (Join-Path $repo 'docker/json-c-0.19-release.patch') (Join-Path $context 'docker')
        try {
            Invoke-Step 'Native build image' { docker build -q -f (Join-Path $repo 'docker/ps5-native-build.Dockerfile') -t ps5library-native-build:0.2 $context }
        } finally { Remove-Item -LiteralPath $context -Recurse -Force }
    }
    Invoke-Step 'App and agent' {
        docker run --rm -e HOME=/tmp -v "${mount}:/workspace" -w /workspace ps5library-build:0.43 sh -c 'cmake -S ps5 -B ps5/build/native-release -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=/opt/ps5-payload-sdk/toolchain/prospero.cmake > /tmp/configure.log 2>&1 || { tail -20 /tmp/configure.log; exit 1; }; cmake --build ps5/build/native-release -j 6 > /tmp/build.log 2>&1 || { grep -E " error |\*\*\*" /tmp/build.log | tail -20; exit 1; }'
    }
    Invoke-Step "Native title $ContentVersion" {
        docker run --rm --network none -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e 'GIT_CONFIG_VALUE_0=*' `
            -e "PUBLIC_URL=$UpdateOrigin" -v "${mount}:/workspace" -v "$(ConvertTo-Mount $Upstream):/prosperotv" `
            -v "$(ConvertTo-Mount $AssetsDir):/native-assets:ro" -w /workspace ps5library-native-build:0.2 `
            python3 ps5/native/build.py --upstream /prosperotv --payload-build ps5/build/native-release --mode app `
            --content-version $ContentVersion --selection-audio /native-assets/snd0.at9 `
            --right-sprx /native-assets/right.sprx
    }
    $Source = Join-Path $repo "ps5/build/native-app/dist/$appTitle"
}

# Work on a copy so the caller's folder is never modified.
$work = Join-Path $releases $ContentVersion
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $work 'output') | Out-Null
$staged = Join-Path $work $TitleId
Copy-Item $Source $staged -Recurse
if ($buildApp) { Copy-Item (Join-Path $AssetsDir 'keystone') (Join-Path $staged 'sce_sys/keystone') }
$output = Join-Path $work "output/$TitleId-$ContentVersion.pkg"

Push-Location $repo
try {
    if (-not $buildApp) {
        # The app build writes its own update address; any other title gets it here.
        Invoke-Step 'Update address' {
            npm run -s native:update -- configure --title-id $TitleId --source $staged --update-origin $UpdateOrigin --force
        }
    }
    if ($Base) {
        Invoke-Step 'Base package' { & (Join-Path $toolkit 'build-from-folder.ps1') -SourceFolder $staged -OutputPackage $output -CompressionLevel 9 -Force }
        $reference = $output
        Write-Host "Base package: $output"
        Write-Host "Install it once: python tools/ps5-dev/pkg_cli.py install `"$output`" --expect-content-id $($title.contentId)"
    } else {
        $build = @('build', '--title-id', $TitleId, '--source', $staged, '--output', $output,
            '--reference', $previous, '--base-version', $state.contentVersion)
        if ($Executable) { $build += @('--executable', [IO.Path]::GetFullPath($Executable)) }
        if ($GenerateUnsignedNptitle) { $build += '--generate-unsigned-nptitle' }
        Invoke-Step 'Update package' { npm run -s native:update -- @build }
        Invoke-Step 'Publish' {
            npm run -s native:update -- publish --title-id $TitleId --package "$output.remastered.pkg" `
                --delta "$output.delta.pkg" --base-version $state.contentVersion `
                --icon (Join-Path $staged 'sce_sys/icon0.png') --data-dir $DataDir
        }
        Invoke-Step 'Status' { npm run -s native:update -- status --title-id $TitleId --data-dir $DataDir }
        $reference = "$output.remastered.pkg"
        Write-Host "Published $($title.name) $ContentVersion. On the PS5: Options on the title's tile, then Check for Update."
    }
} finally { Pop-Location }
$relative = [IO.Path]::GetRelativePath($releases, [IO.Path]::GetFullPath($reference)).Replace('\', '/')
[ordered]@{ contentVersion = $ContentVersion; reference = $relative } | ConvertTo-Json |
    Set-Content -LiteralPath $stateFile -Encoding utf8
