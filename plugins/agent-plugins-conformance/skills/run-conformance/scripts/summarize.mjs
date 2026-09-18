import path from 'node:path';
import { open } from 'node:fs/promises';
import { escapeText, formatReport } from '../../../src/report-format.mjs';

try {
  const [filename, ...extra] = process.argv.slice(2);
  if (!filename || !path.isAbsolute(filename) || extra.length) {
    throw new Error('Usage: node summarize.mjs /absolute/path/to/report.json');
  }
  const file = await open(filename, 'r');
  let text;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Report must be a file');
    text = await file.readFile('utf8');
  } finally {
    await file.close();
  }
  console.log(formatReport(JSON.parse(text)));
} catch (error) {
  console.error(`Summary error: ${escapeText(error.message)}`);
  process.exitCode = 2;
}
