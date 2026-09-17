import type { BrowserContext } from "@getexception/protocol";

/** Read locally once; the full User-Agent never enters an event. */
export function browserContext(userAgent: string): BrowserContext | undefined {
  const text = userAgent.slice(0, 1024);
  const patterns: [BrowserContext["name"], RegExp][] = [
    ["Edge", /(?:Edg|EdgiOS|EdgA)\/(\d+)/],
    ["Opera", /(?:OPR|OPiOS)\/(\d+)/],
    ["Samsung Internet", /SamsungBrowser\/(\d+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
    ["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
    ["Safari", /Version\/(\d+).*Safari\//],
  ];

  for (const [name, pattern] of patterns) {
    const match = pattern.exec(text);
    const major = Number(match?.[1]);

    if (match && major >= 1 && major <= 9999) {
      return { name, major };
    }
  }

  return undefined;
}
