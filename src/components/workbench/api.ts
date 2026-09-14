export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok)
    throw new Error(
      [payload.error || `Request failed (${response.status})`, payload.detail]
        .filter(Boolean)
        .join(" "),
    );
  return payload as T;
}
export function post<T>(url: string, body: unknown) {
  return request<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
export function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please retry.";
}
