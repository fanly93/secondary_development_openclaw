import { refreshChat } from "../app-chat.ts";
import type { OpenClawApp } from "../app.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { JsonSchema } from "../views/config-form.shared.ts";
import { applyConfig, loadConfig } from "./config.ts";
import type { ConfigState } from "./config.ts";
import { coerceFormValues } from "./config/form-coerce.ts";
import { cloneConfigObject, serializeConfigForm } from "./config/form-utils.ts";

/** Must match {@link REDACTED_SENTINEL} in gateway redact snapshot. */
export const CONFIG_REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

const MODEL_API_DEFAULT = "openai-completions";

export type ModelProviderModelDraft = {
  clientId: string;
  id: string;
  name: string;
};

export type ModelProviderDraft = {
  clientId: string;
  providerId: string;
  baseUrl: string;
  apiKey: string;
  apiKeyWasRedacted: boolean;
  api: string;
  models: ModelProviderModelDraft[];
  /** Preserves provider fields we do not edit in this UI (headers, request, …). */
  retained: Record<string, unknown>;
};

export type ModelProvidersEditorState = {
  modelProviders: ModelProviderDraft[];
  modelProvidersDefaultRef: string;
};

function asJsonSchema(value: unknown): JsonSchema | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchema;
}

export function normalizeProviderIdSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");
}

function generateClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readDefaultModelRefFromConfig(config: Record<string, unknown>): string {
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const model = defaults?.model;
  if (typeof model === "string") {
    return model.trim();
  }
  if (model && typeof model === "object" && !Array.isArray(model)) {
    const primary = (model as { primary?: unknown }).primary;
    if (typeof primary === "string") {
      return primary.trim();
    }
  }
  return "";
}

export function listModelRefsFromDrafts(providers: ModelProviderDraft[]): string[] {
  const refs: string[] = [];
  for (const p of providers) {
    const pid = normalizeProviderIdSlug(p.providerId);
    if (!pid) {
      continue;
    }
    for (const m of p.models) {
      const mid = m.id.trim();
      if (!mid) {
        continue;
      }
      refs.push(`${pid}/${mid}`);
    }
  }
  return refs;
}

export function pickDefaultModelRef(params: {
  modelProviders: ModelProviderDraft[];
  currentDefault: string;
}): string {
  const refs = listModelRefsFromDrafts(params.modelProviders);
  if (refs.length === 0) {
    return "";
  }
  const cur = params.currentDefault.trim();
  if (cur && refs.includes(cur)) {
    return cur;
  }
  const qwen = refs.find((r) => r.endsWith("/qwen3.5-plus"));
  if (qwen) {
    return qwen;
  }
  return refs[0] ?? "";
}

export function buildAgentsDefaultsModelsMap(
  modelProviders: ModelProviderDraft[],
): Record<string, Record<string, never>> {
  const out: Record<string, Record<string, never>> = {};
  for (const ref of listModelRefsFromDrafts(modelProviders)) {
    out[ref] = {};
  }
  return out;
}

export function draftFromConfig(
  config: Record<string, unknown> | null | undefined,
): ModelProvidersEditorState {
  const modelsRoot = config?.models as Record<string, unknown> | undefined;
  const rawProviders = modelsRoot?.providers;
  const drafts: ModelProviderDraft[] = [];
  if (rawProviders && typeof rawProviders === "object" && !Array.isArray(rawProviders)) {
    const keys = Object.keys(rawProviders as Record<string, unknown>).toSorted((a, b) =>
      a.localeCompare(b),
    );
    for (const key of keys) {
      const prov = (rawProviders as Record<string, unknown>)[key];
      if (!prov || typeof prov !== "object" || Array.isArray(prov)) {
        continue;
      }
      const rec = prov as Record<string, unknown>;
      const baseUrl = typeof rec.baseUrl === "string" ? rec.baseUrl : "";
      const apiKeyRaw = rec.apiKey;
      const apiKeyWasRedacted = apiKeyRaw === CONFIG_REDACTED_SENTINEL;
      const apiKey = typeof apiKeyRaw === "string" && !apiKeyWasRedacted ? apiKeyRaw : "";
      const api =
        typeof rec.api === "string" && rec.api.trim() ? rec.api.trim() : MODEL_API_DEFAULT;
      const modelList = Array.isArray(rec.models) ? rec.models : [];
      const models: ModelProviderModelDraft[] = [];
      for (const entry of modelList) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const e = entry as Record<string, unknown>;
        const id = typeof e.id === "string" ? e.id.trim() : "";
        if (!id) {
          continue;
        }
        const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : id;
        models.push({ clientId: generateClientId(), id, name });
      }
      const retained = { ...rec };
      delete retained.baseUrl;
      delete retained.apiKey;
      delete retained.models;
      delete retained.api;
      drafts.push({
        clientId: generateClientId(),
        providerId: normalizeProviderIdSlug(key) || key.trim(),
        baseUrl,
        apiKey,
        apiKeyWasRedacted,
        api,
        models,
        retained,
      });
    }
  }
  const currentDefault = readDefaultModelRefFromConfig(config ?? {});
  return {
    modelProviders: drafts,
    modelProvidersDefaultRef: pickDefaultModelRef({ modelProviders: drafts, currentDefault }),
  };
}

