import { Array as Arr, Option, Schema, SchemaGetter, SchemaTransformation, Struct } from "effect";

/**
 * Extract a single field from a struct schema, returning the unwrapped value.
 *
 * refs/effect4/packages/effect/SCHEMA.md:7262
 */
const pluck =
  <P extends PropertyKey>(key: P) =>
  <S extends Schema.Top>(
    schema: Schema.Struct<Record<P, S>>,
  ): Schema.decodeTo<Schema.toType<S>, Schema.Struct<Record<P, S>>> =>
    schema.mapFields(Struct.pick([key])).pipe(
      Schema.decodeTo(Schema.toType(schema.fields[key]), {
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
        decode: SchemaGetter.transform((whole: any) => whole[key]),
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any
        encode: SchemaGetter.transform((value) => ({ [key]: value }) as any),
      }),
    );

/**
 * Schema for D1 rows shaped `{ data: string }` (e.g. from `json_group_array`/`json_object` queries).
 * Extracts the `data` column, parses the JSON string, and validates against `DataSchema`.
 *
 * Uses `<S extends Schema.Top>` instead of `<A>(Schema.Schema<A>)` to preserve
 * the concrete schema type through the pipeline. `Schema.Schema<A>` erases
 * `DecodingServices` to `unknown` (inherited from `Schema.Top`), which causes
 * `Schema.decodeUnknownEffect` to infer `R = unknown` instead of `R = never`.
 */
export const DataFromResult = <S extends Schema.Top>(DataSchema: S) =>
  Schema.Struct({ data: Schema.String }).pipe(
    pluck("data"),
    Schema.decodeTo(Schema.fromJsonString(DataSchema)),
  );

/**
 * Schema for an array of `{ data: string }` shaped records.
 * Extracts the first element, parses its JSON `data` column, and validates against `DataSchema`.
 * Returns `Option.none` for an empty array, `Option.some(decoded)` for non-empty.
 */
export const DataFromFirstRow = <S extends Schema.Top>(DataSchema: S) => {
  const RowSchema = DataFromResult(DataSchema);
  return Schema.Array(RowSchema).pipe(
    Schema.decodeTo(
      Schema.Option(Schema.toType(RowSchema)),
      SchemaTransformation.transform({
        decode: Arr.head,
        encode: Option.match({
          onNone: () => [],
          onSome: (item) => [item],
        }),
      }),
    ),
  );
};
