import { z } from "zod";

const NonblankString = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: "must not be blank",
});

// Codex expands only a bare pipe-list of simple names. Keeping the same
// restricted grammar here means a configured name cannot change matcher
// syntax or introduce a regular-expression fragment.
const SimpleToolName = z.string().min(1).regex(/^[A-Za-z0-9_.:-]+$/, {
  message: "must be a simple tool name without matcher metacharacters",
}).refine((value) => value.trim().length > 0, { message: "must not be blank" });

const DescriptionWindowSchema = z
  .object({
    marker: NonblankString,
    contains: NonblankString,
    max_chars: z.number().int().positive(),
  })
  .strict();

const ParentReferencePattern = z.string().nullable().superRefine((value, ctx) => {
  if (value === null) return;
  try {
    new RegExp(value, "i");
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be valid regular-expression source" });
  }
});

const ParentUrlPattern = z.string().nullable().superRefine((value, ctx) => {
  if (value === null) return;
  try {
    new RegExp(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be valid regular-expression source" });
  }
});

/**
 * The optional reminder integration's one shared strict input schema.
 * Runtime consumers deliberately parse this schema again: a previously
 * generated hook must turn into a no-op when an operator disables or breaks
 * the current manifest after apply.
 */
export const StayInScopeConfigSchema = z
  .object({
    enabled: z.boolean(),
    tools: z.array(SimpleToolName).min(1).optional(),
    label_markers: z.array(NonblankString).optional(),
    description_markers: z.array(NonblankString).optional(),
    description_window: DescriptionWindowSchema.nullable().optional(),
    parent_reference_pattern: ParentReferencePattern.optional(),
    parent_url_pattern: ParentUrlPattern.optional(),
    messages: z
      .object({ reminder: NonblankString, second_order: NonblankString })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.enabled) return;
    for (const key of [
      "tools",
      "label_markers",
      "description_markers",
      "description_window",
      "parent_reference_pattern",
      "parent_url_pattern",
      "messages",
    ] as const) {
      if (value[key] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "is required when enabled:true" });
      }
    }
    if (
      (value.label_markers?.length ?? 0) === 0 &&
      (value.description_markers?.length ?? 0) === 0 &&
      value.description_window === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "enabled:true requires at least one label, description, or window detector",
      });
    }
  });

export interface StayInScopeConfig {
  tools: readonly string[];
  labelMarkers: readonly string[];
  descriptionMarkers: readonly string[];
  descriptionWindow: { marker: string; contains: string; maxChars: number } | null;
  parentReferencePattern: string | null;
  parentUrlPattern: string | null;
  messages: { reminder: string; secondOrder: string };
}

/** Returns null for absent, disabled, or invalid configuration. */
export function resolveStayInScopeConfig(raw: unknown): StayInScopeConfig | null {
  const parsed = StayInScopeConfigSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.enabled) return null;
  const value = parsed.data;
  // superRefine establishes these fields for enabled:true. The narrow casts
  // keep the public resolver free of a second, diverging validation path.
  if (
    value.tools === undefined ||
    value.label_markers === undefined ||
    value.description_markers === undefined ||
    value.description_window === undefined ||
    value.parent_reference_pattern === undefined ||
    value.parent_url_pattern === undefined ||
    value.messages === undefined
  ) {
    return null;
  }
  return {
    tools: value.tools,
    labelMarkers: value.label_markers,
    descriptionMarkers: value.description_markers,
    descriptionWindow:
      value.description_window === null
        ? null
        : {
            marker: value.description_window.marker,
            contains: value.description_window.contains,
            maxChars: value.description_window.max_chars,
          },
    parentReferencePattern: value.parent_reference_pattern,
    parentUrlPattern: value.parent_url_pattern,
    messages: {
      reminder: value.messages.reminder,
      secondOrder: value.messages.second_order,
    },
  };
}

export type StayInScopeMatchedRule = "label" | "hintergrund-marker" | "explicit-marker" | "none";

export interface StayInScopeMatchEvaluation {
  matched: boolean;
  matchedRule: StayInScopeMatchedRule;
  secondOrder: boolean;
  parentReference: string | null;
}

function firstParentReference(description: string, pattern: string | null): string | null {
  if (pattern === null) return null;
  const match = description.match(new RegExp(pattern, "i"));
  const capture = match?.[1];
  return typeof capture === "string" && /^[0-9]+$/.test(capture) ? capture : null;
}

export function evaluateStayInScopeMatch(
  config: StayInScopeConfig,
  labels: readonly string[],
  description: string,
): StayInScopeMatchEvaluation {
  const labelMatch = labels.some((label) =>
    config.labelMarkers.some((marker) => label.toLowerCase().includes(marker.toLowerCase())),
  );
  const explicitMarker = config.descriptionMarkers.some((marker) => description.includes(marker));
  const window = config.descriptionWindow;
  const windowMatch =
    !explicitMarker &&
    window !== null &&
    (() => {
      const index = description.indexOf(window.marker);
      return index !== -1 && description.slice(index, index + window.maxChars).toLowerCase().includes(window.contains.toLowerCase());
    })();
  const matchedRule: StayInScopeMatchedRule = labelMatch
    ? "label"
    : explicitMarker
      ? "explicit-marker"
      : windowMatch
        ? "hintergrund-marker"
        : "none";
  const parentReference = firstParentReference(description, config.parentReferencePattern);
  return {
    matched: matchedRule !== "none",
    matchedRule,
    secondOrder: labelMatch && parentReference !== null,
    parentReference,
  };
}

export function extractConfiguredParentUrl(
  config: StayInScopeConfig,
  description: string,
  parentReference: string | null,
): string | null {
  if (config.parentUrlPattern !== null) {
    const pattern = new RegExp(config.parentUrlPattern, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(description)) !== null) {
      if (match[0].length > 0) return match[0];
      if (pattern.lastIndex >= description.length) break;
      pattern.lastIndex += 1;
    }
  }
  return parentReference === null ? null : `#${parentReference}`;
}
