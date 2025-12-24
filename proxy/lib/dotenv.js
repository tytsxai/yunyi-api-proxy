import { readFileSync } from 'fs';

export function parseDotEnv(content) {
  const config = {};
  if (!content) return config;

  for (const rawLine of String(content).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2] ?? '';

    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (isQuoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }

    config[key] = value;
  }

  return config;
}

export function loadDotEnvFiles(envPaths = []) {
  const config = {};
  for (const envPath of envPaths) {
    try {
      const content = readFileSync(envPath, 'utf-8');
      Object.assign(config, parseDotEnv(content));
    } catch {
      // ignore missing/unreadable file
    }
  }
  return config;
}
