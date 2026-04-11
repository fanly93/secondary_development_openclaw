import { describe, expect, it } from "vitest";
import {
  normalizePluginsConfigWithResolver,
  resolvePluginActivationState,
} from "./config-policy.js";

describe("resolvePluginActivationState (config-policy)", () => {
  it("does not veto bundled channel plugins when plugins.allow omits the channel id", () => {
    const rootConfig = {
      channels: { feishu: { enabled: true } },
      plugins: { enabled: true, allow: ["browser"] },
    };
    const normalized = normalizePluginsConfigWithResolver(rootConfig.plugins);
    const state = resolvePluginActivationState({
      id: "feishu",
      origin: "bundled",
      config: normalized,
      rootConfig,
    });
    expect(state.activated).toBe(true);
    expect(state.reason).toMatch(/channel enabled in config/);
  });

  it("still blocks allowlisted-only mode when the plugin has no explicit selection", () => {
    const rootConfig = {
      channels: { feishu: { enabled: false } },
      plugins: { enabled: true, allow: ["browser"] },
    };
    const normalized = normalizePluginsConfigWithResolver(rootConfig.plugins);
    const state = resolvePluginActivationState({
      id: "feishu",
      origin: "bundled",
      config: normalized,
      rootConfig,
    });
    expect(state.activated).toBe(false);
    expect(state.reason).toBe("not in allowlist");
  });
});
