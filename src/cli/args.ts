/** A tiny argument parser. The scraper needs a handful of flags, not a framework. */

export interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined || !token.startsWith('--')) continue;
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      index += 1;
    } else {
      flags.set(body, 'true');
    }
  }

  return { command, flags };
}

export function str(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return value === undefined || value === '' ? undefined : value;
}

export function int(args: ParsedArgs, name: string, fallback: number): number {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`--${name} must be an integer, got ${value}`);
  return parsed;
}

export function bool(args: ParsedArgs, name: string, fallback: boolean): boolean {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
