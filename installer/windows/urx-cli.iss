; The per-user Windows installer (K17, K18, K19, K21, K23, K38): Inno Setup
; installs the bundle in dist-bundle/ under %LOCALAPPDATA%\Programs\urx-cli,
; holding the installation's gate exclusively from before the first change
; until it ends. scripts/build-windows-installer.mjs compiles this script and
; defines AppVersion, ManifestDigest (the SHA-256 of the bundle's
; release-manifest.json), BundleDir and OwnedFiles (a generated [Code]
; include that lists each file of the bundle with its SHA-256).
;
; - Before any change, the state record beside the gate says `installing`,
;   so a failed or interrupted installation leaves the CLI unable to start
;   until this same installer runs again (K19).
; - After the files are in place, each is checked against the bundle's
;   manifest, the bundle's bin directory is added to the user's PATH unless
;   an equivalent entry is there, and only then does the record say
;   `complete`.
; - Setup closes and restarts nothing: a running urx holds the gate, so the
;   installer stops instead (CloseApplications=no, RestartApplications=no).
; - A folder at the installation root that is not this installation's is
;   left as it is, and so is anything at the root that is not a folder.

#ifndef AppVersion
  #error Build this installer with scripts/build-windows-installer.mjs
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
const
  GENERIC_READ = $80000000;
  GENERIC_WRITE = $40000000;
  CREATE_ALWAYS = 2;
  OPEN_ALWAYS = 4;
  FILE_FLAG_OPEN_REPARSE_POINT = $00200000;
  FILE_ATTRIBUTE_DIRECTORY = $10;
  FILE_ATTRIBUTE_REPARSE_POINT = $400;
  INVALID_FILE_ATTRIBUTES = $FFFFFFFF;
  ERROR_SHARING_VIOLATION = 32;
  MOVEFILE_REPLACE_EXISTING = 1;
  MOVEFILE_WRITE_THROUGH = 8;
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
function CreateFile(Name: String; Access, Share: DWORD; Security: NativeUInt; Disposition, Flags: DWORD; Template: NativeInt): NativeInt;
  external 'CreateFileW@kernel32.dll stdcall';
function CloseHandle(Handle: NativeInt): BOOL;
  external 'CloseHandle@kernel32.dll stdcall';
function GetFileInformationByHandle(Handle: NativeInt; var Information: TFileInformation): BOOL;
  external 'GetFileInformationByHandle@kernel32.dll stdcall';
function GetFileAttributes(Name: String): DWORD;
  external 'GetFileAttributesW@kernel32.dll stdcall';
function WriteFile(Handle: NativeInt; const Buffer: AnsiString; Count: DWORD; var Written: DWORD; Overlapped: NativeUInt): BOOL;
  external 'WriteFile@kernel32.dll stdcall';
function FlushFileBuffers(Handle: NativeInt): BOOL;
  external 'FlushFileBuffers@kernel32.dll stdcall';
function MoveFileEx(Existing, Replacement: String; Flags: DWORD): BOOL;
  external 'MoveFileExW@kernel32.dll stdcall';
function ExpandEnvironmentStrings(Source: String; Destination: String; Size: DWORD): DWORD;
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

{ A folder that is not a link or another reparse point. }
function IsPlainDirectory(Path: String): Boolean;
var
  Attributes: DWORD;
