param(
    [string]$DeckPath = 'C:\Users\steve\AppData\Local\Temp\impromptu-render-qa\korean-adversarial.pptx'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$statusPath = Join-Path $root 'status.txt'
$logPath = Join-Path $root 'runs.log'
$runStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$runDir = Join-Path $root ("run-" + $runStamp)
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
Set-Content -LiteralPath $statusPath -Value ("RUNNING " + $runStamp) -Encoding ASCII

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOleMessageFilter {
    [PreserveSig] int HandleInComingCall(int callType, IntPtr taskCaller, int tickCount, IntPtr interfaceInfo);
    [PreserveSig] int RetryRejectedCall(IntPtr taskCallee, int tickCount, int rejectType);
    [PreserveSig] int MessagePending(IntPtr taskCallee, int tickCount, int pendingType);
}

public sealed class PowerPointMessageFilter : IOleMessageFilter {
    [DllImport("ole32.dll")]
    private static extern int CoRegisterMessageFilter(IOleMessageFilter newFilter, out IOleMessageFilter oldFilter);
    private static IOleMessageFilter previous;
    public static void Register() {
        IOleMessageFilter oldFilter;
        CoRegisterMessageFilter(new PowerPointMessageFilter(), out oldFilter);
        previous = oldFilter;
    }
    public static void Revoke() {
        IOleMessageFilter ignored;
        CoRegisterMessageFilter(previous, out ignored);
        previous = null;
    }
    public int HandleInComingCall(int callType, IntPtr taskCaller, int tickCount, IntPtr interfaceInfo) { return 0; }
    public int RetryRejectedCall(IntPtr taskCallee, int tickCount, int rejectType) {
        if (rejectType == 2) return 100;
        return -1;
    }
    public int MessagePending(IntPtr taskCallee, int tickCount, int pendingType) { return 2; }
}
'@

function Release-ComObject([object]$Object) {
    if ($null -ne $Object -and [Runtime.InteropServices.Marshal]::IsComObject($Object)) {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Object)
    }
}

$app = $null
$presentation = $null
$startedIds = @()
try {
    if (-not (Test-Path -LiteralPath $DeckPath -PathType Leaf)) {
        throw "Deck not found: $DeckPath"
    }

    Get-Process POWERPNT -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    [PowerPointMessageFilter]::Register()
    $beforeIds = @(Get-Process POWERPNT -ErrorAction SilentlyContinue | ForEach-Object Id)

    $app = New-Object -ComObject PowerPoint.Application
    if ($null -eq $app) { throw 'PowerPoint.Application creation returned null' }
    $app.Visible = -1

    # Open a local per-run copy, without a document window. This avoids source locking
    # and keeps automation unobtrusive on the interactive desktop.
    $copyPath = Join-Path $runDir 'input.pptx'
    Copy-Item -LiteralPath $DeckPath -Destination $copyPath -Force
    $presentation = $app.Presentations.Open($copyPath, 0, 0, -1)
    if ($null -eq $presentation) { throw 'Presentations.Open returned null' }

    $slidesJson = @()
    $slideCount = [int]$presentation.Slides.Count
    for ($slideIndex = 1; $slideIndex -le $slideCount; $slideIndex++) {
        $slide = $null
        $sequence = $null
        try {
            $slide = $presentation.Slides.Item($slideIndex)
            $app.ActiveWindow.ViewType = 9
            $app.ActiveWindow.View.GotoSlide($slideIndex)
            $pngName = ('slide-{0}.png' -f $slideIndex)
            $pngPath = Join-Path $runDir $pngName
            $slide.Export($pngPath, 'PNG', 1920, 1080)

            $effectsJson = @()
            $sequences = @()
            $mainSequence = $slide.TimeLine.MainSequence
            $sequences += $mainSequence
            $interactiveSequences = $slide.TimeLine.InteractiveSequences
            for ($sequenceIndex = 1; $sequenceIndex -le [int]$interactiveSequences.Count; $sequenceIndex++) {
                $sequences += $interactiveSequences.Item($sequenceIndex)
            }
            $globalEffectIndex = 0
            foreach ($animationSequence in $sequences) {
                $effectCount = [int]$animationSequence.Count
                for ($effectIndex = 1; $effectIndex -le $effectCount; $effectIndex++) {
                    $effect = $null
                    $shape = $null
                    $timing = $null
                    try {
                        $globalEffectIndex++
                        $effect = $animationSequence.Item($effectIndex)
                        $shape = $effect.Shape
                        $timing = $effect.Timing
                        $effectsJson += [ordered]@{
                            index = $globalEffectIndex
                            shapeName = [string]$shape.Name
                            shapeId = [int]$shape.Id
                            effectType = [int]$effect.EffectType
                            triggerType = [int]$timing.TriggerType
                            duration = [double]$timing.Duration
                        }
                    }
                    finally {
                        Release-ComObject $timing
                        Release-ComObject $shape
                        Release-ComObject $effect
                    }
                }
                Release-ComObject $animationSequence
            }
            Release-ComObject $interactiveSequences
            $sequence = $null
            $slidesJson += [ordered]@{
                index = $slideIndex
                png = $pngName
                shapeCount = [int]$slide.Shapes.Count
                effects = $effectsJson
            }
        }
        finally {
            Release-ComObject $sequence
            Release-ComObject $slide
        }
    }

    $document = [ordered]@{
        source = [IO.Path]::GetFullPath($DeckPath)
        slideCount = $slideCount
        slides = $slidesJson
    }
    $document | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDir 'golden.json') -Encoding UTF8
    Copy-Item -LiteralPath (Join-Path $runDir 'golden.json') -Destination (Join-Path $root 'golden.json') -Force

    $presentation.Close()
    Release-ComObject $presentation
    $presentation = $null
    $app.Quit()
    Release-ComObject $app
    $app = $null
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()

    $line = ('{0} OK run={1} slides={2} png={3} json=golden.json' -f (Get-Date -Format 'o'), $runStamp, $slideCount, (@(Get-ChildItem $runDir -Filter 'slide-*.png').Count))
    Add-Content -LiteralPath $logPath -Value $line -Encoding ASCII
    Set-Content -LiteralPath $statusPath -Value ("OK " + $runStamp) -Encoding ASCII
    exit 0
}
catch {
    $hresult = ('0x{0:X8}' -f ($_.Exception.HResult -band 0xffffffffL))
    $detail = $_ | Out-String
    $line = ('{0} FAIL run={1} HRESULT={2} message={3}' -f (Get-Date -Format 'o'), $runStamp, $hresult, ($_.Exception.Message -replace '[\r\n]+',' '))
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $runDir 'error.txt') -Value ($line + "`r`n" + $detail + "`r`n" + $_.Exception.ToString()) -Encoding UTF8
    Set-Content -LiteralPath $statusPath -Value ("FAIL " + $runStamp + " " + $hresult) -Encoding ASCII
    exit 1
}
finally {
    if ($null -ne $presentation) {
        try { $presentation.Close() } catch {}
        Release-ComObject $presentation
    }
    if ($null -ne $app) {
        try { $app.Quit() } catch {}
        Release-ComObject $app
    }
    try { [PowerPointMessageFilter]::Revoke() } catch {}
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    Get-Process POWERPNT -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
