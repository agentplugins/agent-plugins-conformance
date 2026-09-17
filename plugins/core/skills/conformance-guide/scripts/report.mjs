import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { buildReport, MAX_INPUT_BYTES } from '../../../src/report.mjs';
import { MAX_REPORT_BYTES, validateSavedReport } from '../../../src/report-format.mjs';

async function readBounded(stream, limit, label) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error(`${label} exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validateMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Input must be an object');
  }
  const field = message.action === 'start' ? 'client' : message.action === 'record' ? 'observation' : null;
  if (!field) throw new Error('action must be start or record');
  if (Object.keys(message).length !== 2 || !Object.hasOwn(message, field)) {
    throw new Error(`${message.action} requires only action and ${field}`);
  }
}

async function writeReport(outputPath, report) {
  const content = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_REPORT_BYTES) throw new Error(`Report exceeds ${MAX_REPORT_BYTES} bytes`);
  // A sibling temporary file keeps replacement on the destination filesystem.
  const temporary = join(dirname(outputPath), `.conformance-report-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporary, outputPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

try {
  const [outputPath, ...extra] = process.argv.slice(2);
  if (!outputPath || !isAbsolute(outputPath) || extra.length) {
    throw new Error('Usage: node report.mjs <absolute-output-path> (one start or record JSON message on stdin)');
  }
  const message = await readBounded(process.stdin, MAX_INPUT_BYTES, 'Input');
  validateMessage(message);
  let report;
  if (message.action === 'start') {
    report = buildReport({ schemaVersion: 1, client: message.client, observations: [] });
    await mkdir(dirname(outputPath), { recursive: true });
  } else {
    let saved;
    try {
      saved = await readBounded(createReadStream(outputPath, { end: MAX_REPORT_BYTES }), MAX_REPORT_BYTES, 'Saved report');
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Report does not exist; start collection first');
      throw error;
    }
    validateSavedReport(saved);
    buildReport({ schemaVersion: saved.schemaVersion, client: saved.client, observations: saved.observations });
    // Validate the complete new observation before deriving its replacement key.
    buildReport({ schemaVersion: 1, client: saved.client, observations: [message.observation] });
    const observation = message.observation;
    const sameKey = (existing) => existing.kind === observation.kind &&
      (observation.kind === 'skill' ? existing.skill === observation.skill : existing.server === observation.server);
    const observations = saved.observations.filter((existing) => !sameKey(existing));
    observations.push(observation);
    report = buildReport({ schemaVersion: saved.schemaVersion, client: saved.client, observations });
  }
  await writeReport(outputPath, report);
  console.log(message.action === 'start' ? 'Report started.' : 'Observation recorded.');
} catch (error) {
  console.error(`Report error: ${error.message}`);
  process.exitCode = 2;
}
