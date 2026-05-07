// Phase 6 #5 — translate abstract permission profile actions into
// Claude Code's settings.json permissions vocabulary.
//
// Mapping rules:
//
//   Action key  →  tool patterns                                   (matcher style)
//   ----------     ----------------------------------------------- ----------------
//   read           ["Read", "Glob", "Grep"]                        bare tool names
//   edit           ["Edit", "Write", "MultiEdit"]                  bare tool names
//   bash           ["Bash"]                                        bare tool name
//   commit         ["Bash(git commit*)"]                           Bash-prefix syntax
//   push           ["Bash(git push*)"]                             Bash-prefix syntax
//   pr             ["mcp__agent-tasks__pull_requests_create",      MCP + bare gh
//                   "Bash(gh pr create*)"]
//   deploy         ["Bash(kubectl*)", "Bash(terraform destroy*)",  Bash-prefix syntax
//                   "Bash(npm publish*)"]
//
// `allow` enum mapping:
//
//   "true"  / true   → permissions.allow
//   "false" / false  → permissions.deny
//   "ask"            → permissions.ask
//   "limited"        → permissions.ask  (v1 fallback — distinct
//                                        semantics deferred to a
//                                        Phase 6 #5 follow-up)
//   "ask_or_deny"    → permissions.ask  (same fallback rationale)

import type {
  PermissionActionKey,
  PermissionAllow,
  PermissionProfile,
} from "../schema/permission-profiles.js";

export interface SettingsPermissions {
  allow: string[];
  ask: string[];
  deny: string[];
}

const ACTION_TO_PATTERNS: Record<PermissionActionKey, string[]> = {
  read: ["Read", "Glob", "Grep"],
  edit: ["Edit", "Write", "MultiEdit"],
  bash: ["Bash"],
  commit: ["Bash(git commit*)"],
  push: ["Bash(git push*)"],
  pr: ["mcp__agent-tasks__pull_requests_create", "Bash(gh pr create*)"],
  deploy: ["Bash(kubectl*)", "Bash(terraform destroy*)", "Bash(npm publish*)"],
};

function bucketForAllow(value: PermissionAllow): keyof SettingsPermissions {
  switch (value) {
    case "true":
      return "allow";
    case "false":
      return "deny";
    case "ask":
    case "limited":
    case "ask_or_deny":
      return "ask";
  }
}

export function profileToSettingsPermissions(
  profile: PermissionProfile,
): SettingsPermissions {
  const allow = new Set<string>();
  const ask = new Set<string>();
  const deny = new Set<string>();

  const buckets: Record<keyof SettingsPermissions, Set<string>> = {
    allow,
    ask,
    deny,
  };

  for (const key of Object.keys(profile.actions) as PermissionActionKey[]) {
    const rule = profile.actions[key];
    if (!rule) continue;
    const target = bucketForAllow(rule.allow);
    for (const pattern of ACTION_TO_PATTERNS[key]) {
      buckets[target].add(pattern);
    }
  }

  return {
    allow: [...allow].sort(),
    ask: [...ask].sort(),
    deny: [...deny].sort(),
  };
}

/** Test seam — exposed for unit coverage of the action→pattern map. */
export function _internalPatternMap(): Record<PermissionActionKey, string[]> {
  return ACTION_TO_PATTERNS;
}
