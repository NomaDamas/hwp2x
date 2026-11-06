import test from "node:test";
import assert from "node:assert/strict";
import { isAppFrame, isSameDocument } from "./origin";

const main = { url: "file:///C:/Users/CHEOL~1/AppData/Local/Temp/2abc/resources/app.asar/electron/design/app.html", routingId: 1, processId: 7 };

test("우리 창의 최상위 화면은 주소 모양과 관계없이 허용한다", () => {
  for (const url of [
    main.url,
    main.url + "#",
    main.url + "#settings",
    main.url + "?x=1",
    "file:///c:/Users/%ED%99%8D%EA%B8%B8%EB%8F%99/app.asar/electron/design/app.html",
    "file://localhost/C:/app/app.html",
    "file:////server/share/app.html",
  ]) assert.equal(isAppFrame({ ...main, url }, main), true, url);
});

test("다른 화면·하위 프레임·원격 주소는 거부한다", () => {
  assert.equal(isAppFrame({ ...main, routingId: 2 }, main), false);
  assert.equal(isAppFrame({ ...main, processId: 8 }, main), false);
  assert.equal(isAppFrame({ ...main, url: "https://example.com/app.html" }, main), false);
  assert.equal(isAppFrame({ ...main, url: "not a url" }, main), false);
  assert.equal(isAppFrame(null, main), false);
});

test("같은 문서 안의 해시 이동만 허용한다", () => {
  assert.equal(isSameDocument(main.url + "#settings", main.url + "#"), true);
  assert.equal(isSameDocument(main.url.replace("app.html", "other.html"), main.url), false);
  assert.equal(isSameDocument("https://example.com/", main.url), false);
});
