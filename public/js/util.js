// Shared front-end helpers.

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function money(value) {
  if (value === null || value === undefined || value === "" || Number.isNaN(Number(value))) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Reads a File and returns a resized JPEG data URL suitable for AI vision. */
export function resizeImage(file, maxDim = 1568, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that image."));
    };
    img.src = url;
  });
}

// ---------- CSV ----------

/** Tiny CSV parser handling quotes, escaped quotes, CRLF. Returns array of rows. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

export function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = String(cell ?? "");
          return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
        })
        .join(",")
    )
    .join("\r\n");
}

export function downloadFile(filename, text, type = "text/csv") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Parses "Title (1987)" / "Title, 1987" / "Title - 1987" bulk lines. */
export function parseBulkLine(line) {
  // Strip list markers ("-", "*", "3.", "12)") but never digits that are part
  // of the title itself ("10 Things…", "2001: A Space Odyssey", "48 Hrs.").
  const trimmed = line.trim().replace(/^(?:[-*•]|\d{1,3}[.)])\s+/, "").trim();
  if (!trimmed) return null;
  let match = trimmed.match(/^(.+?)\s*[([]\s*(\d{4})\s*[)\]]\s*$/);
  if (match) return { title: match[1].trim(), year: Number(match[2]) };
  match = trimmed.match(/^(.+?)\s*[,–—-]\s*(\d{4})$/);
  if (match) return { title: match[1].trim(), year: Number(match[2]) };
  return { title: trimmed, year: null };
}

export function statusLabel(status) {
  return { available: "For Sale", sold: "Sold", hold: "On Hold", keep: "Keeper" }[status] || "For Sale";
}

export function conditionLabel(condition) {
  return (
    { sealed: "Sealed", mint: "Mint", good: "Good", fair: "Fair", poor: "Poor" }[condition] || "—"
  );
}
