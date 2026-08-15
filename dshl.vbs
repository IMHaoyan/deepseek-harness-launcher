' DeepSeek Harness Launcher (DSHL) hidden launcher (dev convenience)
' IMPORTANT: keep this file ASCII-only (wscript parses .vbs as ANSI; UTF-8 Chinese comments break it)
' Launches the local Electron binary with the dshl folder as app path, window hidden.
Option Explicit
Dim exePath, sh, fso, appDir
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = appDir & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exePath) Then
  MsgBox "electron.exe not found. Run `npm install` in the dshl folder first.", 48, "DSHL"
  WScript.Quit 1
End If
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = appDir
sh.Run """" & exePath & """ .", 0, False
