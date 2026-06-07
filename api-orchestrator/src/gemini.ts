import { GoogleGenAI } from "@google/genai";
import {
  DEEP_VALIDATOR_SYSTEM_INSTRUCTION,
  FAST_INTERCEPTOR_SYSTEM_INSTRUCTION,
} from "./prompts";

export interface DeepValidatorResult {
  success: boolean;
  critique: string;
  new_compressed_summary: string;
}

let aiClient: GoogleGenAI | null = null;

function compressSummary(summary: string): string {
  const words = summary.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 100).join(" ");
}

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required.");
  }

  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey });
  }

  return aiClient;
}

export async function callFastInterceptor(
  userInput: string,
  compressedHistorySummary: string,
): Promise<string> {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: "gemini-1.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `compressed_history_summary: ${compressedHistorySummary}\nuser_input: ${userInput}`,
          },
        ],
      },
    ],
    config: {
      systemInstruction: FAST_INTERCEPTOR_SYSTEM_INSTRUCTION,
      maxOutputTokens: 80,
      temperature: 0.7,
    },
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error("Fast interceptor returned empty response.");
  }

  return text;
}

export async function callDeepValidator(
  proofAsset: string,
  dailyStake: string,
): Promise<DeepValidatorResult> {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: "gemini-1.5-pro",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Daily stake: ${dailyStake || "(unset)"}\n\nProof asset:\n${proofAsset}`,
          },
        ],
      },
    ],
    config: {
      systemInstruction: DEEP_VALIDATOR_SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      maxOutputTokens: 160,
      temperature: 0.2,
    },
  });

  const rawJson = response.text?.trim();
  if (!rawJson) {
    throw new Error("Deep validator returned empty response.");
  }

  const parsed = JSON.parse(rawJson) as Partial<DeepValidatorResult>;
  if (
    typeof parsed.success !== "boolean" ||
    typeof parsed.critique !== "string" ||
    typeof parsed.new_compressed_summary !== "string"
  ) {
    throw new Error("Deep validator returned invalid schema.");
  }

  return {
    success: parsed.success,
    critique: parsed.critique,
    new_compressed_summary: compressSummary(parsed.new_compressed_summary),
  };
}
