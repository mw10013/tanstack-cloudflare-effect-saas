import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/ai-probe")({
  server: {
    handlers: {
      POST: async ({ request, context }) => {
        const { env } = context;
        const body: {
          prompt?: string;
          transport?: "direct" | "gateway";
        } = await request.json();
        const prompt = body.prompt?.trim();
        const transport = body.transport ?? "direct";
        if (!prompt) {
          return Response.json({ ok: false, error: "Prompt required" }, { status: 400 });
        }
        const model: keyof AiModels = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
        const startedAt = Date.now();
        try {
          const raw =
            transport === "gateway"
              ? await env.AI.run(
                  model,
                  { prompt },
                  {
                    gateway: {
                      id: env.AI_GATEWAY_ID,
                      skipCache: true,
                      cacheTtl: 7 * 24 * 60 * 60,
                    },
                  },
                )
              : await env.AI.run(model, { prompt });
          const elapsedMs = Date.now() - startedAt;
          const text = typeof raw === "string" ? raw : JSON.stringify(raw);
          console.log("api ai probe success", {
            transport,
            model,
            elapsedMs,
            textLength: text.length,
          });
          return Response.json({
            ok: true,
            transport,
            model,
            elapsedMs,
            text,
            raw,
          });
        } catch (error) {
          const elapsedMs = Date.now() - startedAt;
          console.error("api ai probe failed", {
            transport,
            model,
            elapsedMs,
            error,
          });
          return Response.json(
            {
              ok: false,
              transport,
              model,
              elapsedMs,
              error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
