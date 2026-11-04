// Anything matching these key names is replaced before it reaches stdout, so a
// stray `console.log(session)` cannot leak a cardholder or token value.
const SENSITIVE = /(secret|key|token|password|authorization|jwt|card|cvc|pan|email|referrer)/i;
const MASK = '***';

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return MASK;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { message: value.message, name: value.name };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE.test(k) ? MASK : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type Logger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

export function createLogger(scope: string, silent = false): Logger {
  const write = (level: string, message: string, meta?: Record<string, unknown>) => {
    if (silent) return;
    const line = { ts: new Date().toISOString(), level, scope, message, ...redact(meta ?? {}) as object };
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(line)}\n`);
  };
  return {
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
}
