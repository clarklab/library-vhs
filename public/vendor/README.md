# SheetJS Community Edition

Locally vendored browser ES module, version 0.20.3, Apache-2.0 license.

- Official source: https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs
- Documentation: https://docs.sheetjs.com/docs/getting-started/installation/standalone/
- SHA-256: `1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db`

Loaded only inside a module worker for spreadsheet import/export. No runtime CDN request.

# ZXing TypeScript library

Locally vendored UMD build, version 0.23.0, Apache-2.0 license (see `ZXING-LICENSE`).

- Official source: https://registry.npmjs.org/@zxing/library/-/library-0.23.0.tgz (`umd/index.min.js`)
- Repository: https://github.com/zxing-js/library
- SHA-256: `3ede94153fb0c5b67a12d7adff6decd827c2b22714fdc6faecf27a8f20937ea6`

Loaded on demand by the barcode scanner only when the browser has no native `BarcodeDetector` (for example iOS Safari). No runtime CDN request.
