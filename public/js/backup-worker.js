import { collectionTable, encodeCsv, parseDelimited, tableToBackup, validateBackup, MAX_TABLE_ROWS } from "./backup-formats.js";

self.onmessage = async ({ data }) => {
  try {
    let result;
    if (data.action === "parse") {
      const bytes = new Uint8Array(data.buffer);
      const prefix = new TextDecoder().decode(bytes.subarray(0,256)).replace(/^\ufeff/,"").trimStart();
      if (prefix.startsWith("{") || prefix.startsWith("[")) result = await validateBackup(JSON.parse(new TextDecoder().decode(bytes)));
      else if ((bytes[0] === 0x50 && bytes[1] === 0x4b) || bytes[0] === 0xd0 || /^\s*<\?xml/i.test(prefix)) {
        const XLSX = await import("../vendor/xlsx-0.20.3.mjs");
        const workbook = XLSX.read(data.buffer,{type:"array",cellDates:true,cellFormula:true,sheetRows:MAX_TABLE_ROWS+2});
        const candidates = workbook.SheetNames.filter((name,index) => workbook.Workbook?.Sheets?.[index]?.Hidden !== 1 && workbook.Sheets[name]?.["!ref"]);
        const name = candidates.includes("Collection") ? "Collection" : candidates[0];
        if (!name) throw new Error("This workbook has no visible data sheet.");
        const sheet = workbook.Sheets[name], issues = [];
        if (candidates.length > 1) issues.push({severity:"warning",row:null,message:`Reading the “${name}” worksheet. Other worksheets are not imported.`});
        for (const [address,cell] of Object.entries(sheet)) {
          if (address.startsWith("!") || !cell?.f) continue;
          issues.push({severity:cell.v === undefined ? "error" : "warning",row:null,message:`${name}!${address} contains a formula. ${cell.v === undefined ? "Replace it with a value before importing." : "Its saved value will be imported; formulas are not calculated."}`});
        }
        const rows = XLSX.utils.sheet_to_json(sheet,{header:1,defval:"",raw:true,blankrows:false});
        result = await tableToBackup(rows,{extraIssues:issues});
      } else result = await tableToBackup(parseDelimited(new TextDecoder().decode(bytes)),{csv:true});
    } else if (data.action === "xlsx") {
      const XLSX = await import("../vendor/xlsx-0.20.3.mjs");
      const table = collectionTable(data.tapes,data.options);
      const sheet = XLSX.utils.aoa_to_sheet(table,{cellDates:true});
      sheet["!autofilter"] = {ref:sheet["!ref"]};
      sheet["!cols"] = table[0].map((label) => ({wch:label === "Title" ? 36 : ["Notes","Plot"].includes(label) ? 48 : 22}));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook,sheet,"Collection");
      result = XLSX.write(workbook,{type:"array",bookType:"xlsx",compression:true});
    } else if (data.action === "csv") result = encodeCsv(collectionTable(data.tapes,data.options));
    else if (data.action === "json") result = JSON.stringify(data.backup,null,2);
    else throw new Error("Unknown file operation.");
    self.postMessage({result}, result instanceof ArrayBuffer ? [result] : []);
  } catch (error) { self.postMessage({error:error.message || "This file could not be processed."}); }
};
