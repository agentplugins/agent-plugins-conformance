import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const errorFacts = (error) => ({ code: error.code ?? null, message: error.message });

export function observeDataWrite(data) {
  if (!data || !isAbsolute(data)) return null;
  const observation = {
    path: join(data, `.agent-plugins-conformance-${randomUUID()}.tmp`),
    error: null,
    cleanupError: null,
  };
  let descriptor;
  let operation = 'create';
  try {
    descriptor = fs.openSync(observation.path, 'wx');
    operation = 'write';
    fs.writeFileSync(descriptor, 'Agent Plugins conformance write probe\n');
  } catch (error) {
    observation.error = { operation, ...errorFacts(error) };
  } finally {
    // Only a successful exclusive create grants ownership of this file.
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        observation.error ??= { operation: 'close', ...errorFacts(error) };
      }
      try {
        fs.unlinkSync(observation.path);
      } catch (error) {
        observation.cleanupError = errorFacts(error);
      }
    }
  }
  return observation;
}
