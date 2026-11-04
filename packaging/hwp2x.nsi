Unicode True

!include "MUI2.nsh"

Name "hwp2x"
OutFile "hwp2x-setup.exe"
InstallDir "$PROGRAMFILES64\hwp2x"
InstallDirRegKey HKLM "Software\hwp2x" "InstallDir"
RequestExecutionLevel admin

!define MUI_ICON "assets\hwp2x.ico"
!define MUI_UNICON "assets\hwp2x.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "assets\header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "assets\wizard.bmp"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "hwp2x 설치"
!define MUI_WELCOMEPAGE_TEXT "로컬 HWP 파일을 HWPX로 일괄 변환하는 hwp2x를 설치합니다.$\r$\n$\r$\n변환은 설치된 한컴오피스 한글을 사용하고, 검증에서 차이가 없는 원본만 백업 후 삭제할 수 있습니다."
!define MUI_FINISHPAGE_TITLE "설치가 끝났습니다"
!define MUI_FINISHPAGE_TEXT "시작 메뉴 또는 바탕화면의 hwp2x를 실행하세요."
!define MUI_FINISHPAGE_RUN "$INSTDIR\hwp2x.exe"
!define MUI_FINISHPAGE_RUN_TEXT "hwp2x 실행"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"

VIProductVersion "0.1.0.0"
VIAddVersionKey "ProductName" "hwp2x"
VIAddVersionKey "CompanyName" "hwp2x"
VIAddVersionKey "FileDescription" "로컬 HWP 파일을 HWPX로 일괄 변환"
VIAddVersionKey "FileVersion" "0.1.0"
VIAddVersionKey "ProductVersion" "0.1.0"
VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 hwp2x contributors"

Section "hwp2x"
  SetOutPath "$INSTDIR"
  !include "payload-win.nsh"
  CreateDirectory "$SMPROGRAMS\hwp2x"
  CreateShortcut "$SMPROGRAMS\hwp2x\hwp2x.lnk" "$INSTDIR\hwp2x.exe"
  CreateShortcut "$DESKTOP\hwp2x.lnk" "$INSTDIR\hwp2x.exe"
  WriteRegStr HKLM "Software\hwp2x" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\hwp2x" "DisplayName" "hwp2x"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\hwp2x" "DisplayVersion" "0.1.0"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\hwp2x" "Publisher" "hwp2x"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\hwp2x" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\hwp2x" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\hwp2x" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\hwp2x.lnk"
  Delete "$SMPROGRAMS\hwp2x\hwp2x.lnk"
  RMDir "$SMPROGRAMS\hwp2x"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\hwp2x"
  DeleteRegKey HKLM "Software\hwp2x"
  RMDir /r "$INSTDIR"
SectionEnd
