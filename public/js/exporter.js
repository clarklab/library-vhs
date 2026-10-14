import { collectionTable, COLUMNS, encodeCsv } from "./backup-formats.js";
import { fileWorker } from "./backup-io.js";
import { downloadFile } from "./util.js";
import { getToken } from "./api.js";

export const EXPORT_HEADERS = COLUMNS.map(([,label]) => label);
export const exportRows = (tapes,options = {}) => collectionTable(tapes,options).slice(1);
const stamp = () => new Date().toISOString().slice(0,10);
export function exportCsv(tapes,options = {}) {
  downloadFile(`vhs-vault-collection-${stamp()}.csv`,encodeCsv(collectionTable(tapes,options)),"text/csv;charset=utf-8");
}
export async function exportXlsx(tapes,options = {}) {
  const token = getToken();
  const buffer = await fileWorker("xlsx",{tapes,options});
  if (getToken() !== token) throw new Error("Your account changed. Export again from the current account.");
  downloadFile(`vhs-vault-collection-${stamp()}.xlsx`,buffer,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
// Preserve existing callers while replacing the old XML .xls with a real .xlsx.
export const exportXls = exportXlsx;