function resolveApiKeyForSave(draft: ModelProviderDraft): string | undefined {
  const trimmed = draft.apiKey.trim();
  if (trimmed) {
    return trimmed;
  }
  if (draft.apiKeyWasRedacted) {
    return CONFIG_REDACTED_SENTINEL;
  }
  return undefined;
}

export function mergeModelProvidersIntoConfig(
  baseConfig: Record<string, unknown>,
  editor: ModelProvidersEditorState,
): Record<string, unknown> {
  const next = cloneConfigObject(baseConfig);
  const providersRecord: Record<string, unknown> = {};

  for (const draft of editor.modelProviders) {
    const pid = normalizeProviderIdSlug(draft.providerId);
    if (!pid) {
      continue;
    }
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) {
      continue;
    }
    const modelDefs = draft.models
      .map((m) => {
        const id = m.id.trim();
        if (!id) {
          return null;
        }
        const name = m.name.trim() || id;
        return { id, name };
      })
      .filter(Boolean) as Array<{ id: string; name: string }>;

    if (modelDefs.length === 0) {
      continue;
    }

    const apiKey = resolveApiKeyForSave(draft);
    const entry: Record<string, unknown> = {
      ...draft.retained,
      baseUrl,
      models: modelDefs,
      api: draft.api.trim() || MODEL_API_DEFAULT,
    };
    if (apiKey !== undefined) {
      entry.apiKey = apiKey;
    }
    providersRecord[pid] = entry;
  }

  const modelsRoot = (next.models as Record<string, unknown> | undefined) ?? {};
  next.models = { ...modelsRoot, providers: providersRecord };

  const agents = (next.agents as Record<string, unknown> | undefined) ?? {};
  const defaults = (agents.defaults as Record<string, unknown> | undefined) ?? {};
  const allowlist = buildAgentsDefaultsModelsMap(editor.modelProviders);
  const refCount = Object.keys(allowlist).length;

  const nextDefaults: Record<string, unknown> = { ...defaults };
  if (refCount > 0) {
    nextDefaults.models = allowlist;
    const dm =
      editor.modelProvidersDefaultRef.trim() ||
      pickDefaultModelRef({ modelProviders: editor.modelProviders, currentDefault: "" });
    if (dm) {
      nextDefaults.model = dm;
    }
  } else {
    nextDefaults.models = {};
  }

  next.agents = {
    ...agents,
    defaults: nextDefaults,
  };

  return next;
}

export type ModelProvidersHost = ConfigState &
  ModelProvidersEditorState & {
    client: GatewayBrowserClient | null;
    connected: boolean;
    modelProvidersSaving: boolean;
    lastError: string | null;
  };

export async function loadModelProvidersEditor(host: ModelProvidersHost) {
  if (!host.client || !host.connected) {
    return;
  }
  host.lastError = null;
  try {
    await loadConfig(host);
    const cfg = host.configSnapshot?.config ?? {};
    const next = draftFromConfig(cfg);
    host.modelProviders = next.modelProviders;
    host.modelProvidersDefaultRef = next.modelProvidersDefaultRef;
  } catch (err) {
    host.lastError = String(err);
  }
}

