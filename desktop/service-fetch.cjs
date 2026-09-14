// Keep each loopback request independent of idle sockets closed by Next.js.
async function serviceFetch(url, options = {}, fetchImpl = globalThis.fetch) {
  const headers = new Headers(options.headers);
  headers.set("connection", "close");
  const request = { ...options, headers };
  try {
    return await fetchImpl(url, request);
  } catch (error) {
    const method = (options.method || "GET").toUpperCase();
    const reset = ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(
      error.cause?.code,
    );
    // A failed write may already have taken effect. Never replay it.
    if (!["GET", "HEAD"].includes(method) || !reset || options.signal?.aborted)
      throw error;
    return fetchImpl(url, request);
  }
}
module.exports = { serviceFetch };
