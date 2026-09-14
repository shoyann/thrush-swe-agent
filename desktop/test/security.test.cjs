const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  trustedUrl,
  externalUrl,
  redact,
  credentials,
  validateSettings,
} = require("../security.cjs");
test("desktop bridge only trusts its exact custom origin", () => {
  assert.equal(trustedUrl("thrush://app/"), true);
  for (const url of [
    "https://app/",
    "thrush://evil/",
    "thrush://app:80/",
    "thrush://user@app/",
    "file:///C:/x",
    "javascript:alert(1)",
  ])
    assert.equal(trustedUrl(url), false, url);
});
test("external links cannot launch local executables or custom protocols", () => {
  assert.equal(
    externalUrl("https://github.com/shoyann/thrush-swe-agent"),
    true,
  );
  for (const url of [
    "file:///C:/Windows",
    "cmd:calc",
    "javascript:alert(1)",
    "https://user:secret@example.com",
  ])
    assert.equal(externalUrl(url), false);
});
test("credentials are unpredictable per launch and logs redact them", () => {
  const a = credentials(),
    b = credentials();
  assert.notEqual(a.token, b.token);
  assert.equal(a.token.length, 64);
  assert.equal(
    redact("key SECRET Bearer " + a.token, ["SECRET", a.token]),
    "key [redacted] Bearer [redacted]",
  );
});
test("settings reject unknown runtimes, distro injection and credential URLs", () => {
  const valid = {
    environment: "native",
    provider: "deepseek",
    model: "model",
    baseURL: "",
  };
  assert.equal(validateSettings(valid, []).environment, "native");
  assert.throws(() =>
    validateSettings(
      { ...valid, environment: "wsl", distribution: "Ubuntu;rm -rf /" },
      ["Ubuntu"],
    ),
  );
  assert.throws(() =>
    validateSettings(
      { ...valid, baseURL: "https://user:secret@example.com" },
      [],
    ),
  );
  assert.throws(() =>
    validateSettings({ ...valid, provider: "anthropic" }, []),
  );
});
