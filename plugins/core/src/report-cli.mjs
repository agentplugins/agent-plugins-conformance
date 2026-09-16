import { readFile, stat } from 'node:fs/promises';
import { buildReport, formatReport, MAX_INPUT_BYTES } from './report.mjs';

try {
  const [filename, option, ...extra] = process.argv.slice(2);
  if (!filename || filename.startsWith('--') || (option !== undefined && option !== '--json') || extra.length) {
    throw new Error('Usage: node src/report-cli.mjs observations.json [--json]');
  }
  const info = await stat(filename);
  if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new Error(`Input must be a file of at most ${MAX_INPUT_BYTES} bytes`);
  const report = buildReport(JSON.parse(await readFile(filename, 'utf8')));
  console.log(option === '--json' ? JSON.stringify(report, null, 2) : formatReport(report));
} catch (error) {
  console.error(`Report error: ${error.message}`);
  process.exitCode = 2;
}
