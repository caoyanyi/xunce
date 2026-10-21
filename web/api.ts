export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
  return value;
}
