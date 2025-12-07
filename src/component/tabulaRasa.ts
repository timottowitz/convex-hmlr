/**
 * Tabula Rasa - Topic Segmentation
 *
 * Automatically detect when a conversation shifts topics,
 * close the current Bridge Block, and open a new one.
 *
 * Python Reference: memory/tabula_rasa.py
 * - Uses nano_metadata from LLM for intelligent shift detection
 * - Falls back to heuristic extraction when LLM data unavailable
 */

import { v } from "convex/values";
import { query, mutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// ============================================================================
// Types
// ============================================================================

export interface TopicShiftResult {
  isShift: boolean;
  reason: string;
  newTopicLabel?: string;
  confidence: number;
}

// ============================================================================
// Constants
// ============================================================================

const SHIFT_THRESHOLD = 0.7;

const SHIFT_PHRASES = [
  /let's talk about (.+?) instead/i,
  /changing topics? to (.+)/i,
  /moving on to (.+)/i,
  /new topic[:\s]+(.+)/i,
  /can we discuss (.+)/i,
  /switching to (.+)/i,
];

const CONTINUATION_PHRASES = [
  /^(so|and|but|also|additionally|furthermore)/i,
  /as (i|we) (said|mentioned|discussed)/i,
  /going back to/i,
  /regarding (that|this|the)/i,
];

// ============================================================================
// Helper Functions (exported for client use)
// ============================================================================

export function detectExplicitShift(query: string): { isShift: boolean; topic?: string } {
  for (const pattern of SHIFT_PHRASES) {
    const match = query.match(pattern);
    if (match) {
      return { isShift: true, topic: match[1]?.trim() };
    }
  }
  return { isShift: false };
}

export function detectContinuation(query: string): boolean {
  return CONTINUATION_PHRASES.some((pattern) => pattern.test(query));
}

export function extractTopicsFromQuery(query: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "and", "or", "but",
    "in", "on", "at", "to", "for", "of", "with", "by", "from", "i",
    "you", "we", "they", "it", "this", "that", "what", "how", "why",
    "when", "where", "can", "could", "would", "should", "do", "does",
    "did", "have", "has", "had", "be", "been", "being", "my", "your",
    "me", "about", "help", "want", "need", "please", "tell",
  ]);

  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 5);
}

export function checkForShift(
  query: string,
  activeBlockKeywords: string[]
): TopicShiftResult {
  // No active block = definitely a shift
  if (activeBlockKeywords.length === 0) {
    const topics = extractTopicsFromQuery(query);
    return {
      isShift: true,
      reason: "No active topic - starting new conversation",
      newTopicLabel: topics[0] || "General Conversation",
      confidence: 1.0,
    };
  }

  // Check explicit shift
  const explicitShift = detectExplicitShift(query);
  if (explicitShift.isShift) {
    return {
      isShift: true,
      reason: "Explicit topic change detected",
      newTopicLabel: explicitShift.topic || "New Topic",
      confidence: 1.0,
    };
  }

  // Check continuation
  if (detectContinuation(query)) {
    return {
      isShift: false,
      reason: "Continuation phrase detected",
      confidence: 0.1,
    };
  }

  // Calculate topic similarity
  const queryTopics = extractTopicsFromQuery(query);
  const querySet = new Set(queryTopics);
  const blockSet = new Set(activeBlockKeywords.map((k) => k.toLowerCase()));

  let matches = 0;
  for (const topic of querySet) {
    if (blockSet.has(topic)) matches++;
  }

  const union = new Set([...querySet, ...blockSet]);
  const similarity = union.size > 0 ? matches / union.size : 0;
  const shiftConfidence = 1 - similarity;

  if (shiftConfidence > SHIFT_THRESHOLD) {
    return {
      isShift: true,
      reason: `Low topic similarity (${(similarity * 100).toFixed(0)}%)`,
      newTopicLabel: queryTopics[0] || "New Topic",
      confidence: shiftConfidence,
    };
  }

  return {
    isShift: false,
    reason: `Topics similar (${(similarity * 100).toFixed(0)}% match)`,
    confidence: 1 - shiftConfidence,
  };
}

/**
 * Check for topic shift using LLM metadata
 * Python: tabula_rasa.py check_for_shift() with nano_metadata
 * 
 * This is the "smart" method - uses GPT-4o-mini to detect topic shifts
 * with high accuracy. Falls back to heuristics if metadata unavailable.
 */
