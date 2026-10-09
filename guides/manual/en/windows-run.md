# "Windows protected your PC" — what to do

> One-sentence goal: when double clicking MTNode shows "Windows protected your PC / unknown publisher", know why, which two clicks fix it, and what a developer can do so it stops showing up.

## What you will see

The first time you double click `MTNodeAIO.exe` (or the installer) that came from the internet or from a fresh local compile, Windows may show:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running this app might put your PC at risk.
> App: MTNodeAIO.exe　Publisher: Unknown publisher

This is not "a virus was found" and the build is not broken — the exe simply has **no code signing certificate yet, so Windows does not recognize it**.

## Allow it in three steps (normal users)

1. Click **More info** in that dialog.
2. A **Run anyway** button appears — click it.
3. The app starts. **You only need to do this once per file.**

If you only get "Don't run" and no "More info", this machine (or your company policy) forbids the override: ask your administrator, or get an installer that is signed / shipped through the Store.

## Why the old version stopped showing it and a new build shows it again

SmartScreen keys off the **reputation of the file hash**, not the app name:

- an exe that has been published for a while has been downloaded and run by many people, so it built up reputation → it passes silently;
- **every recompile / every new release is a brand new unsigned binary with a hash that has zero reputation** → the first double click shows the dialog.

So this is not "the last few source updates broke it"; it is the unavoidable path of every new build until the project adopts code signing or a Store package.

## Developers: spend one less prompt per compile

The repository ships `scripts/windows-unblock.mjs` and **the build chain calls it automatically**. It does two things:

| Step | What it does | Needs administrator |
| --- | --- | --- |
| 1 | Removes the `Zone.Identifier` (Mark-of-the-Web download flag) from the build output | no |
| 2 | Adds the build output folder (`dist\win-unpacked`) to the Microsoft Defender exclusions | **yes**, one UAC prompt |

- Cancelling that UAC prompt has no side effects: step 2 is simply skipped and the build is still usable (step 1 already ran).
- The exclusion adds **that one path only**; real-time and cloud protection stay on and no other folder becomes less safe.
- Re-run it by hand (when the compile is already done):

  ```
  scripts\rebuild-unblock.cmd
  ```

- To skip the step: `node E:\dev\tools\build.js --dir --no-unblock`
- Every run leaves its conclusion in `dist\unblock.log` (which step ran, whether it was cancelled, which paths were added).

### Wording for your download page

State the three steps above and say the reason is **the package is unsigned**. The only way to spare every user that step is to code sign the releases (or ship the Microsoft Store MSIX package, which SmartScreen never blocks).
