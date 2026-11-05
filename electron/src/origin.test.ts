import test from "node:test";
import assert from "node:assert/strict";
import { isAppPage } from "./origin";

const win = "C:\\Users\\홍길동\\AppData\\Local\\Temp\\2abc\\resources\\app.asar\\electron\\design\\app.html";
const winUrl = "file:///C:/Users/%ED%99%8D%EA%B8%B8%EB%8F%99/AppData/Local/Temp/2abc/resources/app.asar/electron/design/app.html";
const linux = "/opt/hwp2x/resources/app.asar/electron/design/app.html";

test("Windows 패키지 화면 주소를 허용한다", () => {
  assert.equal(isAppPage(winUrl, win, "win32"), true);
  assert.equal(isAppPage(winUrl.replace("file:///C:", "file:///c:"), win, "win32"), true);
});

test("메뉴 링크가 붙인 해시가 있어도 허용한다", () => {
  assert.equal(isAppPage(winUrl + "#", win, "win32"), true);
  assert.equal(isAppPage("file://" + linux + "#settings", linux, "linux"), true);
});

test("다른 파일·다른 프로토콜·원격 호스트는 거부한다", () => {
  assert.equal(isAppPage("file:///opt/hwp2x/resources/app.asar/electron/design/other.html", linux, "linux"), false);
  assert.equal(isAppPage("https://example.com/electron/design/app.html", linux, "linux"), false);
  assert.equal(isAppPage("file://evil/share/app.html", "\\\\evil\\share\\app.html", "win32"), false);
  assert.equal(isAppPage("file:///opt/hwp2x/x/../resources/app.asar/electron/design/app.html", linux, "linux"), true);
  assert.equal(isAppPage(undefined, linux, "linux"), false);
  assert.equal(isAppPage("not a url", linux, "linux"), false);
});
