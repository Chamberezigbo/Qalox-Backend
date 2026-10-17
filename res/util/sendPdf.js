/** A file name that is safe in a Content-Disposition header: letters, numbers, dashes. */
const safeFileName = (name, fallback = "document") => {
  const cleaned = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${cleaned || fallback}.pdf`;
};

/**
 * Sends PDF bytes as a download. `inline` opens it in the browser's own viewer
 * instead, which is what "print all" uses.
 */
function sendPdf(res, buffer, name, { inline = false } = {}) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${safeFileName(name)}"`);
  // These are children's results: never cached by a shared proxy.
  res.setHeader("Cache-Control", "private, no-store");
  res.end(buffer);
}

module.exports = { sendPdf, safeFileName };
