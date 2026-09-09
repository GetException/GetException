export class BoundaryError extends Error {
  constructor(
    public readonly reason: "invalid" | "too_large" | "unsupported" = "invalid",
  ) {
    super(reason);
    this.name = "BoundaryError";
  }
}

export const LIMITS = {
  envelope: 1_310_720,
  item: 1_048_576,
  depth: 16,
  fields: 2048,
  array: 512,
  string: 4096,
} as const;

const forbidden = new Set(["__proto__", "constructor", "prototype"]);

/** Recursive descent with budgets enforced BEFORE allocating objects or parsing strings. */
export function boundedJson(
  text: string,
  maxBytes: number = LIMITS.item,
): unknown {
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new BoundaryError("too_large");
  }

  let i = 0;
  let fields = 0;
  const fail = (): never => {
    throw new BoundaryError();
  };
  const whitespace = () => {
    while (i < text.length && /[\x20\t\r\n]/.test(text[i]!)) {
      i++;
    }
  };

  function string(): string {
    const start = i++;
    let length = 0;

    while (i < text.length) {
      const c = text[i++];

      if (c === '"') {
        const result: unknown = JSON.parse(text.slice(start, i));

        if (typeof result !== "string" || result.length > LIMITS.string) {
          fail();
        }

        return result as string;
      }

      if (++length > LIMITS.string * 6) {
        throw new BoundaryError("too_large");
      }

      if (c === "\\") {
        i++;
      } else if (c!.charCodeAt(0) < 32) {
        fail();
      }
    }

    return fail();
  }

  function value(depth: number): unknown {
    if (depth > LIMITS.depth) {
      throw new BoundaryError("too_large");
    }

    whitespace();
    const c = text[i];

    if (c === '"') {
      return string();
    }

    if (c === "{") {
      i++;
      whitespace();
      const out: Record<string, unknown> = Object.create(null);

      if (text[i] === "}") {
        i++;

        return out;
      }

      while (i < text.length) {
        whitespace();

        if (text[i] !== '"') {
          fail();
        }

        const key = string();

        if (
          forbidden.has(key) ||
          Object.hasOwn(out, key) ||
          ++fields > LIMITS.fields
        ) {
          fail();
        }

        whitespace();

        if (text[i++] !== ":") {
          fail();
        }

        out[key] = value(depth + 1);
        whitespace();
        const end = text[i++];

        if (end === "}") {
          return out;
        }

        if (end !== ",") {
          fail();
        }
      }
    } else if (c === "[") {
      i++;
      whitespace();
      const out: unknown[] = [];

      if (text[i] === "]") {
        i++;

        return out;
      }

      while (i < text.length) {
        if (out.length >= LIMITS.array) {
          throw new BoundaryError("too_large");
        }

        out.push(value(depth + 1));
        whitespace();
        const end = text[i++];

        if (end === "]") {
          return out;
        }

        if (end !== ",") {
          fail();
        }
      }
    } else {
      const tail = text.slice(i, i + 64);

      for (const [literal, parsed] of [
        ["true", true],
        ["false", false],
        ["null", null],
      ] as const) {
        if (tail.startsWith(literal)) {
          i += literal.length;

          return parsed;
        }
      }

      const n = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(tail)?.[0];

      if (n && Number.isFinite(Number(n))) {
        i += n.length;

        return Number(n);
      }
    }

    return fail();
  }

  try {
    const result = value(0);

    whitespace();

    if (i !== text.length) {
      fail();
    }

    return result;
  } catch (error) {
    if (error instanceof BoundaryError) {
      throw error;
    }

    throw new BoundaryError();
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : Object.create(null);
}

export function parseEnvelope(bytes: Uint8Array): {
  event: unknown;
  eventId: string;
} {
  if (bytes.length > LIMITS.envelope) {
    throw new BoundaryError("too_large");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });

  try {
    const first = bytes.indexOf(10);
    const second = bytes.indexOf(10, first + 1);

    if (first < 1 || second <= first || first > 8192 || second - first > 8192) {
      throw new BoundaryError();
    }

    const header = record(
      boundedJson(decoder.decode(bytes.subarray(0, first)), 8192),
    );

    if (header.dsn !== undefined) {
      throw new BoundaryError("unsupported");
    }

    const item = record(
      boundedJson(decoder.decode(bytes.subarray(first + 1, second)), 8192),
    );

    if (item.type !== "event") {
      throw new BoundaryError("unsupported");
    }

    let body = bytes.subarray(second + 1);

    if (item.length !== undefined) {
      if (
        !Number.isInteger(item.length) ||
        Number(item.length) < 1 ||
        Number(item.length) > LIMITS.item
      ) {
        throw new BoundaryError();
      }

      const length = Number(item.length);

      if (
        body.length !== length &&
        !(body.length === length + 1 && body[length] === 10)
      ) {
        throw new BoundaryError();
      }

      body = body.subarray(0, length);
    }

    const event = record(boundedJson(decoder.decode(body)));
    const eventId = event.event_id ?? header.event_id;

    if (
      typeof eventId !== "string" ||
      !/^[a-f0-9]{32}$/.test(eventId) ||
      (header.event_id !== undefined && header.event_id !== eventId)
    ) {
      throw new BoundaryError();
    }

    return { event, eventId };
  } catch (error) {
    if (error instanceof BoundaryError) {
      throw error;
    }

    throw new BoundaryError();
  }
}
