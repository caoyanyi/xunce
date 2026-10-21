export function isAllowedOrigin(origin: string, authority: string): boolean {
  try {
    const url = new URL(origin);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.origin === origin &&
      (url.host === authority.toLowerCase() ||
        ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin))
    );
  } catch {
    return false;
  }
}
