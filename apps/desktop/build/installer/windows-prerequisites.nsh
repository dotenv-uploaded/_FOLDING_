!include "LogicLib.nsh"
!include "WinVer.nsh"

!macro customInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP|MB_OK "Folding requires Windows 10 22H2 or newer." /SD IDOK
    Abort
  ${EndIf}
  SetRegView 64
  ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $R0 < 19045
    MessageBox MB_ICONSTOP|MB_OK "Folding requires Windows 10 22H2 (build 19045) or newer. Run Windows Update first." /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro customInstall
  StrCpy $R0 "0"
  SetRegView 64
  ClearErrors
  ReadRegDWORD $R1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegDWORD $R2 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Major"
  ReadRegDWORD $R3 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Minor"
  ReadRegDWORD $R4 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Bld"

  ${If} $R1 == 1
    ${If} $R2 > 14
      StrCpy $R0 "1"
    ${ElseIf} $R2 == 14
      ${If} $R3 > 50
        StrCpy $R0 "1"
      ${ElseIf} $R3 == 50
        ${If} $R4 >= 35719
          StrCpy $R0 "1"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} $R0 != "1"
    DetailPrint "Installing Microsoft Visual C++ Runtime 14.50.35719..."
    ExecWait '"$INSTDIR\resources\prerequisites\windows\vc_redist.x64.exe" /install /quiet /norestart /log "$TEMP\folding-vc-runtime.log"' $R5
    ${If} $R5 == 3010
      SetRebootFlag true
    ${ElseIf} $R5 == 1638
      DetailPrint "A newer Microsoft Visual C++ Runtime is already installed."
    ${ElseIf} $R5 != 0
      MessageBox MB_ICONSTOP|MB_OK "Microsoft Visual C++ Runtime installation failed (exit code $R5). See $TEMP\folding-vc-runtime.log." /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
!macroend
