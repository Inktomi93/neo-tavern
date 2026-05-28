import { OpenRouter } from "@openrouter/sdk";
import "dotenv/config";
import process from "node:process";

const openRouter = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

async function run() {
  const stream1 = await openRouter.chat.send({
    chatRequest: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Say 'hi'" }],
      stream: true,
    } as Record<string, unknown>,
  });

  for await (const _chunk of stream1 as AsyncIterable<unknown>) {
  }
  const stream2 = await openRouter.beta.responses.send({
    responsesRequest: {
      model: "openai/gpt-4o-mini",
      input: [{ role: "user", content: "Say 'hi'" }],
      stream: true,
    } as Record<string, unknown>,
  });

  for await (const _chunk of stream2 as AsyncIterable<unknown>) {
  }
}

run().catch(console.error);
