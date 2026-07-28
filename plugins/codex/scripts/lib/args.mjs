export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const stopAtFirstPositional = config.stopAtFirstPositional ?? false;
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      if (stopAtFirstPositional) {
        positionals.push(...argv.slice(index));
        break;
      }
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      if (stopAtFirstPositional) {
        positionals.push(...argv.slice(index));
        break;
      }
      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    if (stopAtFirstPositional) {
      positionals.push(...argv.slice(index));
      break;
    }
    positionals.push(token);
  }

  return { options, positionals };
}

const DEFAULT_RAW_VALUE_OPTIONS = [
  "args-file",
  "base",
  "cwd",
  "effort",
  "job-id",
  "model",
  "poll-interval-ms",
  "prompt-file",
  "scope",
  "source",
  "timeout-ms"
];

const DEFAULT_RAW_BOOLEAN_OPTIONS = [
  "all",
  "background",
  "disable-review-gate",
  "enable-review-gate",
  "fresh",
  "json",
  "resume",
  "resume-last",
  "wait",
  "write"
];

function readRawToken(raw, start) {
  let current = "";
  let quote = null;

  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];

    if (quote) {
      if (character === "\\" && raw[index + 1] === quote) {
        current += quote;
        index += 1;
        continue;
      }
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (/\s/.test(character)) {
      return { token: current, end: index };
    }

    if ((character === "'" || character === "\"") && (current === "" || current.endsWith("="))) {
      quote = character;
      continue;
    }

    current += character;
  }

  return { token: current, end: raw.length };
}

function splitAllRawArguments(raw) {
  const tokens = [];
  let index = 0;

  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index])) {
      index += 1;
    }
    if (index >= raw.length) {
      break;
    }
    const parsed = readRawToken(raw, index);
    tokens.push(parsed.token);
    index = parsed.end;
  }

  return tokens;
}

export function splitRawArgumentString(raw, config = {}) {
  const preserveRemainder = config.preserveRemainder ?? true;
  if (!preserveRemainder) {
    return splitAllRawArguments(raw);
  }

  const valueOptions = new Set(config.valueOptions ?? DEFAULT_RAW_VALUE_OPTIONS);
  const booleanOptions = new Set(config.booleanOptions ?? DEFAULT_RAW_BOOLEAN_OPTIONS);
  const aliasMap = config.aliasMap ?? { C: "cwd", m: "model" };
  const tokens = [];
  let index = 0;

  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index])) {
      index += 1;
    }
    if (index >= raw.length) {
      break;
    }

    const tokenStart = index;
    const parsed = readRawToken(raw, index);
    const token = parsed.token;

    if (token === "--") {
      tokens.push(token);
      index = parsed.end;
      while (index < raw.length && /\s/.test(raw[index])) {
        index += 1;
      }
      if (index < raw.length) {
        tokens.push(raw.slice(index));
      }
      break;
    }

    let rawKey = null;
    let inlineValue;
    if (token.startsWith("--")) {
      [rawKey, inlineValue] = token.slice(2).split("=", 2);
    } else if (token.startsWith("-") && token !== "-") {
      rawKey = token.slice(1);
    }

    const key = rawKey === null ? null : (aliasMap[rawKey] ?? rawKey);
    if (key === null || (!valueOptions.has(key) && !booleanOptions.has(key))) {
      tokens.push(raw.slice(tokenStart));
      break;
    }

    tokens.push(token);
    index = parsed.end;
    if (!valueOptions.has(key) || inlineValue !== undefined) {
      continue;
    }

    while (index < raw.length && /\s/.test(raw[index])) {
      index += 1;
    }
    if (index >= raw.length) {
      break;
    }
    const value = readRawToken(raw, index);
    tokens.push(value.token);
    index = value.end;
  }

  return tokens;
}
