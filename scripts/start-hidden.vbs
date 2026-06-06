Option Explicit

Dim fso
Dim shell
Dim scriptDir
Dim projectDir
Dim comspec
Dim command

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)
comspec = shell.ExpandEnvironmentStrings("%ComSpec%")

If Not fso.FolderExists(projectDir) Then
  WScript.Quit 1
End If

If Len(comspec) = 0 Or Not fso.FileExists(comspec) Then
  comspec = "cmd.exe"
End If

command = """" & comspec & """ /d /c npm start"

If WScript.Arguments.Named.Exists("dry-run") Then
  WScript.Echo "cwd=" & projectDir
  WScript.Echo "cmd=" & command
  WScript.Quit 0
End If

shell.CurrentDirectory = projectDir
shell.Run command, 0, False
