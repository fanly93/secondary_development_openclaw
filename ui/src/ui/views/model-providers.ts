import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../i18n/index.ts";
import {
  listModelRefsFromDrafts,
  modelProviderApiOptions,
  type ModelProviderDraft,
} from "../controllers/model-providers.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
import { icons } from "../icons.ts";

export type ModelProvidersViewProps = {
  connected: boolean;
  saving: boolean;
  lastError: string | null;
  modelProviders: ModelProviderDraft[];
  modelProvidersDefaultRef: string;
  onDefaultRefChange: (value: string) => void;
  onProviderPatch: (providerClientId: string, patch: Partial<ModelProviderDraft>) => void;
  onAddProvider: () => void;
  onRemoveProvider: (providerClientId: string) => void;
  onAddModel: (providerClientId: string) => void;
  onRemoveModel: (providerClientId: string, modelClientId: string) => void;
  onModelPatch: (
    providerClientId: string,
    modelClientId: string,
    patch: { id?: string; name?: string },
  ) => void;
  onSave: () => void;
  onReload: () => void;
};

export function renderModelProviders(props: ModelProvidersViewProps) {
  const refOptions = listModelRefsFromDrafts(props.modelProviders);
  const canSave = props.connected && !props.saving;

  return html`
    <div class="model-providers-page" style="padding: 16px; max-width: 920px">
      <div
        style="display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; justify-content: space-between; margin-bottom: 16px"
      >
        <div>
          <h2 style="margin: 0 0 6px">${t("modelProviders.title")}</h2>
          <p class="muted" style="margin: 0">${t("modelProviders.subtitle")}</p>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 8px">
          <button
            type="button"
            class="btn btn--ghost"
            ?disabled=${!props.connected || props.saving}
            @click=${() => props.onReload()}
          >
            ${icons.refresh}
            <span>${t("common.reload")}</span>
          </button>
          <button
            type="button"
            class="btn btn--primary"
            ?disabled=${!canSave}
            @click=${() => props.onSave()}
          >
            ${props.saving ? t("common.saving") : t("common.saveAndPublish")}
          </button>
        </div>
      </div>

      ${props.lastError
        ? html`<div class="callout callout--error" style="margin-bottom: 16px">
            ${props.lastError}
          </div>`
        : nothing}

      <div class="callout" style="margin-bottom: 20px">
        <div>${t("modelProviders.allowlistHint")}</div>
        <div style="margin-top: 8px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/configuration"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            >${t("modelProviders.docsLink")}</a
          >
        </div>
      </div>

      <section class="field-group" style="margin-bottom: 20px">
        <label class="field">
          <span class="field__label">${t("modelProviders.defaultModel")}</span>
          <select
            .value=${props.modelProvidersDefaultRef}
            ?disabled=${!props.connected || refOptions.length === 0}
            @change=${(e: Event) => props.onDefaultRefChange((e.target as HTMLSelectElement).value)}
          >
            ${refOptions.length === 0
              ? html`<option value="">${t("modelProviders.noModelsYet")}</option>`
              : html`
                  ${repeat(
                    refOptions,
                    (r) => r,
                    (r) => html`<option value=${r}>${r}</option>`,
                  )}
                `}
          </select>
        </label>
        <p class="muted field__hint">${t("modelProviders.defaultModelHint")}</p>
      </section>

      <div class="model-providers__list">
        ${repeat(
          props.modelProviders,
          (p) => p.clientId,
          (p) => renderProviderCard(p, props),
        )}
      </div>

      <button
        type="button"
        class="btn btn--secondary"
        style="margin-top: 16px"
        ?disabled=${!props.connected || props.saving}
        @click=${() => props.onAddProvider()}
      >
        ${icons.plus}
        <span>${t("modelProviders.addProvider")}</span>
      </button>
    </div>
  `;
}

