import path from 'node:path';
import { open } from 'node:fs/promises';
import { escapeText, formatReport, MAX_REPORT_BYTES } from '../../../src/report-format.mjs';

try {
  const [filename, ...extra] = process.argv.slice(2);
  if (!filename || !path.isAbsolute(filename) || extra.length) {
    throw new Error('Usage: node summarize.mjs /absolute/path/to/report.json');
  }
  const file = await open(filename, 'r');
  let bytes;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_REPORT_BYTES) {
      throw new Error(`Report must be a file of at most ${MAX_REPORT_BYTES} bytes`);
    }
    // The bounded read also covers a file growing after stat().
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_REPORT_BYTES) throw new Error(`Report exceeds ${MAX_REPORT_BYTES} bytes`);
    bytes = buffer.subarray(0, length);
  } finally {
    await file.close();
  }
  console.log(formatReport(JSON.parse(bytes.toString('utf8'))));
} catch (error) {
  console.error(`Summary error: ${escapeText(error.message)}`);
  process.exitCode = 2;
}
