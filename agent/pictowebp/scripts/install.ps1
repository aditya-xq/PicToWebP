<#
.SYNOPSIS
    Install the PicToWebP Rust CLI without admin rights or PATH changes.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Json

.EXAMPLE
    .\install.ps1 -FromFile .\pictowebp.exe -InstallDir .\.tools -Json
#>
[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$InstallDir = "",
    [string]$AssetUrl = "",
    [string]$Sha256 = "",
    [string]$FromFile = "",
    [switch]$DryRun,
    [switch]$VerifyOnly,
    [switch]$Uninstall,
    [switch]$Json,
    [switch]$SkipAttestation,
    [switch]$RequireAttestation
)

$ErrorActionPreference = "Stop"
$Repo = "aditya-xq/PicToWebP"
$Schema = "pictowebp.install/v1"
$ManifestSchema = "pictowebp.release/v1"
$ExeName = "pictowebp.exe"

function Get-Target {
    # No native ARM64 Windows asset is published yet; the x64 binary runs
    # under emulation on ARM64 Windows.
    return "x86_64-pc-windows-msvc"
}

function Test-InstalledOnPath {
    param([string]$Path)
    $found = Get-Command pictowebp -ErrorAction SilentlyContinue
    if (-not $found -or -not $found.Source) { return $false }
    try {
        return ([System.IO.Path]::GetFullPath($found.Source) -eq
            [System.IO.Path]::GetFullPath($Path))
    }
    catch {
        return $false
    }
}

function Test-GhReady {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return $false }
    & gh auth token 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { return $false }
    # Older gh versions authenticate but have no `gh attestation` command.
    & gh attestation verify --help 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

function Get-DefaultInstallDir {
    if ($env:PICTOWEBP_INSTALL_DIR) { return $env:PICTOWEBP_INSTALL_DIR }
    return (Join-Path $env:LOCALAPPDATA "Programs\pictowebp")
}

function Write-Result {
    param([hashtable]$Payload)
    if ($Json) {
        $Payload | ConvertTo-Json -Compress -Depth 6
    }
    else {
        Write-Host ("PicToWebP {0}" -f $(if ($Payload.version) { $Payload.version } else { "" }))
        Write-Host ("  action:  {0}" -f $Payload.action)
        Write-Host ("  target:  {0}" -f $Payload.target)
        Write-Host ("  path:    {0}" -f $Payload.path)
        Write-Host ("  sha256:  {0}" -f $Payload.sha256)
        Write-Host ("  verified:{0}" -f $(if ($Payload.verified) { " yes" } else { " no (unverified)" }))
        if ($Payload.on_path) { Write-Host "  PATH:    on PATH" }
        else { Write-Host "  PATH:    not on PATH (use the absolute path above)" }
    }
}

$target = Get-Target
$emulated = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -eq "Arm64"
if ($emulated) {
    Write-Warning "No native ARM64 Windows build yet; installing the x64 binary (runs under emulation)."
}
if ($RequireAttestation) {
    if ($SkipAttestation) { throw "-RequireAttestation conflicts with -SkipAttestation" }
    if (-not (Test-GhReady)) {
        throw "gh with attestation support (2.49+) must be installed and authenticated for -RequireAttestation"
    }
}
if (-not $InstallDir) { $InstallDir = Get-DefaultInstallDir }
$exePath = Join-Path $InstallDir $ExeName
$manifestPath = Join-Path $InstallDir "install.json"

