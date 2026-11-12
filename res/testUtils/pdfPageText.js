// Prints a PDF's text, one entry per page, as JSON. Tests run it in its own process because
// pdf-parse's PDF engine is an ES module that jest's sandbox cannot load.
const { PDFParse } = require("pdf-parse");

let input = [];
process.stdin.on("data", (chunk) => input.push(chunk));
process.stdin.on("end", async () => {
  const result = await new PDFParse({ data: Buffer.concat(input) }).getText();
  process.stdout.write(JSON.stringify(result.pages.map((p) => p.text)));
});
