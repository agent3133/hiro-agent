/** Whether *url* points at the network: a scheme other than the vault's own (`app:`) and inline `data:` (#137). */
export function isRemote(url: string): boolean {
  const trimmed = url.trim().replace(/^<|>$/g, "").trim();
  if (trimmed.startsWith("//")) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  return scheme !== undefined && scheme !== "app" && scheme !== "data" && !/^[a-z]$/i.test(scheme);
}
