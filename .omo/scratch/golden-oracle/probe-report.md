# PowerPoint COM golden-oracle probe report

## VERDICT: RELIABLE

PowerPoint COM automation is repeatable on this machine when it is started in desktop session 1 by an interactive-token scheduled task, PowerPoint is made visible before opening the deck, an OLE `IMessageFilter` handles `RPC_E_CALL_REJECTED`, and each run owns and cleans up the PowerPoint process.

The final implementation completed 8 consecutive runs successfully (8/8). A ninth run through the delivered `run-golden.cmd` wrapper also completed successfully. Every measured run opened the 3-slide deck, exported three 1920x1080 PNGs, wrote valid `golden.json`, returned task state `Ready`, and left zero `POWERPNT.EXE` processes.

## Delivered procedure

Files:

- `run-golden.cmd` - wrapper; accepts an optional pptx path and otherwise uses the requested test deck.
- `golden.ps1` - ASCII PowerShell 5.1 script, so it has no BOM/ANSI parsing ambiguity.
- `status.txt` - terminal status (`OK <run stamp>` or `FAIL <run stamp> <HRESULT>`).
- `golden.json` - copy of the latest result.
- `run-<stamp>/` - per-run input copy, JSON, and slide PNGs.
- `final-8-runs.log` - measured consecutive-run evidence.

Task creation and execution:

```bat
schtasks /create /tn ImpromptuGoldenProbe /tr "\"C:\Users\steve\Desktop\projects\impromptu-r2\.omo\scratch\golden-oracle\run-golden.cmd\"" /sc once /st 23:59 /it /rl HIGHEST /f
schtasks /run /tn ImpromptuGoldenProbe
```

For a different deck, invoke `run-golden.cmd C:\path\deck.pptx` from an equivalent interactive-token task action. The script copies the source into its run directory before opening it.

## Stabilization used

1. Run only through the session-1 `/it` task path.
2. Register an STA-thread OLE `IMessageFilter`; rejected COM calls are retried after 100 ms.
3. Set `Application.Visible = msoTrue` before `Presentations.Open`.
4. Open a per-run local copy with a document window and initialize Normal view before reading `TimeLine`.
5. Enumerate both `TimeLine.MainSequence` and all `InteractiveSequences`.
6. Close/release COM objects, call `Application.Quit`, force finalizers, and finally terminate any owned/leftover `POWERPNT.EXE`.
7. Do not begin the next run until task state is no longer `Running` and no `POWERPNT.EXE` remains.

The HKCU inspection found no AutoRecovery files. The only registered PowerPoint add-ins were OneNote (`LoadBehavior` 9 and 0); no add-in changes were needed.

## What happened during investigation

- Initial task-launched `cmd.exe`, Windows PowerShell, PowerShell 7, `cscript.exe`, and `wscript.exe` hosts sometimes took 40-100 seconds to reach their script entry point. They were delayed, not permanently suspended. Once the initial desktop/session startup congestion cleared, final measured runs took 13.1-56.5 seconds.
- A direct PowerShell task action removed one nested-host startup delay and established COM stability. The final wrapper task was then tested separately and succeeded.
- `WithWindow=msoFalse` opened/exported successfully. `WithWindow=msoTrue` plus Normal-view initialization also succeeded and is the shipped setting because it is the safer path for loading UI-backed timeline state.
- No final-batch run produced `RPC_E_CALL_REJECTED`, `MK_E_UNAVAILABLE`, a null COM object, or an open failure.

### Animation observation

The pptx package contains three animation XML nodes on slide 2 (`animEffect`, `animMotion`, and `anim`) and a transition. However, this PowerPoint build reports **zero** effects through both `TimeLine.MainSequence` and `InteractiveSequences`. That result was unchanged with `WithWindow` false, `WithWindow` true, and after selecting each slide in Normal view. The final JSON therefore faithfully records the PowerPoint COM oracle's interpretation: empty effect arrays. PowerPoint appears to ignore the hand-authored timing tree rather than materialize it as object-model effects. The transition is not an animation effect and was not requested in `golden.json`.

