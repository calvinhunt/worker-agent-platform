import { getDefaultModel } from "@/lib/openai";
import type { AdminAgentDefaults, AdminSettings, Agent } from "@/lib/types";

const MEMORY_LIMITS = new Set(["1g", "4g", "16g", "64g"]);
const SERVICE_TIERS = new Set(["auto", "default", "flex", "scale", "priority"]);
const TRUNCATION_MODES = new Set(["auto", "disabled"]);
const PROMPT_CACHE_RETENTION = new Set(["in-memory", "24h"]);
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const REASONING_SUMMARIES = new Set(["auto", "concise", "detailed"]);
const TEXT_VERBOSITY = new Set(["low", "medium", "high"]);

function timestamp() {
  return new Date().toISOString();
}

function normalizePositiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function normalizeOptionalNumber(
  value: unknown,
  options: { min: number; max: number },
) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < options.min || parsed > options.max) {
    return null;
  }

  return parsed;
}

function normalizeOptionalPositiveInteger(value: unknown) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function normalizeStringList(values: unknown) {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function normalizeDomain(domain: string) {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .trim();
}

export function getDefaultAdminSettings(): AdminSettings {
  return {
    containerDefaults: {
      memoryLimit: null,
      expiresAfterMinutes: 20,
      networkPolicy: { type: "disabled" },
    },
    agentDefaults: {
      model: getDefaultModel(),
      maxTurns: 16,
      store: true,
      parallelToolCalls: false,
      temperature: null,
      topP: null,
      maxOutputTokens: null,
      maxToolCalls: null,
      serviceTier: null,
      truncation: null,
      promptCacheRetention: null,
      reasoningEffort: null,
      reasoningSummary: null,
      textVerbosity: "medium",
    },
    baselineSkillIds: [],
    updatedAt: timestamp(),
  };
}

export function normalizeAdminSettings(
  input?: Partial<AdminSettings>,
  options?: { validSkillIds?: Set<string> },
): AdminSettings {
  const defaults = getDefaultAdminSettings();
  const containerDefaults: Partial<AdminSettings["containerDefaults"]> =
    input?.containerDefaults ?? {};
  const agentDefaults: Partial<AdminSettings["agentDefaults"]> = input?.agentDefaults ?? {};

  const allowedDomains =
    containerDefaults.networkPolicy?.type === "allowlist"
      ? Array.from(
          new Set(
            containerDefaults.networkPolicy.allowedDomains
              .map((domain) => normalizeDomain(String(domain || "")))
              .filter(Boolean),
          ),
        )
      : [];

  const baselineSkillIds = normalizeStringList(input?.baselineSkillIds).filter((skillId) =>
    options?.validSkillIds ? options.validSkillIds.has(skillId) : true,
  );

  return {
    containerDefaults: {
      memoryLimit: MEMORY_LIMITS.has(String(containerDefaults.memoryLimit))
        ? (containerDefaults.memoryLimit as AdminSettings["containerDefaults"]["memoryLimit"])
        : defaults.containerDefaults.memoryLimit,
      expiresAfterMinutes: normalizePositiveInteger(
        containerDefaults.expiresAfterMinutes,
        defaults.containerDefaults.expiresAfterMinutes,
      ),
      networkPolicy:
        containerDefaults.networkPolicy?.type === "allowlist" && allowedDomains.length
          ? {
              type: "allowlist",
              allowedDomains,
            }
          : { type: "disabled" },
    },
    agentDefaults: {
      model:
        typeof agentDefaults.model === "string" && agentDefaults.model.trim()
          ? agentDefaults.model.trim()
          : defaults.agentDefaults.model,
      maxTurns: normalizePositiveInteger(agentDefaults.maxTurns, defaults.agentDefaults.maxTurns),
      store:
        typeof agentDefaults.store === "boolean"
          ? agentDefaults.store
          : defaults.agentDefaults.store,
      parallelToolCalls:
        typeof agentDefaults.parallelToolCalls === "boolean"
          ? agentDefaults.parallelToolCalls
          : defaults.agentDefaults.parallelToolCalls,
      temperature: normalizeOptionalNumber(agentDefaults.temperature, { min: 0, max: 2 }),
      topP: normalizeOptionalNumber(agentDefaults.topP, { min: 0, max: 1 }),
      maxOutputTokens: normalizeOptionalPositiveInteger(agentDefaults.maxOutputTokens),
      maxToolCalls: normalizeOptionalPositiveInteger(agentDefaults.maxToolCalls),
      serviceTier: SERVICE_TIERS.has(String(agentDefaults.serviceTier))
        ? (agentDefaults.serviceTier as AdminAgentDefaults["serviceTier"])
        : defaults.agentDefaults.serviceTier,
      truncation: TRUNCATION_MODES.has(String(agentDefaults.truncation))
        ? (agentDefaults.truncation as AdminAgentDefaults["truncation"])
        : defaults.agentDefaults.truncation,
      promptCacheRetention: PROMPT_CACHE_RETENTION.has(String(agentDefaults.promptCacheRetention))
        ? (agentDefaults.promptCacheRetention as AdminAgentDefaults["promptCacheRetention"])
        : defaults.agentDefaults.promptCacheRetention,
      reasoningEffort: REASONING_EFFORTS.has(String(agentDefaults.reasoningEffort))
        ? (agentDefaults.reasoningEffort as AdminAgentDefaults["reasoningEffort"])
        : defaults.agentDefaults.reasoningEffort,
      reasoningSummary: REASONING_SUMMARIES.has(String(agentDefaults.reasoningSummary))
        ? (agentDefaults.reasoningSummary as AdminAgentDefaults["reasoningSummary"])
        : defaults.agentDefaults.reasoningSummary,
      textVerbosity: TEXT_VERBOSITY.has(String(agentDefaults.textVerbosity))
        ? (agentDefaults.textVerbosity as AdminAgentDefaults["textVerbosity"])
        : defaults.agentDefaults.textVerbosity,
    },
    baselineSkillIds,
    updatedAt:
      typeof input?.updatedAt === "string" && input.updatedAt
        ? input.updatedAt
        : defaults.updatedAt,
  };
}

export function buildUpdatedAdminSettings(
  current: AdminSettings,
  updates: Partial<AdminSettings>,
  options?: { validSkillIds?: Set<string> },
) {
  return normalizeAdminSettings(
    {
      ...current,
      ...updates,
      containerDefaults: {
        ...current.containerDefaults,
        ...(updates.containerDefaults ?? {}),
      },
      agentDefaults: {
        ...current.agentDefaults,
        ...(updates.agentDefaults ?? {}),
      },
      baselineSkillIds: updates.baselineSkillIds ?? current.baselineSkillIds,
      updatedAt: timestamp(),
    },
    options,
  );
}

export function getEffectiveAgentSkillIds(agent: Agent, settings: AdminSettings) {
  return Array.from(new Set([...settings.baselineSkillIds, ...agent.skillIds]));
}
