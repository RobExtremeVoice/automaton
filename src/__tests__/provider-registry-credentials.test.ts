import { afterEach, describe, expect, it } from "vitest";
import { ProviderRegistry } from "../inference/provider-registry.js";

const saved = {
  openai: process.env.OPENAI_API_KEY,
  groq: process.env.GROQ_API_KEY,
  together: process.env.TOGETHER_API_KEY,
};

afterEach(() => {
  if (saved.openai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = saved.openai;
  if (saved.groq === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = saved.groq;
  if (saved.together === undefined) delete process.env.TOGETHER_API_KEY;
  else process.env.TOGETHER_API_KEY = saved.together;
});

describe("ProviderRegistry credential routing", () => {
  it("skips the preferred fast provider when its key is missing", () => {
    process.env.OPENAI_API_KEY = "sk-test-openai";
    delete process.env.GROQ_API_KEY;
    delete process.env.TOGETHER_API_KEY;

    const resolved = ProviderRegistry
      .fromConfig("/tmp/nonexistent-provider-config.json")
      .resolveModel("fast");

    expect(resolved.provider.id).toBe("openai");
    expect(resolved.model.id).toBe("gpt-4.1-mini");
  });

  it("does not expose remote providers without credentials", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.TOGETHER_API_KEY;

    const candidates = ProviderRegistry
      .fromConfig("/tmp/nonexistent-provider-config.json")
      .resolveCandidates("fast");

    expect(candidates).toEqual([]);
  });
});
