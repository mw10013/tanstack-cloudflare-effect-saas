# AI Gateway with Agents SDK and AI SDK

Based on scanning the Cloudflare docs on AI Gateway, here are the viable approaches for using AI Gateway with the Agent SDK and AI SDK, focusing on Cloudflare LLMs (Workers AI models). You have the necessary tokens (`WORKERS_AI_API_TOKEN` for Workers AI and `AI_GATEWAY_TOKEN` for AI Gateway auth).

## Options for Cloudflare LLM Usage

1. **Direct Workers AI Binding (Recommended for Simplicity)**:
   - Use the Workers AI binding directly in your agent code.
   - Add gateway routing for analytics, caching, and fallbacks.
   - **Pros**: Native Cloudflare integration, low latency, supports streaming.
   - **Setup**: Ensure your `wrangler.toml` has `[ai] binding = "AI"`.
   - **Code Example** (in an Agent method):
     ```ts
     const response = await this.env.AI.run(
       "@cf/meta/llama-3.1-8b-instruct", // Cloudflare LLM
       { prompt: "Your query" },
       {
         gateway: {
           id: "your-gateway-id", // Your AI Gateway name
           skipCache: false,
           cacheTtl: 3360,
         },
       },
     );
     ```
   - **Auth**: Uses `CF_WORKERS_AI_API_TOKEN` implicitly via binding.

2. **AI SDK with Gateway URL (OpenAI Compatibility)**:
   - Use the AI SDK (`@ai-sdk/openai`) with the gateway's OpenAI-compatible endpoint.
   - **Pros**: Leverages AI SDK features like tool calling, structured outputs; easy to switch models/providers via gateway.
   - **Setup**: Install `ai @ai-sdk/openai` in `package.json`.
   - **Code Example** (in an Agent):

     ```ts
     import { createOpenAI } from "@ai-sdk/openai";
     import { generateText } from "ai";

     const openai = createOpenAI({
       baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openai`,
       apiKey: this.env.AI_GATEWAY_TOKEN, // For auth
     });

     const { text } = await generateText({
       model: openai("gpt-4o-mini"), // Or use Workers AI model if mapped
       prompt: "Your query",
     });
     ```

   - **For Cloudflare LLMs**: Use the unified endpoint with Workers AI models (e.g., model: "@cf/meta/llama-3.1-8b-instruct").
   - **Endpoint**: `https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/compat/chat/completions` for OpenAI-like requests.

3. **AI SDK with ai-gateway-provider Package**:
   - Use the `ai-gateway-provider` package for seamless AI SDK integration.
   - **Pros**: Handles gateway routing automatically; supports fallbacks.
   - **Setup**: Install `ai-gateway-provider`.
   - **Code Example**:

     ```ts
     import { openai } from "@ai-sdk/openai";
     import { generateText } from "ai";
     import { aigateway } from "ai-gateway-provider";

     const { text } = await generateText({
       model: aigateway(openai("gpt-4o-mini")), // Routes through gateway
       prompt: "Your query",
     });
     ```

   - Configure with your gateway ID and tokens.

## Viable Approaches Summary

- **Best for Cloudflare LLMs**: Approach 1 (Workers AI binding) is most direct for Cloudflare models, with gateway for enhancements.
- **Best for Flexibility**: Approach 2 or 3 if you need AI SDK features and plan to route between providers.
- **Auth**: Use `AI_GATEWAY_TOKEN` in headers or SDK config for gateway auth; `WORKERS_AI_API_TOKEN` for Workers AI direct access.
- **Setup Gateway**: Create an AI Gateway in the Cloudflare dashboard, enable authentication, and configure BYOK or unified billing for keys.

All approaches support caching, rate limiting, and fallbacks via AI Gateway. Start with Workers AI binding for simplicity with Cloudflare LLMs.
