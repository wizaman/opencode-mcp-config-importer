import * as v from "valibot";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Valibot's record also accepts arrays; TOML tables must be objects.
export const TableSchema = v.custom<Record<string, unknown>>(isObject);
const StringTableSchema = v.pipe(
  TableSchema,
  v.transform((value) => ({ ...value })),
  v.record(v.string(), v.string()),
);
const NonBlankString = v.pipe(v.string(), v.check((value) => !!value.trim()));
const HttpUrl = v.pipe(
  v.string(),
  v.check((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }),
);

const CommonEntries = {
  enabled: v.optional(v.boolean()),
  enabled_tools: v.optional(v.array(v.string())),
  disabled_tools: v.optional(v.array(v.string())),
  env_http_headers: v.optional(StringTableSchema),
  bearer_token_env_var: v.optional(NonBlankString),
};
const LocalSchema = v.pipe(
  v.looseObject({
    ...CommonEntries,
    command: NonBlankString,
    args: v.optional(v.array(v.string())),
    env: v.optional(StringTableSchema),
    cwd: v.optional(NonBlankString),
    url: v.optional(HttpUrl),
    http_headers: v.optional(StringTableSchema),
  }),
  v.transform((value) => ({ ...value, transport: "local" as const })),
);
const RemoteSchema = v.pipe(
  v.looseObject({
    ...CommonEntries,
    url: HttpUrl,
    command: v.optional(NonBlankString),
    args: v.optional(v.array(v.string())),
    env: v.optional(StringTableSchema),
    cwd: v.optional(NonBlankString),
    http_headers: v.optional(StringTableSchema),
  }),
  v.transform((value) => ({ ...value, transport: "remote" as const })),
);

const DisabledSchema = v.pipe(
  v.object({
    enabled: v.literal(false),
    enabled_tools: v.optional(v.array(v.string())),
    disabled_tools: v.optional(v.array(v.string())),
    command: v.optional(NonBlankString),
    args: v.optional(v.array(v.string())),
    env: v.optional(StringTableSchema),
    cwd: v.optional(NonBlankString),
    url: v.optional(HttpUrl),
    http_headers: v.optional(StringTableSchema),
    env_http_headers: v.optional(StringTableSchema),
    bearer_token_env_var: v.optional(NonBlankString),
  }),
  v.transform((value) => ({ ...value, transport: "disabled" as const })),
);
export const RootSchema = v.object({
  mcp_servers: v.optional(v.pipe(
    TableSchema,
    v.transform((value) => ({ ...value })),
    v.record(v.string(), v.union([DisabledSchema, LocalSchema, RemoteSchema])),
  )),
});
