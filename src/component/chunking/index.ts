/**
 * Chunking Engine - Hierarchical text chunking
 *
 * Creates immutable chunks at ingestion time:
 * - Sentences: Finest granularity (for fact linking)
 * - Paragraphs: Mid-level granularity (for context)
 */

import { v } from "convex/values";
import { query, mutation } from "../_generated/server";

// ============================================================================
// Types
// ============================================================================

export interface Chunk {
  chunkId: string;
  chunkType: "sentence" | "paragraph";
  textVerbatim: string;
  lexicalFilters: string[];
  parentChunkId?: string;
  turnId: string;
  tokenCount: number;
}

// ============================================================================
// Constants
// ============================================================================

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "and", "or", "but",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "as",
  "this", "that", "these", "those", "it", "its", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "should",
  "could", "may", "might", "can", "my", "your", "his", "her", "their",
  "our", "i", "you", "he", "she", "we", "they", "what", "which", "who",
  "when", "where", "why", "how", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not", "only",
]);

// ============================================================================
// Helper Functions (exported for client use)
// ============================================================================

function generateChunkId(
  chunkType: "sentence" | "paragraph",
  index: number
): string {
  const prefix = chunkType === "sentence" ? "sent" : "para";
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${index}_${random}`;
}

export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i)
    .slice(0, 20);
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function splitIntoParagraphs(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0 && text.trim().length > 0) {
    return [text.trim()];
  }

  return paragraphs;
}

export function chunkText(text: string, turnId: string): Chunk[] {
  const chunks: Chunk[] = [];
  const paragraphTexts = splitIntoParagraphs(text);

  let sentenceIndex = 0;

  for (let pIndex = 0; pIndex < paragraphTexts.length; pIndex++) {
    const paragraphText = paragraphTexts[pIndex];
    const paragraphId = generateChunkId("paragraph", pIndex);

    // Create paragraph chunk
    chunks.push({
      chunkId: paragraphId,
      chunkType: "paragraph",
      textVerbatim: paragraphText,
      lexicalFilters: extractKeywords(paragraphText),
      turnId,
      tokenCount: estimateTokenCount(paragraphText),
    });

    // Split into sentences
    const sentenceTexts = splitIntoSentences(paragraphText);

    for (const sentenceText of sentenceTexts) {
      chunks.push({
        chunkId: generateChunkId("sentence", sentenceIndex),
        chunkType: "sentence",
        textVerbatim: sentenceText,
        lexicalFilters: extractKeywords(sentenceText),
        parentChunkId: paragraphId,
        turnId,
        tokenCount: estimateTokenCount(sentenceText),
      });
      sentenceIndex++;
    }
  }

  return chunks;
}

// ============================================================================
// Queries
// ============================================================================

export const getChunksByTurn = query({
  args: { turnId: v.string() },
  handler: async (ctx, args) => {
    const chunks = await ctx.db
      .query("chunks")
      .withIndex("by_turn", (q) => q.eq("turnId", args.turnId))
      .collect();

    return {
      sentences: chunks.filter((c) => c.chunkType === "sentence"),
      paragraphs: chunks.filter((c) => c.chunkType === "paragraph"),
    };
  },
});

export const getChunksByBlock = query({
  args: { blockId: v.id("bridgeBlocks") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("chunks")
      .withIndex("by_block", (q) => q.eq("blockId", args.blockId))
      .collect();
  },
});

export const searchChunksByKeyword = query({
  args: {
    keyword: v.string(),
    blockId: v.optional(v.id("bridgeBlocks")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const keywordLower = args.keyword.toLowerCase();

    let allChunks;
    if (args.blockId) {
      allChunks = await ctx.db
        .query("chunks")
        .withIndex("by_block", (q) => q.eq("blockId", args.blockId))
        .collect();
    } else {
      allChunks = await ctx.db.query("chunks").collect();
    }

    return allChunks
      .filter((c) =>
        c.lexicalFilters.some((kw: string) => kw.toLowerCase().includes(keywordLower))
      )
      .slice(0, limit);
  },
});

// ============================================================================
// Mutations
// ============================================================================

/**
 * Chunk a turn and save to database
 * Python: chunks = self.chunk_engine.chunk_turn(text=user_query, turn_id=turn_id)
 */
export const chunkTurn = mutation({
  args: {
    text: v.string(),
    turnId: v.string(),
    blockId: v.optional(v.id("bridgeBlocks")),
  },
  returns: v.object({
    sentenceCount: v.number(),
    paragraphCount: v.number(),
    totalTokens: v.number(),
  }),
  handler: async (ctx, args) => {
    const chunks = chunkText(args.text, args.turnId);

    let sentenceCount = 0;
    let paragraphCount = 0;
    let totalTokens = 0;

    for (const chunk of chunks) {
      await ctx.db.insert("chunks", {
        chunkId: chunk.chunkId,
        chunkType: chunk.chunkType,
        textVerbatim: chunk.textVerbatim,
        lexicalFilters: chunk.lexicalFilters,
        parentChunkId: chunk.parentChunkId,
        turnId: chunk.turnId,
        blockId: args.blockId,
        tokenCount: chunk.tokenCount,
        createdAt: Date.now(),
      });

      if (chunk.chunkType === "sentence") {
        sentenceCount++;
      } else {
        paragraphCount++;
      }
      totalTokens += chunk.tokenCount;
    }

    return { sentenceCount, paragraphCount, totalTokens };
  },
});

/**
 * Update block ID for chunks (after routing determines block)
 * Python: self.storage.update_facts_block_id(turn_id, block_id)
 */
export const updateBlockId = mutation({
  args: {
    turnId: v.string(),
    blockId: v.id("bridgeBlocks"),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const chunks = await ctx.db
      .query("chunks")
      .withIndex("by_turn", (q) => q.eq("turnId", args.turnId))
      .collect();

    for (const chunk of chunks) {
      await ctx.db.patch(chunk._id, { blockId: args.blockId });
    }

    return chunks.length;
  },
});

export const saveChunks = mutation({
  args: {
    chunks: v.array(
      v.object({
        chunkId: v.string(),
        chunkType: v.union(v.literal("sentence"), v.literal("paragraph")),
        textVerbatim: v.string(),
        lexicalFilters: v.array(v.string()),
        parentChunkId: v.optional(v.string()),
        turnId: v.string(),
        blockId: v.id("bridgeBlocks"),
        tokenCount: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const ids = [];
    for (const chunk of args.chunks) {
      const id = await ctx.db.insert("chunks", {
        ...chunk,
        createdAt: Date.now(),
      });
      ids.push(id);
    }
    return ids;
  },
});

export const updateChunkEmbedding = mutation({
  args: {
    chunkId: v.string(),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    const chunk = await ctx.db
      .query("chunks")
      .withIndex("by_chunkId", (q) => q.eq("chunkId", args.chunkId))
      .first();

    if (chunk) {
      await ctx.db.patch(chunk._id, { embedding: args.embedding });
      return chunk._id;
    }

    return null;
  },
});