begin
  Attributes := GetFileAttributes(Path);
  Result := (Attributes <> INVALID_FILE_ATTRIBUTES) and ((Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0)
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
  Handle := CreateFile(GatePath, GENERIC_READ, 0, 0, OPEN_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, 0);
  if IsInvalidHandle(Handle) then
  begin
    Error := DLLGetLastError;
    if Error = ERROR_SHARING_VIOLATION then
      Problem := 'urx is running, or another urx-cli setup is. Close it, then run this setup again.'
    else
      Problem := 'The installation gate ' + GatePath + ' could not be opened (Windows error ' + IntToStr(Error) + ').';
    Exit;
  end;
  if not GetFileInformationByHandle(Handle, Information)
    or ((Information.Attributes and (FILE_ATTRIBUTE_DIRECTORY or FILE_ATTRIBUTE_REPARSE_POINT)) <> 0)
    or (Information.SizeHigh <> 0) or (Information.SizeLow <> 0) then
  begin
    CloseHandle(Handle);
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
    CloseHandle(GateHandle);
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
  Handle := CreateFile(Temporary, GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, 0);
  if IsInvalidHandle(Handle) then
  begin
    Problem := 'The installation state could not be written (Windows error ' + IntToStr(DLLGetLastError) + ').';
    Exit;
  end;
  try
    if not WriteFile(Handle, Text, Length(Text), Written, 0) or (Written <> Length(Text)) or not FlushFileBuffers(Handle) then
    begin
      Problem := 'The installation state could not be written (Windows error ' + IntToStr(DLLGetLastError) + ').';
      Exit;
    end;
  finally
    CloseHandle(Handle);
  end;
  if not MoveFileEx(Temporary, StatePath, MOVEFILE_REPLACE_EXISTING or MOVEFILE_WRITE_THROUGH) then
  begin
    Problem := 'The installation state could not be replaced (Windows error ' + IntToStr(DLLGetLastError) + ').';
    Exit;
  end;
  Result := True;
end;

{ The state record, when there is one this installer wrote. }
function ReadOwnState(var Text: AnsiString): Boolean;
begin
  Result := FileExists(StatePath) and LoadStringFromFile(StatePath, Text) and (Pos(PRODUCT_MARK, Text) = 2);
end;

function ExpandVariables(Value: String): String;
var
  Size: DWORD;
begin
  Result := Value;
  Size := ExpandEnvironmentStrings(Value, '', 0);
  if Size = 0 then
    Exit;
  SetLength(Result, Size);
  Size := ExpandEnvironmentStrings(Value, Result, Size);
  if Size = 0 then
  begin
    Result := Value;
    Exit;
  end;
  SetLength(Result, Size - 1);
end;

function WithoutTrailingBackslash(Value: String): String;
begin
  Result := Value;
  while (Length(Result) > 3) and (Result[Length(Result)] = '\') do
    SetLength(Result, Length(Result) - 1);
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
    if (Entry <> '') and (CompareText(WithoutTrailingBackslash(ExpandVariables(Entry)), WithoutTrailingBackslash(Folder)) = 0) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

{ Appends the bundle's bin folder to the current user's PATH unless an
  equivalent entry is there (K18). Other entries, their order and their
  variable references are kept. The machine PATH is not touched. }
function RegisterPath(var Problem: String): Boolean;
var
  Current, Bin: String;
begin
  Bin := ExpandConstant('{app}\bin');
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Current) then
    Current := '';
  Result := True;
  if PathHasEntry(Current, Bin) then
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
    Result := False;
    Exit;
  end;
  PathAdded := True;
end;

{ Removes the entries this installer added, the bin folder exactly as it
  wrote it, and keeps every other entry in its order. }
procedure UnregisterPath;
var
  Current, Kept, Rest, Entry, Bin: String;
  At: Integer;
begin
  Bin := ExpandConstant('{app}\bin');
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Current) then
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
  if Kept <> Current then
    RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Kept);
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

procedure Fail(Problem: String);
begin
  InstallFailed := True;
  Log('urx-cli: ' + Problem);
  SuppressibleMsgBox('urx-cli is not installed completely: ' + Problem + #13#10 + 'urx stays unavailable until this setup runs again and completes.', mbCriticalError, MB_OK, IDOK);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Problem: String;
  State: AnsiString;
  Own: Boolean;
  App: String;
begin
  Result := '';
  if not AcquireGate(Problem) then
  begin
    Result := Problem;
    Exit;
  end;
  Own := ReadOwnState(State);
  if FileExists(StatePath) and not Own then
  begin
    ReleaseGate;
    Result := 'The installation state ' + StatePath + ' is not one this setup wrote, so it is left as it is.';
    Exit;
  end;
  App := ExpandConstant('{app}');
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
  PathAdded := Own and (Pos('"pathAdded":true', State) > 0);
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
    Fail(Problem);
    Exit;
  end;
  if not RegisterPath(Problem) then
  begin
    Fail(Problem);
    Exit;
  end;
  if not WriteState('complete', Problem) then
    Fail(Problem);
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

function InitializeUninstall: Boolean;
var
  Problem: String;
  State: AnsiString;
begin
  Result := False;
  if not AcquireGate(Problem) then
  begin
    SuppressibleMsgBox(Problem, mbError, MB_OK, IDOK);
    Exit;
  end;
  if ReadOwnState(State) then
    PathAdded := Pos('"pathAdded":true', State) > 0
  else if FileExists(StatePath) then
  begin
    ReleaseGate;
    SuppressibleMsgBox('The installation state ' + StatePath + ' is not one this setup wrote, so it is left as it is.', mbError, MB_OK, IDOK);
    Exit;
  end;
  // The record says removing before the first change, so a stopped removal leaves urx unavailable.
  if not WriteState('removing', Problem) then
  begin
    ReleaseGate;
    SuppressibleMsgBox(Problem, mbError, MB_OK, IDOK);
    Exit;
  end;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep <> usPostUninstall then
    Exit;
  if PathAdded then
    UnregisterPath;
  // The gate and its folder stay (K21); the completed removal leaves no state.
  DeleteFile(StatePath);
end;

procedure DeinitializeUninstall;
begin
  ReleaseGate;
end;
