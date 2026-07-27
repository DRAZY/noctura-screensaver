; Noctura — Inno Setup installer for the Windows screensaver.
; Built in CI (windows job) with: iscc /DAppVersion=x.y.z packaging\noctura.iss
;
; What this gives over the old Install-Noctura.bat:
;  - A real install wizard with the Noctura icon and branding
;  - Registration in Settings > Apps (Add/Remove Programs) with an uninstaller
;  - Upgrade hygiene: installing over any older version first removes the old
;    files (same AppId => Inno replaces in place; [InstallDelete] sweeps strays)
;  - Orphan cleanup: removes legacy hand-copied System32 installs from the
;    .bat era so users never have two Nocturas in the screensaver dropdown
;  - Automatically opens the Screen Saver control panel at the end

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
; NEVER change AppId — it is how upgrades find and replace prior installs.
AppId={{7E1F19D2-6B67-4E7B-9C1A-1B6E9C64A7D1}
AppName=Noctura
AppVersion={#AppVersion}
AppPublisher=Andre Hall
AppPublisherURL=https://github.com/DRAZY/noctura-screensaver
DefaultDirName={autopf}\Noctura
DisableProgramGroupPage=yes
; The .scr must live where Windows looks for screensavers; we install the
; binaries under Program Files and copy the active one into {sys} (see [Files]).
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible arm64
OutputBaseFilename=NocturaSetup
SetupIconFile=..\..\src-tauri\icons\icon.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Noctura Screen Saver
UninstallDisplayIcon={app}\Noctura-x64.scr

[Files]
; Keep both arch binaries under Program Files for reference/uninstall...
Source: "..\dist\windows\Noctura-x64.scr"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\windows\Noctura-arm64.scr"; DestDir: "{app}"; Flags: ignoreversion
; ...and place the matching one as THE screensaver in the system directory.
Source: "..\dist\windows\Noctura-x64.scr"; DestDir: "{sys}"; DestName: "Noctura.scr"; Flags: ignoreversion; Check: not IsArm64
Source: "..\dist\windows\Noctura-arm64.scr"; DestDir: "{sys}"; DestName: "Noctura.scr"; Flags: ignoreversion; Check: IsArm64

[InstallDelete]
; Sweep strays from older layouts / the .bat installer era.
Type: files; Name: "{app}\Noctura-x64.exe"
Type: files; Name: "{app}\Noctura-arm64.exe"

[UninstallDelete]
Type: files; Name: "{sys}\Noctura.scr"

[Registry]
; Point the "current screensaver" at Noctura so it is active immediately after
; install (the control panel we open at the end reflects it).
Root: HKCU; Subkey: "Control Panel\Desktop"; ValueType: string; ValueName: "SCRNSAVE.EXE"; ValueData: "{sys}\Noctura.scr"; Flags: uninsdeletevalue

[Run]
Filename: "rundll32.exe"; Parameters: "shell32.dll,Control_RunDLL desk.cpl,,1"; Description: "Open Screen Saver settings"; Flags: postinstall nowait skipifsilent

[UninstallRun]
; Make sure no saver/preview instance is running while we remove files.
Filename: "taskkill.exe"; Parameters: "/f /im Noctura.scr"; Flags: runhidden; RunOnceId: "KillNoctura"

[Code]
function IsArm64: Boolean;
begin
  Result := ProcessorArchitecture = paARM64;
end;
