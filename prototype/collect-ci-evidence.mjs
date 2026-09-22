import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Copy only evidence documents. Never recurse through the deliberately escaping fixture link.
const source = 'prototype/ci-evidence/results';
const destination = 'prototype/ci-artifact';
for (const directory of ['', 'escaping-symlink', 'safe-symlink', 'regular-file', 'directory-control']) {
  let entries;
  try { entries = await readdir(join(source, directory), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  await mkdir(join(destination, directory), { recursive: true });
  for (const entry of entries) {
    if (entry.isFile() && /\.(json|jsonl|log)$/.test(entry.name)) {
      await copyFile(join(source, directory, entry.name), join(destination, directory, entry.name));
    }
  }
}
