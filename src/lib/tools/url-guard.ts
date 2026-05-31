const ipv4Pattern = /^(\d{1,3})(?:\.(\d{1,3})){3}$/;

export function assertSafeUrl(url: string): void {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Blocked unsafe URL: URL must start with http:// or https://.");
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error("Blocked unsafe URL: only http:// and https:// URLs are allowed.");
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host === "::1") {
    throw new Error(`Blocked unsafe URL: hostname "${parsed.hostname}" is not allowed.`);
  }

  const ipv4Match = host.match(ipv4Pattern);
  if (ipv4Match) {
    const octets = host.split(".").map(Number);
    const [a, b] = octets;

    if (
      octets.some((octet) => octet < 0 || octet > 255) ||
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    ) {
      throw new Error(`Blocked unsafe URL: hostname "${parsed.hostname}" is in a private or loopback range.`);
    }

    return;
  }

  if (
    host.includes(":") &&
    (/^fc/i.test(host) || /^fd/i.test(host) || /^fe[89ab]/i.test(host))
  ) {
    throw new Error(`Blocked unsafe URL: hostname "${parsed.hostname}" is in a private or loopback range.`);
  }
}
