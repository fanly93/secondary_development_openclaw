import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { ChannelAccountSnapshot, FeishuProbe, FeishuStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

function formatProbeBotLine(probe: FeishuProbe | null | undefined): string {
  if (!probe) {
    return "";
  }
  const name = typeof probe.botName === "string" ? probe.botName : "";
  const appId = typeof probe.appId === "string" ? probe.appId : "";
  if (name && appId) {
    return `${name} · app ${appId}`;
  }
  if (name) {
    return name;
  }
  if (appId) {
    return `app ${appId}`;
  }
  return "";
}

export function renderFeishuCard(params: {
  props: ChannelsProps;
  feishu?: FeishuStatus;
  feishuAccounts: ChannelAccountSnapshot[];
  accountCountLabel: unknown;
}) {
  const { props, feishu, feishuAccounts, accountCountLabel } = params;
  const hasMultipleAccounts = feishuAccounts.length > 1;
  const configured = resolveChannelConfigured("feishu", props);
  const probeLine = formatProbeBotLine(feishu?.probe);

  const renderAccountCard = (account: ChannelAccountSnapshot) => {
    const probe = account.probe as FeishuProbe | null | undefined;
    const botLine = formatProbeBotLine(probe ?? null);
    const label = account.name || account.accountId;
    return html`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">${botLine || label}</div>
          <div class="account-card-id">${account.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">${t("common.running")}</span>
            <span>${account.running ? t("common.yes") : t("common.no")}</span>
          </div>
          <div>
            <span class="label">${t("common.configured")}</span>
            <span>${account.configured ? t("common.yes") : t("common.no")}</span>
          </div>
          <div>
            <span class="label">${t("channels.feishu.webhookPort")}</span>
            <span>${typeof account.port === "number" ? String(account.port) : t("common.na")}</span>
          </div>
          <div>
            <span class="label">${t("common.lastInbound")}</span>
            <span
              >${account.lastInboundAt
                ? formatRelativeTimestamp(account.lastInboundAt)
                : t("common.na")}</span
            >
          </div>
          ${account.lastError
            ? html` <div class="account-card-error">${account.lastError}</div> `
            : nothing}
        </div>
      </div>
    `;
  };

  if (hasMultipleAccounts) {
    return html`
      <div class="card">
        <div class="card-title">${t("channels.feishu.title")}</div>
        <div class="card-sub">${t("channels.feishu.subtitle")}</div>
        ${accountCountLabel}

        <div class="account-card-list">
          ${feishuAccounts.map((account) => renderAccountCard(account))}
        </div>

        ${feishu?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">${feishu.lastError}</div>`
          : nothing}
        ${feishu?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
              ${feishu.probe.ok ? t("common.probeOk") : t("common.probeFailed")}
              ${probeLine ? ` · ${probeLine}` : ""}
              ${feishu.probe.error ? ` ${feishu.probe.error}` : ""}
            </div>`
          : nothing}
        ${renderChannelConfigSection({ channelId: "feishu", props })}

        <div class="row" style="margin-top: 12px;">
          <button class="btn" @click=${() => props.onRefresh(true)}>${t("common.probe")}</button>
        </div>
      </div>
    `;
  }

  return renderSingleAccountChannelCard({
    title: t("channels.feishu.title"),
    subtitle: t("channels.feishu.subtitle"),
    accountCountLabel,
    statusRows: [
      { label: t("common.configured"), value: formatNullableBoolean(configured) },
      {
        label: t("common.running"),
        value: feishu?.running ? t("common.yes") : t("common.no"),
      },
      {
        label: t("channels.feishu.webhookPort"),
        value: typeof feishu?.port === "number" ? String(feishu.port) : t("common.na"),
      },
      {
        label: t("common.lastStart"),
        value: feishu?.lastStartAt ? formatRelativeTimestamp(feishu.lastStartAt) : t("common.na"),
      },
      {
        label: t("common.lastProbe"),
        value: feishu?.lastProbeAt ? formatRelativeTimestamp(feishu.lastProbeAt) : t("common.na"),
      },
    ],
    lastError: feishu?.lastError ?? null,
    secondaryCallout: feishu?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${feishu.probe.ok ? t("common.probeOk") : t("common.probeFailed")}
          ${probeLine ? ` · ${probeLine}` : ""}
          ${feishu.probe.error ? ` ${feishu.probe.error}` : ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "feishu", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>${t("common.probe")}</button>
    </div>`,
  });
}
