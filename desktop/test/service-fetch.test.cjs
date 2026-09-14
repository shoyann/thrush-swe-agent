const test = require("node:test");
const assert = require("node:assert/strict");
const { serviceFetch } = require("../service-fetch.cjs");
const reset = () =>
  Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
test("loopback reads recover once from a reset connection and disable socket reuse", async () => {
  let calls = 0;
  const response = await serviceFetch(
    "http://127.0.0.1:1234/api/projects",
    { headers: { authorization: "Bearer fixture" } },
    async (_url, init) => {
      assert.equal(init.headers.get("connection"), "close");
      assert.equal(init.headers.get("authorization"), "Bearer fixture");
      if (++calls === 1) throw reset();
      return new Response("ok");
    },
  );
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 2);
});
test("loopback transport never replays mutations, aborted reads, or repeated failures", async () => {
  for (const options of [
    { method: "POST" },
    { method: "DELETE" },
    { signal: AbortSignal.abort() },
  ]) {
    let calls = 0;
    await assert.rejects(
      serviceFetch("http://127.0.0.1:1234", options, async () => {
        calls++;
        throw reset();
      }),
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(
    serviceFetch("http://127.0.0.1:1234", {}, async () => {
      calls++;
      throw reset();
    }),
  );
  assert.equal(calls, 2);
});
