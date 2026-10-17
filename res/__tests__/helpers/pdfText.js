/**
 * Reads a PDF from stdin and prints { text, pages } as JSON.
 *
 * Run as a separate node process by the tests: pdf-parse loads pdf.js through a
 * dynamic ESM import, which Jest's module system refuses.
 */
const { PDFParse } = require("pdf-parse");

(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const parser = new PDFParse({ data: Buffer.concat(chunks) });
  try {
    const result = await parser.getText();
    process.stdout.write(JSON.stringify({ text: result.text, pages: result.total ?? result.pages?.length ?? 0 }));
  } finally {
    await parser.destroy().catch(() => {});
  }
})().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exit(1);
});