if ($Uninstall) {
    $resolvedInstall = [System.IO.Path]::GetFullPath($InstallDir)
    $driveRoot = [System.IO.Path]::GetPathRoot($resolvedInstall)
    $resolvedHome = [System.IO.Path]::GetFullPath($env:USERPROFILE)
    if (
        [string]::IsNullOrWhiteSpace($InstallDir) -or
        $resolvedInstall -eq $driveRoot -or
        $resolvedInstall.TrimEnd('\') -eq $resolvedHome.TrimEnd('\')
    ) {
        throw "Refusing to remove $InstallDir"
    }
    if (Test-Path $resolvedInstall) {
        # Only remove a directory this installer created; a path typo must
        # not delete unrelated data.
        if (-not (Test-Path (Join-Path $resolvedInstall "install.json"))) {
            throw "Refusing to remove ${InstallDir}: install.json not found"
        }
        if (-not $DryRun) {
            Remove-Item $resolvedInstall -Recurse -Force
        }
    }
    Write-Result @{
        schema = $Schema; action = "uninstall"; version = ""; target = $target
        path = $resolvedInstall; sha256 = ""; on_path = $false; dry_run = [bool]$DryRun
        verified = $false
    }
    exit 0
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("pictowebp-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null

try {
    $binarySha = ""
    $binary = ""
    $verified = $false

    if ($FromFile) {
        $binary = (Resolve-Path $FromFile).Path
        if (-not $Version) { $Version = "local" }
        if ($Sha256) {
            $actual = (Get-FileHash $binary -Algorithm SHA256).Hash.ToLower()
            if ($actual -ne $Sha256.ToLower()) { throw "SHA-256 mismatch for $binary" }
            $verified = $true
        }
        elseif (-not $RequireAttestation) {
            Write-Warning "Installing a local binary without -Sha256; it is not verified."
        }
        if ($RequireAttestation) {
            & gh attestation verify $binary --repo $Repo | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Binary attestation verification failed" }
            $verified = $true
        }
    }
    else {
        $base = if ($Version) {
            "https://github.com/$Repo/releases/download/rust-v$Version"
        }
        else {
            "https://github.com/$Repo/releases/download/rust-latest"
        }

        if (-not $AssetUrl) {
            $manifestFile = Join-Path $temp "latest.json"
            Invoke-WebRequest -Uri "$base/latest.json" -OutFile $manifestFile -UseBasicParsing
            if (-not $SkipAttestation -and (Test-GhReady)) {
                & gh attestation verify $manifestFile --repo $Repo | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "latest.json attestation verification failed" }
            }
            elseif (-not $SkipAttestation) {
                Write-Warning "gh is unavailable, unauthenticated, or too old; skipping manifest attestation."
            }
            $manifest = Get-Content -Path $manifestFile -Raw | ConvertFrom-Json
            if ($manifest.schema -ne $ManifestSchema) { throw "Unexpected manifest schema: $($manifest.schema)" }
            if (-not $Version) { $Version = $manifest.version }
            $asset = $manifest.assets.$target
            if (-not $asset) { throw "No release asset for target $target" }
            $AssetUrl = $asset.url
            if (-not $Sha256) { $Sha256 = $asset.sha256 }
        }
        elseif (-not $Version) { $Version = "local" }

        $archive = Join-Path $temp "pictowebp.tar.gz"
        Invoke-WebRequest -Uri $AssetUrl -OutFile $archive -UseBasicParsing

        $actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower()
        if ($Sha256) {
            if ($actual -ne $Sha256.ToLower()) {
                throw "SHA-256 mismatch: expected $Sha256, got $actual"
            }
            $verified = $true
        }
        if (-not $SkipAttestation -and (Test-GhReady)) {
            & gh attestation verify $archive --repo $Repo | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Sigstore attestation verification failed" }
            $verified = $true
        }
        elseif (-not $SkipAttestation) {
            Write-Warning "gh is unavailable, unauthenticated, or too old; skipping archive attestation."
        }
        if (-not $verified) {
            Write-Warning "Installing without checksum or attestation verification."
        }

        $expanded = Join-Path $temp "expanded"
        New-Item -ItemType Directory -Path $expanded | Out-Null
        & tar -xzf $archive -C $expanded
        if ($LASTEXITCODE -ne 0) { throw "Could not extract $archive" }
        $found = Get-ChildItem -Path $expanded -Recurse -Filter $ExeName | Select-Object -First 1
        if (-not $found) { throw "Archive did not contain $ExeName" }
        $binary = $found.FullName
    }

    $binarySha = (Get-FileHash $binary -Algorithm SHA256).Hash.ToLower()

    if ($VerifyOnly) {
        if ($FromFile) {
            $verifyPath = $binary
            $verifySha = $binarySha
            $verifyOk = $verified
        }
        elseif (Test-Path $exePath) {
            # Report the installed file, not the download. "verified" means the
            # installed bytes match the verified release artifact.
            $verifyPath = $exePath
            $verifySha = (Get-FileHash $exePath -Algorithm SHA256).Hash.ToLower()
            $verifyOk = $verified -and ($verifySha -eq $binarySha)
        }
        else {
            $verifyPath = $exePath
            $verifySha = ""
            $verifyOk = $false
        }
        Write-Result @{
            schema = $Schema; action = "verify"; version = $Version; target = $target
            path = $verifyPath; sha256 = $verifySha
            on_path = (Test-InstalledOnPath $exePath); dry_run = $true
            verified = $verifyOk
        }
        exit 0
    }

    if (-not $DryRun) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        $staged = Join-Path $InstallDir ".pictowebp.exe.new"
        Copy-Item -Path $binary -Destination $staged -Force
        Move-Item -Path $staged -Destination $exePath -Force
        Unblock-File -Path $exePath -ErrorAction SilentlyContinue
        $manifest = @{
            schema = "pictowebp.install/v1"
            version = $Version
            target = $target
            sha256 = $binarySha
            verified = $verified
            path = $exePath
            installed = (Get-Date -Format "yyyy-MM-dd")
        } | ConvertTo-Json
        [System.IO.File]::WriteAllText(
            $manifestPath,
            $manifest,
            (New-Object System.Text.UTF8Encoding($false))
        )
    }

    Write-Result @{
        schema = $Schema; action = $(if ($DryRun) { "plan" } else { "install" })
        version = $Version; target = $target; path = $exePath
        sha256 = $binarySha
        # Recomputed after the move so a fresh install into a PATH directory
        # is reported accurately.
        on_path = (Test-InstalledOnPath $exePath); dry_run = [bool]$DryRun
        verified = $verified
    }
    exit 0
}
catch {
    if ($Json) {
        @{ schema = $Schema; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
    Write-Error $_.Exception.Message
    exit 1
}
finally {
    Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
}