function renderProviderCard(p: ModelProviderDraft, props: ModelProvidersViewProps) {
  return html`
    <div class="card model-provider-card" style="margin-bottom: 16px; padding: 16px">
      <div
        style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px"
      >
        <h3 style="margin: 0; font-size: 1rem">${t("modelProviders.providerHeading")}</h3>
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          title=${t("modelProviders.removeProvider")}
          ?disabled=${!props.connected || props.saving}
          @click=${() => props.onRemoveProvider(p.clientId)}
        >
          ${icons.trash}
        </button>
      </div>

      <div class="field-grid" style="margin-top: 12px; display: grid; gap: 12px">
        <label class="field">
          <span class="field__label">${t("modelProviders.providerId")}</span>
          <input
            type="text"
            class="input"
            spellcheck="false"
            autocomplete="off"
            placeholder="dashscope"
            .value=${p.providerId}
            ?disabled=${!props.connected || props.saving}
            @input=${(e: Event) =>
              props.onProviderPatch(p.clientId, {
                providerId: (e.target as HTMLInputElement).value,
              })}
          />
          <span class="muted field__hint">${t("modelProviders.providerIdHint")}</span>
        </label>

        <label class="field">
          <span class="field__label">${t("common.baseUrl")}</span>
          <input
            type="url"
            class="input"
            spellcheck="false"
            autocomplete="off"
            placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
            .value=${p.baseUrl}
            ?disabled=${!props.connected || props.saving}
            @input=${(e: Event) =>
              props.onProviderPatch(p.clientId, { baseUrl: (e.target as HTMLInputElement).value })}
          />
        </label>

        <label class="field">
          <span class="field__label">${t("modelProviders.apiAdapter")}</span>
          <select
            .value=${p.api}
            ?disabled=${!props.connected || props.saving}
            @change=${(e: Event) =>
              props.onProviderPatch(p.clientId, { api: (e.target as HTMLSelectElement).value })}
          >
            ${modelProviderApiOptions.map(
              (opt) => html`<option value=${opt.value}>${opt.label}</option>`,
            )}
          </select>
        </label>

        <label class="field">
          <span class="field__label">${t("modelProviders.apiKey")}</span>
          <input
            type="password"
            class="input"
            spellcheck="false"
            autocomplete="off"
            placeholder=${p.apiKeyWasRedacted
              ? t("modelProviders.apiKeyUnchangedPlaceholder")
              : t("modelProviders.apiKeyPlaceholder")}
            .value=${p.apiKey}
            ?disabled=${!props.connected || props.saving}
            @input=${(e: Event) =>
              props.onProviderPatch(p.clientId, {
                apiKey: (e.target as HTMLInputElement).value,
                apiKeyWasRedacted: false,
              })}
          />
          ${p.apiKeyWasRedacted
            ? html`<span class="muted field__hint">${t("modelProviders.apiKeyRedactedHint")}</span>`
            : nothing}
        </label>
      </div>

      <div style="margin-top: 16px">
        <div class="muted" style="margin-bottom: 8px; font-weight: 500">
          ${t("modelProviders.models")}
        </div>
        ${repeat(
          p.models,
          (m) => m.clientId,
          (m) => html`
            <div
              class="model-row"
              style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: end; margin-bottom: 8px"
            >
              <label class="field" style="margin: 0">
                <span class="field__label">${t("modelProviders.modelId")}</span>
                <input
                  type="text"
                  class="input"
                  spellcheck="false"
                  .value=${m.id}
                  ?disabled=${!props.connected || props.saving}
                  @input=${(e: Event) =>
                    props.onModelPatch(p.clientId, m.clientId, {
                      id: (e.target as HTMLInputElement).value,
                    })}
                />
              </label>
              <label class="field" style="margin: 0">
                <span class="field__label">${t("modelProviders.modelName")}</span>
                <input
                  type="text"
                  class="input"
                  spellcheck="false"
                  .value=${m.name}
                  ?disabled=${!props.connected || props.saving}
                  @input=${(e: Event) =>
                    props.onModelPatch(p.clientId, m.clientId, {
                      name: (e.target as HTMLInputElement).value,
                    })}
                />
              </label>
              <button
                type="button"
                class="btn btn--ghost btn--sm"
                title=${t("modelProviders.removeModel")}
                ?disabled=${!props.connected || props.saving}
                @click=${() => props.onRemoveModel(p.clientId, m.clientId)}
              >
                ${icons.trash}
              </button>
            </div>
          `,
        )}
        <button
          type="button"
          class="btn btn--secondary btn--sm"
          style="margin-top: 4px"
          ?disabled=${!props.connected || props.saving}
          @click=${() => props.onAddModel(p.clientId)}
        >
          ${icons.plus}
          <span>${t("modelProviders.addModel")}</span>
        </button>
      </div>
    </div>
  `;
}
