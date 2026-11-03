Unicode True
Name "hwp2x"
OutFile "hwp2x-setup.exe"
InstallDir "$PROGRAMFILES64\hwp2x"
RequestExecutionLevel admin

Section "hwp2x"
  SetOutPath "$INSTDIR"
  !include "payload.nsh"
  CreateDirectory "$SMPROGRAMS\hwp2x"
  CreateShortcut "$SMPROGRAMS\hwp2x\hwp2x.lnk" "$INSTDIR\hwp2x.exe"
  CreateShortcut "$DESKTOP\hwp2x.lnk" "$INSTDIR\hwp2x.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\hwp2x.lnk"
  Delete "$SMPROGRAMS\hwp2x\hwp2x.lnk"
  RMDir "$SMPROGRAMS\hwp2x"
  RMDir /r "$INSTDIR"
SectionEnd