export function checkForShiftWithMetadata(
  query: string,
  activeBlockKeywords: string[],
  nanoMetadata?: {
    isTopicShift?: boolean;
    newTopicLabel?: string;
    topics?: string[];
    confidence?: number;
  }
): TopicShiftResult {
  // No active block = definitely a shift
  if (activeBlockKeywords.length === 0) {
    let newLabel = "General Conversation";
    if (nanoMetadata?.topics?.[0]) {
      newLabel = nanoMetadata.topics[0];
    } else if (nanoMetadata?.newTopicLabel) {
      newLabel = nanoMetadata.newTopicLabel;
    } else {
      const topics = extractTopicsFromQuery(query);
      newLabel = topics[0] || "General Conversation";
    }
    return {
      isShift: true,
      reason: "No active topic - starting new conversation",
      newTopicLabel: newLabel,
      confidence: 1.0,
    };
  }

  // Use LLM metadata if available (smartest method)
  // Python: tabula_rasa.py lines 90-100
  if (nanoMetadata?.isTopicShift) {
    return {
      isShift: true,
      reason: "LLM detected topic shift",
      newTopicLabel: nanoMetadata.newTopicLabel || "New Topic",
      confidence: nanoMetadata.confidence ?? 0.95,
    };
  }

  // If LLM says no shift, trust it
  if (nanoMetadata && nanoMetadata.isTopicShift === false) {
    return {
      isShift: false,
      reason: "LLM confirmed topic continuation",
      confidence: nanoMetadata.confidence ?? 0.9,
    };
  }

  // Fall back to heuristic detection
  return checkForShift(query, activeBlockKeywords);
}

// ============================================================================
// LLM-Based Topic Shift Detection Action
// Python: tabula_rasa.py uses nano_metadata from GPT-4o-nano
// ============================================================================

/**
 * Detect topic shift using LLM
 * Called before processing a turn to determine if we need a new block
 */
export const detectTopicShiftWithLLM = internalAction({
  args: {
    query: v.string(),
    currentTopicLabel: v.string(),
    recentKeywords: v.array(v.string()),
    openaiApiKey: v.string(),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const model = args.model ?? "gpt-4o-mini";

    const prompt = `Analyze if this user message represents a topic shift from the current conversation.

Current Topic: ${args.currentTopicLabel}
Current Keywords: ${args.recentKeywords.join(", ")}

User Message: "${args.query}"

Respond with JSON only:
{
  "is_topic_shift": boolean,
  "new_topic_label": string or null (if shift, what's the new topic? 2-5 words),
  "confidence": number (0-1),
  "reasoning": string (brief explanation)
}`;

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: "You are a topic analyzer. Detect conversation topic shifts. Return JSON only.",
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 150,
          temperature: 0.2,
        }),
      });

      if (!response.ok) {
        return { success: false, error: `API error: ${response.status}` };
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content ?? "{}";

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { success: false, error: "No JSON in response" };
      }

      const result = JSON.parse(jsonMatch[0]);

      return {
        success: true,
        isTopicShift: result.is_topic_shift,
        newTopicLabel: result.new_topic_label,
        confidence: result.confidence,
        reasoning: result.reasoning,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ============================================================================
// Queries
// ============================================================================

export const getActiveBlock = query({
  args: { dayId: v.string() },
  handler: async (ctx, args) => {
    // Use by_day index and filter by status
    const blocks = await ctx.db
      .query("bridgeBlocks")
      .withIndex("by_day", (q) => q.eq("dayId", args.dayId))
      .filter((q) => q.eq(q.field("status"), "ACTIVE"))
      .first();
    return blocks;
  },
});

export const getBlockHistory = query({
  args: { dayId: v.string() },
  handler: async (ctx, args) => {
    const blocks = await ctx.db
      .query("bridgeBlocks")
      .withIndex("by_day", (q) => q.eq("dayId", args.dayId))
      .order("desc")
      .collect();

    return blocks.map((b) => ({
      id: b._id,
      topicLabel: b.topicLabel,
      status: b.status,
      turnCount: b.turnCount,
      createdAt: b.createdAt,
    }));
  },
});

// ============================================================================
// Mutations
// ============================================================================

export const closeBlock = mutation({
  args: { blockId: v.id("bridgeBlocks") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.blockId, {
      status: "CLOSED",
      updatedAt: Date.now(),
    });
    return args.blockId;
  },
});

export const createNewBlock = mutation({
  args: {
    dayId: v.string(),
    topicLabel: v.string(),
    keywords: v.array(v.string()),
    prevBlockId: v.optional(v.id("bridgeBlocks")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("bridgeBlocks", {
      dayId: args.dayId,
      topicLabel: args.topicLabel,
      keywords: args.keywords,
      status: "ACTIVE",
      prevBlockId: args.prevBlockId,
      openLoops: [],
      decisionsMade: [],
      turnCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});
