import { describe, expect, it } from "vitest";
import {
  buildAgentsDefaultsModelsMap,
  CONFIG_REDACTED_SENTINEL,
  draftFromConfig,
  mergeModelProvidersIntoConfig,
  pickDefaultModelRef,
  type ModelProviderDraft,
} from "./model-providers.ts";

function draft(
  overrides: Omit<Partial<ModelProviderDraft>, "models"> & {
    models?: Array<{ id: string; name?: string }>;
  },
): ModelProviderDraft {
  const models = (overrides.models ?? [{ id: "m1", name: "M1" }]).map((m, i) => ({
    clientId: `m-${i}`,
    id: m.id,
    name: m.name ?? m.id,
  }));
  return {
    clientId: overrides.clientId ?? "p1",
    providerId: overrides.providerId ?? "dashscope",
    baseUrl: overrides.baseUrl ?? "https://example.com/v1",
    apiKey: overrides.apiKey ?? "",
    apiKeyWasRedacted: overrides.apiKeyWasRedacted ?? false,
    api: overrides.api ?? "openai-completions",
    models,
    retained: overrides.retained ?? {},
  };
}

describe("pickDefaultModelRef", () => {
  it("prefers current default when still valid", () => {
    const modelProviders = [
      draft({ providerId: "openai", models: [{ id: "gpt-5", name: "GPT-5" }] }),
    ];
    expect(
      pickDefaultModelRef({
        modelProviders,
        currentDefault: "openai/gpt-5",
      }),
    ).toBe("openai/gpt-5");
  });

  it("prefers qwen3.5-plus when default missing", () => {
    const modelProviders = [
      draft({
        providerId: "dashscope",
        models: [
          { id: "other", name: "Other" },
          { id: "qwen3.5-plus", name: "Qwen" },
        ],
      }),
    ];
    expect(
      pickDefaultModelRef({
        modelProviders,
        currentDefault: "",
      }),
    ).toBe("dashscope/qwen3.5-plus");
  });

  it("falls back to first ref", () => {
    const modelProviders = [
      draft({ providerId: "deepseek", models: [{ id: "chat", name: "Chat" }] }),
    ];
    expect(
      pickDefaultModelRef({
        modelProviders,
        currentDefault: "",
      }),
    ).toBe("deepseek/chat");
  });
});

describe("buildAgentsDefaultsModelsMap", () => {
  it("builds allowlist keys as provider/model", () => {
    const modelProviders = [
      draft({
        providerId: "A",
        models: [
          { id: "x", name: "X" },
          { id: "y", name: "Y" },
        ],
      }),
    ];
    const map = buildAgentsDefaultsModelsMap(modelProviders);
    expect(Object.keys(map).toSorted()).toEqual(["a/x", "a/y"]);
    expect(map["a/x"]).toEqual({});
  });
});

describe("mergeModelProvidersIntoConfig", () => {
  it("writes models.providers and agents.defaults models + model", () => {
    const base: Record<string, unknown> = {
      agents: { defaults: { workspace: "/tmp/ws" } },
    };
    const modelProviders = [
      draft({
        providerId: "glm",
        baseUrl: "https://glm.example/v1",
        models: [{ id: "glm-4", name: "GLM-4" }],
      }),
    ];
    const out = mergeModelProvidersIntoConfig(base, {
      modelProviders,
      modelProvidersDefaultRef: "glm/glm-4",
    });
    const providers = (out.models as { providers?: Record<string, unknown> }).providers;
    expect(providers?.glm).toMatchObject({
      baseUrl: "https://glm.example/v1",
      api: "openai-completions",
      models: [{ id: "glm-4", name: "GLM-4" }],
    });
    const defs = (out.agents as { defaults?: Record<string, unknown> }).defaults;
    expect(defs?.model).toBe("glm/glm-4");
    expect(defs?.models).toEqual({ "glm/glm-4": {} });
    expect(defs?.workspace).toBe("/tmp/ws");
  });

  it("preserves redacted api key sentinel when unchanged", () => {
    const base: Record<string, unknown> = {};
    const modelProviders = [
      draft({
        apiKey: "",
        apiKeyWasRedacted: true,
        models: [{ id: "m", name: "M" }],
      }),
    ];
    const out = mergeModelProvidersIntoConfig(base, {
      modelProviders,
      modelProvidersDefaultRef: "dashscope/m",
    });
    const prov = (out.models as { providers?: Record<string, { apiKey?: string }> }).providers
      ?.dashscope;
    expect(prov?.apiKey).toBe(CONFIG_REDACTED_SENTINEL);
  });
});

describe("draftFromConfig", () => {
  it("round-trips provider id, models, and redacted key flag", () => {
    const cfg: Record<string, unknown> = {
      models: {
        providers: {
          MyProv: {
            baseUrl: "https://x",
            apiKey: CONFIG_REDACTED_SENTINEL,
            api: "openai-completions",
            models: [{ id: "mid", name: "Name" }],
          },
        },
      },
      agents: { defaults: { model: "myprov/mid" } },
    };
    const d = draftFromConfig(cfg);
    expect(d.modelProviders).toHaveLength(1);
    expect(d.modelProviders[0]?.providerId).toBe("myprov");
    expect(d.modelProviders[0]?.apiKeyWasRedacted).toBe(true);
    expect(d.modelProviders[0]?.models[0]).toMatchObject({ id: "mid", name: "Name" });
  });
});
