# Third-party notices

hwp2x itself is licensed under the Apache License 2.0 (see `LICENSE`). The app bundles the third-party
components below, each under its own license. All of them permit redistribution in an Apache-2.0 product.
The full license texts ship inside each package (`node_modules/<name>/LICENSE`) in the app archive.

Checked against the packaged app (version 0.4.0-rc.8): 129 bundled npm packages, all permissive.
108 MIT, 8 ISC, 4 Apache-2.0, 3 BSD-3-Clause, 2 BSD-2-Clause, plus the four listed under "Dual or other
licenses". No GPL, AGPL or LGPL code is shipped.

## Main components

| Component | Version | License | Use |
| --- | --- | --- | --- |
| [kordoc](https://github.com/chrisryugj/kordoc) | 4.24.42 | MIT | Built-in HWP/HWPML → HWPX conversion, parsing and comparison |
| [cfb](https://github.com/SheetJS/js-cfb) | 1.2.2 | Apache-2.0 | HWP 5.x OLE2 container reading (through kordoc) |
| [React](https://github.com/facebook/react) / React DOM | 18.3.1 | MIT | Screen rendering (`electron/design/vendor/`, licenses next to the files) |
| [Electron](https://github.com/electron/electron) | 41.10.7 | MIT | App runtime; Chromium and its components are listed in `LICENSES.chromium.html` next to the executable |

kordoc includes code derived from other projects under MIT and Apache-2.0 (rhwp, hml-equation-parser,
OpenDataLoader PDF, claw-hwp, hwp-auto-docfit, korean-report-hwpx and others); its `NOTICE` and
`THIRD_PARTY/` files, bundled with it, carry those attributions.

## Dual or other licenses

| Package | License | Note |
| --- | --- | --- |
| jszip 3.10.2 | MIT OR GPL-3.0-or-later | Used under the MIT option, as kordoc also states. |
| pako 1.0.11 | MIT AND Zlib | Both permissive. |
| type-fest 0.20.2 | MIT OR CC0-1.0 | Used under MIT. |
| argparse 2.0.1 | Python-2.0 (PSF) | Permissive, keeps its notice. |

## Not shipped

- kordoc's optional PDF, OCR and formula-recognition features (pdfjs-dist, sharp with LGPL-3.0 libvips,
  onnxruntime, model weights) are excluded from the packaged app and are not called by hwp2x.
- No fonts are bundled: the screen uses fonts already installed on the system.
- `electron/native/FilePathCheckerModule.c` and its built DLLs are hwp2x's own code (Apache-2.0).
- The app logo and icons are hwp2x's own assets.
