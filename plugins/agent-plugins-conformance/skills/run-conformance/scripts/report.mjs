import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
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

async function readReport(outputPath) {
  let saved;
  try {
    saved = JSON.parse(await readFile(outputPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Report does not exist; start collection first');
    throw error;
  }
  validateSavedReport(saved);
  validateInput({ schemaVersion: saved.schemaVersion, observations: saved.observations });
  return saved;
}

async function withReportLock(outputPath, update) {
  const lockPath = `${outputPath}.lock`;
  const staleAfter = 10_000;
  const deadline = performance.now() + 15_000;
  const candidate = await mkdtemp(`${lockPath}-`);
  const owner = randomUUID();
  try {
    await writeFile(join(candidate, owner), '', { flag: 'wx', mode: 0o600 });
    for (;;) {
      const now = new Date();
      await utimes(join(candidate, owner), now, now);
      try {
        // Publish an already nonempty directory so cleanup cannot remove a new owner.
        await rename(candidate, lockPath);
        break;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        let owners;
        try {
          owners = await readdir(lockPath);
        } catch (readError) {
          if (readError.code !== 'ENOENT') throw readError;
          owners = [];
        }
        if (owners.length > 1 || (owners.length === 1 && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(owners[0]))) {
          throw new Error(`Unexpected report lock contents: ${lockPath}`);
        }
        // A stale observer can remove only the owner it actually inspected.
        if (owners.length) {
          const ownerPath = join(lockPath, owners[0]);
          try {
            if (Date.now() - (await stat(ownerPath)).mtimeMs > staleAfter) await unlink(ownerPath);
          } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') throw cleanupError;
          }
        }
        await removeEmptyLock(lockPath);
        if (performance.now() >= deadline) {
          throw new Error(`Timed out waiting for report lock: ${lockPath}. Retry the recording.`);
        }
        await setTimeout(25 + Math.random() * 50);
      }
    }
    try {
      await update();
    } finally {
      await rm(join(lockPath, owner), { force: true });
      await removeEmptyLock(lockPath);
    }
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
}

async function removeEmptyLock(lockPath) {
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
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
  let incoming;
  if (message.action === 'start') {
    await mkdir(dirname(outputPath), { recursive: true });
  } else {
    // Validate all saved and incoming evidence before making a health request.
    await readReport(outputPath);
    incoming = message.observation;
    validateInput({ schemaVersion: 1, observations: [incoming] }, { recording: true });
    // Network latency must not hold up other recordings.
    if (incoming.kind === 'mcp-streamable-http') {
      incoming = { ...incoming, serverHealthCheck: await checkHttpHealth() };
    }
  }
  // Parent aliases must use the same lock and publication destination.
  const destination = join(await realpath(dirname(outputPath)), basename(outputPath));
  await withReportLock(destination, async () => {
    let report;
    if (message.action === 'start') {
      report = buildReport({ schemaVersion: 1, observations: [] });
    } else {
      // Re-read inside the lock; the preflight snapshot may already be obsolete.
      const saved = await readReport(destination);
      const key = observationKey(incoming);
      const observations = saved.observations.filter((existing) => observationKey(existing) !== key);
      observations.push(incoming);
      report = buildReport({ schemaVersion: saved.schemaVersion, observations });
    }
    await writeReport(destination, report);
  });
  console.log(message.action === 'start' ? 'Report started.' : 'Observation recorded.');
} catch (error) {
  console.error(`Report error: ${error.message}`);
  process.exitCode = 2;
}
