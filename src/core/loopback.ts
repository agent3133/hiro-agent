/** Whether *host* (as a URL gives it, IPv6 in brackets) is this computer: localhost, 127.x.x.x, ::1 (#408, #407). */
export function isLoopbackHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(bare)
    || bare === "::1" || bare === "0:0:0:0:0:0:0:1" || /^::ffff:127(\.\d{1,3}){3}$/.test(bare);
}

/** Whether *url* points at this computer; false for one that does not parse. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url.trim()).hostname);
  } catch {
    return false;
  }
}
