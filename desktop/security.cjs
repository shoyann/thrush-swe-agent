const crypto = require("node:crypto");
function trustedUrl(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "thrush:" &&
      u.hostname === "app" &&
      !u.port &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
function externalUrl(value) {
  try {
    const u = new URL(value);
    return (
      ["https:", "http:"].includes(u.protocol) && !u.username && !u.password
    );
  } catch {
    return false;
  }
}
function redact(text, secrets = []) {
  let result = String(text);
  for (const secret of secrets.filter(Boolean))
    result = result.split(secret).join("[redacted]");
  return result
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, "[redacted]");
}
function credentials() {
  return {
    token: crypto.randomBytes(32).toString("hex"),
    instance: crypto.randomUUID(),
  };
}
function validateSettings(value, distributions) {
  if (!value || !["native", "wsl"].includes(value.environment))
    throw new Error("Choose Windows or WSL.");
  if (
    value.environment === "wsl" &&
    !distributions.includes(value.distribution)
  )
    throw new Error("Choose an installed Ubuntu distribution.");
  if (!["deepseek", "openai", "anthropic"].includes(value.provider))
    throw new Error("Unsupported model provider.");
  if (
    typeof value.model !== "string" ||
    value.model.length > 200 ||
    !value.model.trim()
  )
    throw new Error("Enter a model name.");
  if (value.baseURL) {
    const u = new URL(value.baseURL);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw new Error("Enter an HTTP(S) API URL without credentials.");
  }
  if (value.provider === "anthropic" && !value.baseURL)
    throw new Error(
      "Anthropic currently requires an OpenAI-compatible gateway URL.",
    );
  if (
    value.apiKey !== undefined &&
    (typeof value.apiKey !== "string" ||
      value.apiKey.length > 4096 ||
      /[\r\n]/.test(value.apiKey))
  )
    throw new Error("Invalid API key.");
  return {
    environment: value.environment,
    distribution: value.environment === "wsl" ? value.distribution : "",
    provider: value.provider,
    model: value.model.trim(),
    baseURL: String(value.baseURL || "").trim(),
    configured: true,
  };
}
module.exports = {
  trustedUrl,
  externalUrl,
  redact,
  credentials,
  validateSettings,
};
