export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/__test/ping") {
      return Response.json({ ok: true, environment: env.ENVIRONMENT });
    }

    if (url.pathname === "/__test/kv") {
      const key = url.searchParams.get("key") ?? "missing";
      const value = url.searchParams.get("value") ?? "";

      await env.KV.put(key, value);
      return Response.json({ key, value: await env.KV.get(key) });
    }

    if (url.pathname === "/__test/d1") {
      const result = await env.D1.prepare("select 1 as value").first<{
        value: number;
      }>();

      return Response.json(result ?? null);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
