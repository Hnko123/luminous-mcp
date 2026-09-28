Set filesystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
folder = filesystem.GetParentFolderName(WScript.ScriptFullName)
shell.Run "cmd.exe /d /c cd /d """ & folder & """ && node src\index.js run", 0, False
