/*
 * Hancom file-access approval module ("FilePathCheckDLL").
 *
 * When Hwp.exe is driven through automation it asks a registered module whether a file may be opened or saved;
 * without one it shows "한글을 이용하여 위 파일에 접근하려는 시도가 있습니다" for every file. hwp2x registers this
 * module only for its own Hwp.exe instance (RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")),
 * which approves the files hwp2x hands to it. Hwp.exe is 32-bit or 64-bit depending on the install, so the
 * module is built for both (build-native-modules in package.json).
 *
 * No C runtime: only the export and the entry point, so it loads on any Windows without extra DLLs.
 */
typedef int BOOL;
typedef void *HANDLE;
typedef unsigned long DWORD;
typedef const unsigned short *LPCWSTR;

__declspec(dllexport) BOOL __stdcall IsAccessiblePath(LPCWSTR path, LPCWSTR mode, void *reserved1, void *reserved2) {
  (void)path; (void)mode; (void)reserved1; (void)reserved2;
  return 1;
}

BOOL __stdcall DllMain(HANDLE instance, DWORD reason, void *reserved) {
  (void)instance; (void)reason; (void)reserved;
  return 1;
}
