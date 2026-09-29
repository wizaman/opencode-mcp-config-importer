import * as v from "valibot";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Valibot's record also accepts arrays; TOML tables must be objects.
export const TableSchema = v.custom<Record<string, unknown>>(isObject);
const StringTableSchema = v.record(v.string(), v.string());
export const RootSchema = v.object({
  mcp_servers: v.optional(v.record(v.string(), v.unknown())),
});
export const EnabledSchema = v.object({ enabled: v.optional(v.boolean()) });
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

export const LocalSchema = v.object({
  command: NonBlankString,
  args: v.optional(v.array(v.string())),
  env: v.optional(StringTableSchema),
  cwd: v.optional(NonBlankString),
});
export const RemoteSchema = v.object({
  url: HttpUrl,
  http_headers: v.optional(StringTableSchema),
  env_http_headers: v.optional(StringTableSchema),
  bearer_token_env_var: v.optional(NonBlankString),
});

export type ServerIssue =
  | v.InferIssue<typeof LocalSchema>
  | v.InferIssue<typeof RemoteSchema>;
