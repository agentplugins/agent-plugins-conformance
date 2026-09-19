import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { buildReport, observationKey, validateInput } from '../../../src/report.mjs';
import { validateSavedReport } from '../../../src/report-format.mjs';
import { checkHttpHealth } from '../../../src/http-health.mjs';

function validateMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Input must be an object');
  }
  if (message.action === 'start') {
    if (Object.keys(message).length !== 1) throw new Error('start requires only action');
  } else if (message.action === 'record') {
    if (Object.keys(message).length !== 2 || !Object.hasOwn(message, 'observation')) {
      throw new Error('record requires only action and observation');
    }
  } else {
    throw new Error('action must be start or record');
  }
}

async function writeReport(outputPath, report) {
  const content = `${JSON.stringify(report, null, 2)}\n`;
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
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  validateMessage(message);
  let report;
  if (message.action === 'start') {
    report = buildReport({ schemaVersion: 1, observations: [] });
    await mkdir(dirname(outputPath), { recursive: true });
  } else {
    let saved;
    try {
      saved = JSON.parse(await readFile(outputPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Report does not exist; start collection first');
      throw error;
    }
    validateSavedReport(saved);
    // Validate all saved and incoming evidence before making a health request.
    validateInput({ schemaVersion: saved.schemaVersion, observations: saved.observations });
    const incoming = message.observation;
    validateInput({ schemaVersion: 1, observations: [incoming] }, { recording: true });
    const key = observationKey(incoming);
    const observations = saved.observations.filter((existing) => observationKey(existing) !== key);
    observations.push(incoming.kind === 'mcp-streamable-http'
      ? { ...incoming, serverHealthCheck: await checkHttpHealth() } : incoming);
    report = buildReport({ schemaVersion: saved.schemaVersion, observations });
  }
  await writeReport(outputPath, report);
  console.log(message.action === 'start' ? 'Report started.' : 'Observation recorded.');
} catch (error) {
  console.error(`Report error: ${error.message}`);
  process.exitCode = 2;
}
