; The per-user Windows installer (K17, K18, K19, K21, K23, K38): Inno Setup
; installs the bundle under %LOCALAPPDATA%\Programs\urx-cli and nowhere else,
; holding the installation's gate exclusively from before the first change
; until it ends. scripts/build-windows-installer.mjs compiles this script with
; the Inno Setup version build-inputs.json records and defines AppVersion,
; ManifestDigest (the SHA-256 of the bundle's release-manifest.json),
; BundleDir, OwnedFiles (a generated [Code] include that lists each file of
; the bundle with its SHA-256) and InnoVersion (the recorded version, encoded
; as ISPP's Ver is, without its build number).
;
; - Before any change, the state record beside the gate says `installing`,
;   so a failed or interrupted installation leaves the CLI unable to start
;   until this same installer runs again (K19). The record notes that the
;   bin folder is going onto the user's PATH before it is put there.
; - After the files are in place, each is checked against the bundle's
;   manifest, the bin folder is added to the user's PATH unless an
;   equivalent entry is there, and only then does the record say `complete`.
; - Setup closes and restarts nothing: a running urx holds the gate, so the
;   installer stops instead (CloseApplications=no, RestartApplications=no).
; - A folder at the installation root that is not this installation's is
;   left as it is, and so is anything at the root that is not a folder.
; - The uninstaller says `removing` only once the removal starts, and deletes
;   the state record only when every installed file and the PATH entry it
;   added are gone; otherwise the record stays `removing` for setup to repair.

#ifndef AppVersion
  #error Build this installer with scripts/build-windows-installer.mjs
#endif
#ifndef InnoVersion
  #error Build this installer with scripts/build-windows-installer.mjs
#endif
#if (Ver >> 8) != Int(InnoVersion)
  #error This installer is compiled only with the Inno Setup version build-inputs.json records
#endif

[Setup]
AppId={{82FB2C8C-93B5-4D19-B571-BA7D919DD95F}
AppName=urx-cli
AppVersion={#AppVersion}
AppVerName=urx-cli {#AppVersion}
AppPublisher=semnil
AppPublisherURL=https://github.com/semnil/urx-cli
DefaultDirName={localappdata}\Programs\urx-cli
UsePreviousAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no
RestartApplications=no
ChangesEnvironment=yes
UninstallFilesDir={app}\maintenance
UninstallDisplayName=urx-cli
OutputBaseFilename=urx-cli-{#AppVersion}-win-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Code]
{ FILE_ATTRIBUTE_DIRECTORY and FILE_ATTRIBUTE_REPARSE_POINT are Inno Setup's
  own. The rest carry a prefix so that none meets a name Inno Setup defines. }
const
  WIN32_GENERIC_READ = $80000000;
  WIN32_GENERIC_WRITE = $40000000;
  WIN32_CREATE_ALWAYS = 2;
  WIN32_OPEN_ALWAYS = 4;
  WIN32_FILE_FLAG_OPEN_REPARSE_POINT = $00200000;
  WIN32_INVALID_FILE_ATTRIBUTES = $FFFFFFFF;
  WIN32_ERROR_SHARING_VIOLATION = 32;
  WIN32_MOVEFILE_REPLACE_EXISTING = 1;
  WIN32_MOVEFILE_WRITE_THROUGH = 8;
  PRODUCT_MARK = '"product":"urx-cli","format":1,';

type
  TFileInformation = record
    Attributes: DWORD;
    CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh: DWORD;
    VolumeSerial: DWORD;
    SizeHigh, SizeLow: DWORD;
    Links: DWORD;
    IndexHigh, IndexLow: DWORD;
  end;

{ Handles and pointers are pointer-sized (NativeInt, NativeUInt), so these
  declarations hold for a 32-bit and a 64-bit Setup alike. A handle is signed
  here so that INVALID_HANDLE_VALUE reads as -1. }
function Win32CreateFile(Name: String; Access, Share: DWORD; Security: NativeUInt; Disposition, Flags: DWORD; Template: NativeInt): NativeInt;
  external 'CreateFileW@kernel32.dll stdcall';
function Win32CloseHandle(Handle: NativeInt): BOOL;
  external 'CloseHandle@kernel32.dll stdcall';
function Win32GetFileInformationByHandle(Handle: NativeInt; var Information: TFileInformation): BOOL;
  external 'GetFileInformationByHandle@kernel32.dll stdcall';
function Win32GetFileAttributes(Name: String): DWORD;
  external 'GetFileAttributesW@kernel32.dll stdcall';
function Win32WriteFile(Handle: NativeInt; const Buffer: AnsiString; Count: DWORD; var Written: DWORD; Overlapped: NativeUInt): BOOL;
  external 'WriteFile@kernel32.dll stdcall';
function Win32FlushFileBuffers(Handle: NativeInt): BOOL;
  external 'FlushFileBuffers@kernel32.dll stdcall';
function Win32MoveFileEx(Existing, Replacement: String; Flags: DWORD): BOOL;
  external 'MoveFileExW@kernel32.dll stdcall';
function Win32ExpandEnvironmentStrings(Source: String; Destination: String; Size: DWORD): DWORD;
  external 'ExpandEnvironmentStringsW@kernel32.dll stdcall';

#include OwnedFiles

var
  GateHandle: NativeInt;
  GateHeld: Boolean;
  PathAdded: Boolean;
  InstallFailed: Boolean;

function IsInvalidHandle(Handle: NativeInt): Boolean;
begin
  Result := (Handle = 0) or (Handle = -1);
end;

function MaintenanceDir: String;
begin
  Result := ExpandConstant('{localappdata}\urx-cli-maintenance');
end;

function GatePath: String;
begin
  Result := MaintenanceDir + '\gate.lock';
end;

function StatePath: String;
begin
  Result := MaintenanceDir + '\state.json';
end;

{ The one installation folder (K18), whatever /DIR or a /LOADINF file says. }
function FixedAppDir: String;
begin
  Result := ExpandConstant('{localappdata}\Programs\urx-cli');
end;

function WithoutTrailingBackslash(Value: String): String;
begin
  Result := Value;
  while (Length(Result) > 3) and (Result[Length(Result)] = '\') do
    SetLength(Result, Length(Result) - 1);
end;

function SameFolder(A, B: String): Boolean;
begin
  Result := CompareText(WithoutTrailingBackslash(A), WithoutTrailingBackslash(B)) = 0;
end;

{ A folder that is not a link or another reparse point. }
function IsPlainDirectory(Path: String): Boolean;
var
  Attributes: DWORD;
begin
  Attributes := Win32GetFileAttributes(Path);
  Result := (Attributes <> WIN32_INVALID_FILE_ATTRIBUTES) and ((Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0)
    and ((Attributes and FILE_ATTRIBUTE_REPARSE_POINT) = 0);
end;

function DirectoryIsEmpty(Path: String): Boolean;
var
  Found: TFindRec;
begin
  Result := True;
  if FindFirst(Path + '\*', Found) then
  begin
    try
      repeat
        if (Found.Name <> '.') and (Found.Name <> '..') then
        begin
          Result := False;
          Break;
        end;
      until not FindNext(Found);
    finally
      FindClose(Found);
    end;
  end;
end;

{ Takes the installation's gate exclusively (K21, K23): its folder is created
  when missing, its empty file is created when missing and kept afterwards.
  A gate held by a running urx or another setup is busy, and nothing waits
  for it. A call while the gate is held reuses that hold. }
function AcquireGate(var Problem: String): Boolean;
var
  Handle: NativeInt;
  Information: TFileInformation;
  Error: Integer;
begin
  Result := GateHeld;
  if GateHeld then
    Exit;
  if not DirExists(MaintenanceDir) and not CreateDir(MaintenanceDir) then
  begin
    Problem := 'The folder ' + MaintenanceDir + ' could not be created.';
    Exit;
  end;
  if not IsPlainDirectory(MaintenanceDir) then
  begin
    Problem := MaintenanceDir + ' is not a plain folder, so it is left as it is.';
    Exit;
  end;
  Handle := Win32CreateFile(GatePath, WIN32_GENERIC_READ, 0, 0, WIN32_OPEN_ALWAYS, WIN32_FILE_FLAG_OPEN_REPARSE_POINT, 0);
  if IsInvalidHandle(Handle) then
  begin
    Error := DLLGetLastError;
    if Error = WIN32_ERROR_SHARING_VIOLATION then
      Problem := 'urx is running, or another urx-cli setup is. Close it, then run this setup again.'
    else
      Problem := 'The installation gate ' + GatePath + ' could not be opened (Windows error ' + IntToStr(Error) + ').';
    Exit;
  end;
  if not Win32GetFileInformationByHandle(Handle, Information)
    or ((Information.Attributes and (FILE_ATTRIBUTE_DIRECTORY or FILE_ATTRIBUTE_REPARSE_POINT)) <> 0)
    or (Information.SizeHigh <> 0) or (Information.SizeLow <> 0) then
  begin
    Win32CloseHandle(Handle);
    Problem := 'The installation gate ' + GatePath + ' is not an empty file, so it is left as it is.';
    Exit;
  end;
  GateHandle := Handle;
  GateHeld := True;
  Result := True;
end;

procedure ReleaseGate;
begin
  if GateHeld then
  begin
    Win32CloseHandle(GateHandle);
    GateHeld := False;
  end;
end;

{ The state record (K38), in the one form this installer writes. }
function StateText(Phase: String): AnsiString;
var
  Added: String;
begin
  if PathAdded then
    Added := 'true'
  else
    Added := 'false';
  Result := '{' + PRODUCT_MARK + '"phase":"' + Phase + '","release":"{#AppVersion}","manifest":"{#ManifestDigest}","pathAdded":' + Added + '}' + #10;
end;

{ Replaces the state record: a temporary sibling is written and flushed,
  then moved over the record with write-through. Only a holder of the gate
  writes it. }
function WriteState(Phase: String; var Problem: String): Boolean;
var
  Temporary: String;
  Handle: NativeInt;
  Text: AnsiString;
  Written: DWORD;
begin
  Result := False;
  Temporary := StatePath + '.tmp';
  Text := StateText(Phase);
  Handle := Win32CreateFile(Temporary, WIN32_GENERIC_WRITE, 0, 0, WIN32_CREATE_ALWAYS, WIN32_FILE_FLAG_OPEN_REPARSE_POINT, 0);
  if IsInvalidHandle(Handle) then
  begin
    Problem := 'The installation state could not be written (Windows error ' + IntToStr(DLLGetLastError) + ').';
    Exit;
  end;
  try
    if not Win32WriteFile(Handle, Text, Length(Text), Written, 0) or (Written <> Length(Text)) or not Win32FlushFileBuffers(Handle) then
    begin
      Problem := 'The installation state could not be written (Windows error ' + IntToStr(DLLGetLastError) + ').';
      Exit;
    end;
  finally
    Win32CloseHandle(Handle);
  end;
  if not Win32MoveFileEx(Temporary, StatePath, WIN32_MOVEFILE_REPLACE_EXISTING or WIN32_MOVEFILE_WRITE_THROUGH) then
  begin
    Problem := 'The installation state could not be replaced (Windows error ' + IntToStr(DLLGetLastError) + ').';
    Exit;
  end;
  Result := True;
end;

{ Removes `Prefix` from the start of `Rest`, when `Rest` starts with it. }
function TakePrefix(var Rest: String; Prefix: String): Boolean;
begin
  Result := Copy(Rest, 1, Length(Prefix)) = Prefix;
  if Result then
    Delete(Rest, 1, Length(Prefix));
end;

{ Takes what comes before `Stop` from `Rest` into `Value`, and `Stop` with it. }
function TakeUntil(var Rest: String; Stop: String; var Value: String): Boolean;
var
  At: Integer;
begin
  At := Pos(Stop, Rest);
  Result := At > 0;
  if Result then
  begin
    Value := Copy(Rest, 1, At - 1);
    Delete(Rest, 1, At - 1 + Length(Stop));
  end;
end;

function IsLowerHex64(Value: String): Boolean;
var
  Index: Integer;
begin
  Result := Length(Value) = 64;
  if not Result then
    Exit;
  for Index := 1 to 64 do
    if not (((Value[Index] >= '0') and (Value[Index] <= '9')) or ((Value[Index] >= 'a') and (Value[Index] <= 'f'))) then
    begin
      Result := False;
      Exit;
    end;
end;

{ The state record, when there is one in exactly the form this installer
  writes, with a phase it writes; its pathAdded goes into `Added`. }
function ReadOwnState(var Phase: String; var Added: Boolean): Boolean;
var
  Raw: AnsiString;
  Rest, Release, Manifest: String;
begin
  Result := False;
  if not FileExists(StatePath) or not LoadStringFromFile(StatePath, Raw) then
    Exit;
  Rest := Raw;
  if not TakePrefix(Rest, '{' + PRODUCT_MARK + '"phase":"') then
    Exit;
  if not TakeUntil(Rest, '","release":"', Phase) then
    Exit;
  if (Phase <> 'installing') and (Phase <> 'complete') and (Phase <> 'removing') then
    Exit;
  if not TakeUntil(Rest, '","manifest":"', Release) or (Release = '') then
    Exit;
  if not TakeUntil(Rest, '","pathAdded":', Manifest) or not IsLowerHex64(Manifest) then
    Exit;
  if Rest = 'true}' + #10 then
    Added := True
  else if Rest = 'false}' + #10 then
    Added := False
  else
    Exit;
  Result := True;
end;

function ExpandVariables(Value: String): String;
var
  Size: DWORD;
begin
  Result := Value;
  Size := Win32ExpandEnvironmentStrings(Value, '', 0);
  if Size = 0 then
    Exit;
  SetLength(Result, Size);
  Size := Win32ExpandEnvironmentStrings(Value, Result, Size);
  if Size = 0 then
  begin
    Result := Value;
    Exit;
  end;
  SetLength(Result, Size - 1);
end;

{ The current user's PATH as the registry holds it, unexpanded: empty when
  there is none, and a failure when there is one that cannot be read. }
function ReadUserPath(var Value: String; var Problem: String): Boolean;
begin
  Value := '';
  Result := True;
  if not RegValueExists(HKCU, 'Environment', 'Path') then
    Exit;
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Value) then
  begin
    Problem := 'Your PATH could not be read, so it is left as it is.';
    Result := False;
  end;
end;

{ Whether one entry of `PathValue` names `Folder`, after its variables are
  expanded and a trailing backslash is dropped. }
function PathHasEntry(PathValue, Folder: String): Boolean;
var
  Rest, Entry: String;
  At: Integer;
begin
  Result := False;
  Rest := PathValue;
  while Rest <> '' do
  begin
    At := Pos(';', Rest);
    if At = 0 then
    begin
      Entry := Rest;
      Rest := '';
    end
    else
    begin
      Entry := Copy(Rest, 1, At - 1);
      Delete(Rest, 1, At);
    end;
    Entry := Trim(Entry);
    if (Entry <> '') and SameFolder(ExpandVariables(Entry), Folder) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

{ Appends the bundle's bin folder to the current user's PATH unless an
  equivalent entry is there (K18). Other entries, their order and their
  variable references are kept. The machine PATH is not touched. Before the
  PATH changes, the state record notes that the entry is this installer's,
  so an interrupted setup or a removal later takes it out again. }
function RegisterPath(var Problem: String): Boolean;
var
  Current, Bin: String;
begin
  Result := False;
  Bin := ExpandConstant('{app}\bin');
  if not ReadUserPath(Current, Problem) then
    Exit;
  if PathHasEntry(Current, Bin) then
  begin
    Result := True;
    Exit;
  end;
  PathAdded := True;
  if not WriteState('installing', Problem) then
    Exit;
  if Current = '' then
    Current := Bin
  else if Current[Length(Current)] = ';' then
    Current := Current + Bin
  else
    Current := Current + ';' + Bin;
  if not RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Current) then
  begin
    Problem := 'The bin folder could not be added to your PATH.';
    Exit;
  end;
  Result := True;
end;

{ Removes the entries this installer added, the bin folder exactly as it
  wrote it, and keeps every other entry in its order. }
function UnregisterPath(var Problem: String): Boolean;
var
  Current, Kept, Rest, Entry, Bin: String;
  At: Integer;
begin
  Result := False;
  Bin := ExpandConstant('{app}\bin');
  if not ReadUserPath(Current, Problem) then
    Exit;
  Kept := '';
  Rest := Current;
  while Rest <> '' do
  begin
    At := Pos(';', Rest);
    if At = 0 then
    begin
      Entry := Rest;
      Rest := '';
    end
    else
    begin
      Entry := Copy(Rest, 1, At - 1);
      Delete(Rest, 1, At);
    end;
    if CompareText(Trim(Entry), Bin) <> 0 then
    begin
      if Kept <> '' then
        Kept := Kept + ';';
      Kept := Kept + Entry;
    end;
  end;
  if (Kept <> Current) and not RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Kept) then
  begin
    Problem := 'The bin folder could not be taken off your PATH.';
    Exit;
  end;
  Result := True;
end;

{ Every file of the bundle is in place with the SHA-256 it was built with,
  the release manifest included. }
function VerifyOwnedFiles(var Problem: String): Boolean;
var
  Paths, Hashes: TArrayOfString;
  Index: Integer;
  Path: String;
begin
  Result := False;
  LoadOwnedFiles(Paths, Hashes);
  for Index := 0 to GetArrayLength(Paths) - 1 do
  begin
    Path := ExpandConstant('{app}\') + Paths[Index];
    try
      if not FileExists(Path) or (CompareText(GetSHA256OfFile(Path), Hashes[Index]) <> 0) then
      begin
        Problem := Paths[Index] + ' is not as it was built.';
        Exit;
      end;
    except
      Problem := Paths[Index] + ' could not be read.';
      Exit;
    end;
  end;
  Result := True;
end;

{ The files of the bundle that are still there, after a removal. }
function RemainingOwnedFiles: String;
var
  Paths, Hashes: TArrayOfString;
  Index: Integer;
begin
  Result := '';
  LoadOwnedFiles(Paths, Hashes);
  for Index := 0 to GetArrayLength(Paths) - 1 do
    if FileExists(ExpandConstant('{app}\') + Paths[Index]) then
    begin
      if Result <> '' then
        Result := Result + ', ';
      Result := Result + Paths[Index];
    end;
end;

procedure FailInstall(Problem: String);
begin
  InstallFailed := True;
  Log('urx-cli: ' + Problem);
  SuppressibleMsgBox('urx-cli is not installed completely: ' + Problem + #13#10 + 'urx stays unavailable until this setup runs again and completes.', mbCriticalError, MB_OK, IDOK);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Problem, Phase: String;
  Own, Added: Boolean;
  App: String;
begin
  Result := '';
  Added := False;
  App := ExpandConstant('{app}');
  if not SameFolder(App, FixedAppDir) then
  begin
    Result := 'urx-cli installs only into ' + FixedAppDir + ', not ' + App + '.';
    Exit;
  end;
  if not AcquireGate(Problem) then
  begin
    Result := Problem;
    Exit;
  end;
  Own := ReadOwnState(Phase, Added);
  if FileExists(StatePath) and not Own then
  begin
    ReleaseGate;
    Result := 'The installation state ' + StatePath + ' is not one this setup wrote, so it is left as it is.';
    Exit;
  end;
  if FileExists(App) or (DirExists(App) and not IsPlainDirectory(App)) then
  begin
    ReleaseGate;
    Result := App + ' is not a plain folder, so it is left as it is.';
    Exit;
  end;
  if DirExists(App) and not Own and not DirectoryIsEmpty(App) then
  begin
    ReleaseGate;
    Result := 'The folder ' + App + ' already exists and is not a urx-cli installation, so it is left as it is.';
    Exit;
  end;
  PathAdded := Own and Added;
  // The record says installing before the first change (K19).
  if not WriteState('installing', Problem) then
  begin
    ReleaseGate;
    Result := Problem;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Problem: String;
begin
  if CurStep <> ssPostInstall then
    Exit;
  if not VerifyOwnedFiles(Problem) then
  begin
    FailInstall(Problem);
    Exit;
  end;
  if not RegisterPath(Problem) then
  begin
    FailInstall(Problem);
    Exit;
  end;
  if not WriteState('complete', Problem) then
    FailInstall(Problem);
end;

function GetCustomSetupExitCode: Integer;
begin
  if InstallFailed then
    Result := 1
  else
    Result := 0;
end;

procedure DeinitializeSetup;
begin
  ReleaseGate;
end;

{ Takes the gate and checks the state record; nothing changes before the
  user confirms the removal. }
function InitializeUninstall: Boolean;
var
  Problem, Phase: String;
  Added: Boolean;
begin
  Result := False;
  Added := False;
  if not AcquireGate(Problem) then
  begin
    SuppressibleMsgBox(Problem, mbError, MB_OK, IDOK);
    Exit;
  end;
  if ReadOwnState(Phase, Added) then
    PathAdded := Added
  else if FileExists(StatePath) then
  begin
    ReleaseGate;
    SuppressibleMsgBox('The installation state ' + StatePath + ' is not one this setup wrote, so it is left as it is.', mbError, MB_OK, IDOK);
    Exit;
  end;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Problem, Remaining: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    // The removal starts now: the record says removing before the first file goes, so a stopped removal leaves urx unavailable.
    if not WriteState('removing', Problem) then
    begin
      Log('urx-cli: ' + Problem);
      SuppressibleMsgBox(Problem, mbError, MB_OK, IDOK);
      Abort;
    end;
    Exit;
  end;
  if CurUninstallStep <> usPostUninstall then
    Exit;
  Problem := '';
  Remaining := RemainingOwnedFiles;
  if Remaining <> '' then
    Problem := 'These files of urx-cli could not be removed: ' + Remaining + '.';
  // UnregisterPath leaves Problem empty when it takes the entry off, and names what failed otherwise.
  if (Problem = '') and PathAdded then
    if not UnregisterPath(Problem) then
      Log('urx-cli: ' + Problem);
  if Problem <> '' then
  begin
    // The record stays removing, so setup can install again over what is left and this removal can run again.
    Log('urx-cli: ' + Problem);
    SuppressibleMsgBox('urx-cli is not removed completely: ' + Problem + #13#10 + 'Run this removal again, or run setup to install urx-cli again.', mbError, MB_OK, IDOK);
    Exit;
  end;
  // The gate and its folder stay (K21); the completed removal leaves no state.
  if not DeleteFile(StatePath) then
    Log('urx-cli: the installation state ' + StatePath + ' could not be deleted.');
end;

procedure DeinitializeUninstall;
begin
  ReleaseGate;
end;
