import * as v from "valibot";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Valibot's record accepts arrays; .mcp.json maps must be JSON objects.
const ObjectRecordSchema = v.custom<Record<string, unknown>>(isObject);
const StringRecordSchema = v.intersect([
  ObjectRecordSchema,
  v.record(v.string(), v.string()),
]);
const CommonEntries = {
  timeout: v.optional(v.pipe(
    v.number(),
    v.check((value) => Number.isSafeInteger(value) && value > 0),
  )),
};
const NonBlankString = v.pipe(v.string(), v.check((value) => !!value.trim()));
const StdioSchema = v.looseObject({
  ...CommonEntries,
  type: v.optional(v.literal("stdio")),
  command: NonBlankString,
  args: v.optional(v.array(v.string())),
  env: v.optional(StringRecordSchema),
  cwd: v.optional(NonBlankString),
});
const HttpSchema = v.object({
  ...CommonEntries,
  type: v.picklist(["http", "streamable-http"]),
  url: v.string(),
  headers: v.optional(StringRecordSchema),
});

export const RootSchema = v.object({
  mcpServers: v.intersect([
    ObjectRecordSchema,
    v.record(v.string(), v.union([StdioSchema, HttpSchema])),
  ]),
});
