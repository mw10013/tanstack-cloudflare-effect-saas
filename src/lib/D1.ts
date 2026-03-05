import { Effect, Layer, Schedule, Schema, ServiceMap } from "effect";
import { CloudflareEnv } from "@/lib/CloudflareEnv";

// https://gist.github.com/rxliuli/be31cbded41ef7eac6ae0da9070c8ef8

export class D1Error extends Schema.TaggedErrorClass<D1Error>()("D1Error", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export class D1 extends ServiceMap.Service<D1>()("D1", {
  make: Effect.gen(function* () {
    const { D1: d1 } = yield* CloudflareEnv;
    return {
      prepare: (query: string) => d1.prepare(query),
      batch: <T = Record<string, unknown>>(statements: D1PreparedStatement[]) =>
        tryD1(() => d1.batch<T>(statements)),
      run: <T = Record<string, unknown>>(statement: D1PreparedStatement) =>
        tryD1(() => statement.run<T>()),
      first: <T>(statement: D1PreparedStatement) =>
        tryD1(() => statement.first<T>()),
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}

const NON_RETRYABLE = [
  "SQLITE_CONSTRAINT",
  "SQLITE_ERROR",
  "SQLITE_MISMATCH",
] as const;

const tryD1 = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new D1Error({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(
    Effect.tapError((error) => Effect.log(error)),
    Effect.retry({
      while: (error) => !NON_RETRYABLE.some((p) => error.message.includes(p)),
      times: 2,
      schedule: Schedule.exponential("1 second"),
    }),
  );