This does not affect the reliability verdict: the oracle is repeatable and reports what this installed PowerPoint actually recognizes. It is important when comparing the result with package-level OOXML parsing, which sees the three raw timing nodes.

## Eight consecutive successful runs

```text
2026-08-16T14:49:42.7218430+09:00 START run=1
2026-08-16T14:50:26.9158037+09:00 OK run=1 stamp=20260816-144944-588 elapsedSeconds=44.2 slides=3 png=3 effects=0 files=[golden.json:918,input.pptx:31896,slide-1.png:14084,slide-2.png:92065,slide-3.png:5858]
2026-08-16T14:50:26.9625892+09:00 START run=2
2026-08-16T14:51:16.9045797+09:00 OK run=2 stamp=20260816-145028-953 elapsedSeconds=49.9 slides=3 png=3 effects=0 files=[golden.json:918,input.pptx:31896,slide-1.png:14084,slide-2.png:92065,slide-3.png:5858]
2026-08-16T14:51:16.9438822+09:00 START run=3
2026-08-16T14:51:44.1829014+09:00 OK run=3 stamp=20260816-145119-082 elapsedSeconds=27.2 slides=3 png=3 effects=0 files=[golden.json:918,input.pptx:31896,slide-1.png:14084,slide-2.png:92065,slide-3.png:5858]
2026-08-16T14:51:44.2348918+09:00 START run=4
2026-08-16T14:51:58.0752887+09:00 OK run=4 stamp=20260816-145146-471 elapsedSeconds=13.8 slides=3 png=3 effects=0 files=[golden.json:918,input.pptx:31896,slide-1.png:14084,slide-2.png:92065,slide-3.png:5858]
2026-08-16T14:51:58.1173626+09:00 START run=5
2026-08-16T14:52:11.5984480+09:00 OK run=5 stamp=20260816-145159-371 elapsedSeconds=13.5 slides=3 png=3 effects=0 files=[golden.json:918,input.pptx:31896,slide-1.png:14084,slide-2.png:92065,slide-3.png:5858]
2026-08-16T14:52:11.6399988+09:00 START run=6
2026-08-16T14:52:24.7754229+09:00 OK run=6 stamp=20260816-145213-681 elapsedSeconds=13.1 slides=3 png=3 effects=0 files=[golden.json:918,input.pptx:31896,slide-1.png:14084,slide-2.png:92065,slide-3.png:5858]
2026-08-16T14:52:24.8097468+09:00 START run=7
2026-08-16T14:53:14.4885112+09:00 OK run=7 stamp=20260816-145228-397 elapsedSeconds=49.7 slides=3 png=3 effects=0 files=[golden.json:918,input.pptx:31896,slide-1.png:14084,slide-2.png:92065,slide-3.png:5858]
2026-08-16T14:53:14.5441724+09:00 START run=8
2026-08-16T14:54:11.0213064+09:00 OK run=8 stamp=20260816-145317-042 elapsedSeconds=56.5 slides=3 png=3 effects=0 files=[golden.json:918,input.pptx:31896,slide-1.png:14084,slide-2.png:92065,slide-3.png:5858]
```

Wrapper verification after recreating the task with `run-golden.cmd` as its action:

```text
WRAPPER_STATUS=OK 20260816-145437-801
TASK_STATE=Ready
POWERPNT_COUNT=0
```

## Validation and cleanup

- PowerShell parser check: `PARSE_OK`.
- All 8 result JSON files parsed successfully during the batch.
- All 8 output directories contained exactly three PNGs and one JSON file with identical file sizes.
- The wrapper run completed with task state `Ready` and no PowerPoint process.
- The task and process cleanup output:

```text
COMMAND: schtasks /delete /tn ImpromptuGoldenProbe /f
SUCCESS: The scheduled task "ImpromptuGoldenProbe" was successfully deleted.
deleteExit=0
COMMAND: Stop-Process POWERPNT -Force
stoppedCount=0
CONFIRM TASK:
ERROR: The system cannot find the file specified.
queryExit=1
CONFIRM POWERPNT:
POWERPNT_COUNT=0
```
