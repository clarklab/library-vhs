// Library export: one canonical column set, emitted as CSV or as an
// Excel-openable .xls (SpreadsheetML 2003 XML — no libraries needed).

import { toCsv, downloadFile, statusLabel, conditionLabel, esc } from "./util.js";

export const EXPORT_HEADERS = [
  "Title", "Year", "Director", "Actors", "Genre", "Runtime", "Rated", "Studio/Label",
  "Edition", "Packaging", "Sealed", "Condition", "Status", "Price Paid", "Asking Price",
  "Sold Price", "Sold Date", "Location", "Where Acquired", "Date Acquired",
  "Barcode", "Notes", "IMDb Rating", "IMDb ID", "Added",
];

export function exportRows(tapes) {
  return tapes.map((t) => [
    t.title, t.year ?? "", t.director, (t.actors || []).join("; "), t.genre, t.runtime,
    t.rated, t.label || "", t.edition, t.packaging || "",
    t.sealed || t.condition === "sealed" ? "yes" : "no",
    conditionLabel(t.condition) === "—" ? "" : t.condition,
    statusLabel(t.status), t.pricePaid ?? "", t.priceAsking ?? "", t.priceSold ?? "",
    t.soldDate ?? "", t.location, t.acquiredFrom || "", t.acquiredDate || "",
    t.barcode, t.notes, t.imdbRating, t.imdbId,
    (t.createdAt || "").slice(0, 10),
  ]);
}

const stamp = () => new Date().toISOString().slice(0, 10);

export function exportCsv(tapes) {
  downloadFile(`vhs-vault-${stamp()}.csv`, toCsv([EXPORT_HEADERS, ...exportRows(tapes)]));
}

export function exportXls(tapes) {
  const rows = exportRows(tapes);
  const cell = (value) => {
    const isNumber = typeof value === "number" && Number.isFinite(value);
    const type = isNumber ? "Number" : "String";
    const text = isNumber ? String(value) : esc(String(value ?? ""));
    return `<Cell><Data ss:Type="${type}">${text}</Data></Cell>`;
  };
  const row = (cells, style = "") =>
    `<Row${style}>${cells.map(cell).join("")}</Row>`;

  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="head"><Font ss:Bold="1"/></Style>
 </Styles>
 <Worksheet ss:Name="VHS Vault">
  <Table>
${row(EXPORT_HEADERS, ' ss:StyleID="head"')}
${rows.map((r) => row(r)).join("\n")}
  </Table>
 </Worksheet>
</Workbook>`;
  downloadFile(`vhs-vault-${stamp()}.xls`, xml, "application/vnd.ms-excel");
}
