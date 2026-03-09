import OpenAI from "openai";

let cachedClient: OpenAI | undefined;

export function getDefaultModel() {
  return process.env.OPENAI_MODEL || "gpt-5";
}

export function hasOpenAIKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set.");
  }

  cachedClient ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  return cachedClient;
}