export async function saveModelProvidersEditor(host: ModelProvidersHost) {
  if (!host.client || !host.connected) {
    return;
  }
  const baseHash = host.configSnapshot?.hash;
  if (!baseHash) {
    host.lastError = "Config hash missing; reload and retry.";
    return;
  }
  host.modelProvidersSaving = true;
  host.lastError = null;
  try {
    const baseCfg = host.configSnapshot?.config ?? {};
    const merged = mergeModelProvidersIntoConfig(baseCfg, {
      modelProviders: host.modelProviders,
      modelProvidersDefaultRef: host.modelProvidersDefaultRef,
    });
    const schema = asJsonSchema(host.configSchema);
    const coerced = (schema ? coerceFormValues(merged, schema) : merged) as Record<string, unknown>;
    host.configForm = coerced;
    host.configFormDirty = true;
    host.configFormMode = "form";
    host.configRaw = serializeConfigForm(coerced);
    await applyConfig(host);
    if (host.lastError) {
      await loadConfig(host);
      const rolledBack = draftFromConfig(host.configSnapshot?.config ?? {});
      host.modelProviders = rolledBack.modelProviders;
      host.modelProvidersDefaultRef = rolledBack.modelProvidersDefaultRef;
      return;
    }
    const saved = draftFromConfig(host.configSnapshot?.config ?? {});
    host.modelProviders = saved.modelProviders;
    host.modelProvidersDefaultRef = saved.modelProvidersDefaultRef;
    await refreshChat(host as unknown as OpenClawApp);
  } catch (err) {
    host.lastError = String(err);
  } finally {
    host.modelProvidersSaving = false;
  }
}

export function createEmptyProviderDraft(): ModelProviderDraft {
  return {
    clientId: generateClientId(),
    providerId: "",
    baseUrl: "",
    apiKey: "",
    apiKeyWasRedacted: false,
    api: MODEL_API_DEFAULT,
    models: [],
    retained: {},
  };
}

export function createEmptyModelDraft(): ModelProviderModelDraft {
  return {
    clientId: generateClientId(),
    id: "",
    name: "",
  };
}

export function patchModelProviderAt(
  providers: ModelProviderDraft[],
  clientId: string,
  patch: Partial<ModelProviderDraft>,
): ModelProviderDraft[] {
  return providers.map((p) => (p.clientId === clientId ? { ...p, ...patch } : p));
}

export function patchModelAt(
  providers: ModelProviderDraft[],
  providerClientId: string,
  modelClientId: string,
  patch: Partial<ModelProviderModelDraft>,
): ModelProviderDraft[] {
  return providers.map((p) => {
    if (p.clientId !== providerClientId) {
      return p;
    }
    return {
      ...p,
      models: p.models.map((m) => (m.clientId === modelClientId ? { ...m, ...patch } : m)),
    };
  });
}

export function removeModelProviderAt(
  providers: ModelProviderDraft[],
  clientId: string,
): ModelProviderDraft[] {
  return providers.filter((p) => p.clientId !== clientId);
}

export function addModelToProvider(
  providers: ModelProviderDraft[],
  providerClientId: string,
): ModelProviderDraft[] {
  return providers.map((p) =>
    p.clientId === providerClientId ? { ...p, models: [...p.models, createEmptyModelDraft()] } : p,
  );
}

export function removeModelFromProvider(
  providers: ModelProviderDraft[],
  providerClientId: string,
  modelClientId: string,
): ModelProviderDraft[] {
  return providers.map((p) =>
    p.clientId === providerClientId
      ? { ...p, models: p.models.filter((m) => m.clientId !== modelClientId) }
      : p,
  );
}

/** Keeps {@link ModelProvidersEditorState.modelProvidersDefaultRef} on a valid option when the draft list changes. */
export function reconcileDefaultRefAfterDraftChange(editor: ModelProvidersEditorState): string {
  const refs = listModelRefsFromDrafts(editor.modelProviders);
  const cur = editor.modelProvidersDefaultRef.trim();
  if (cur && refs.includes(cur)) {
    return cur;
  }
  return pickDefaultModelRef({ modelProviders: editor.modelProviders, currentDefault: "" });
}

export const modelProviderApiOptions = [
  { value: "openai-completions", label: "OpenAI-compatible (chat completions)" },
  { value: "openai-responses", label: "OpenAI Responses API" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
  { value: "ollama", label: "Ollama" },
] as const;
