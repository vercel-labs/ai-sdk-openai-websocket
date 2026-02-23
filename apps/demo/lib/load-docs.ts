import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

export function loadDocsFromDisk(
  baseDir: string,
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const filePath of walkDir(baseDir)) {
    const rel = relative(baseDir, filePath);
    files[rel] = readFileSync(filePath, 'utf-8');
  }
  return files;
}
