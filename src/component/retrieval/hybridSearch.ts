/**
 * Hybrid Search Engine - Combined vector + lexical search
 *
 * Ported from Python: memory/retrieval/hybrid_search.py
 *
 * Implements 2-key filtering approach:
 * 1. Vector search (semantic similarity)
 * 2. Lexical search (keyword matching)
 * 3. Combine and re-rank results
 */

import { v } from "convex/values";
import { query, action } from "../_generated/server";

// ============================================================================
// Types
// ============================================================================

export interface HybridMatch {
  chunkId: string;
  turnId: string;
  blockId: string;
  content: string;
  vectorScore: number;
  lexicalScore: number;
  combinedScore: number;
  matchedKeywords: string[];
}

export interface SearchOptions {
  vectorWeight: number;
  lexicalWeight: number;
  minScore: number;
  topK: number;
  blockFilter?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_OPTIONS: SearchOptions = {
  vectorWeight: 0.7,
  lexicalWeight: 0.3,
  minScore: 0.3,
  topK: 10,
};

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "and", "or", "but",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "as",
  "this", "that", "these", "those", "it", "its", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "should",
  "could", "may", "might", "can", "my", "your", "his", "her", "their",
]);

// ============================================================================
// Lexical Search Functions
// ============================================================================

export function extractSearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

export function calculateLexicalScore(
  content: string,
  searchTerms: string[]
): { score: number; matchedTerms: string[] } {
  if (searchTerms.length === 0) {
    return { score: 0, matchedTerms: [] };
  }

  const contentLower = content.toLowerCase();
  const contentWords = new Set(
    contentLower.split(/\s+/).map((w) => w.replace(/[^\w]/g, ""))
  );

  const matchedTerms: string[] = [];

  for (const term of searchTerms) {
    // Exact word match
    if (contentWords.has(term)) {
      matchedTerms.push(term);
    }
    // Substring match (for partial matches)
    else if (contentLower.includes(term)) {
      matchedTerms.push(term);
    }
  }

  const score = matchedTerms.length / searchTerms.length;
  return { score, matchedTerms };
}

// ============================================================================
// Hybrid Ranking
// ============================================================================

export function combineScores(
  vectorScore: number,
  lexicalScore: number,
  options: SearchOptions = DEFAULT_OPTIONS
): number {
  return (
    vectorScore * options.vectorWeight + lexicalScore * options.lexicalWeight
  );
}

export function rankResults(
  vectorResults: Array<{ id: string; content: string; score: number }>,
  lexicalResults: Map<string, { score: number; matchedTerms: string[] }>,
  options: SearchOptions = DEFAULT_OPTIONS
): HybridMatch[] {
  const combined: HybridMatch[] = [];

  for (const vr of vectorResults) {
    const lexical = lexicalResults.get(vr.id) || { score: 0, matchedTerms: [] };
    const combinedScore = combineScores(vr.score, lexical.score, options);

    if (combinedScore >= options.minScore) {
      combined.push({
        chunkId: vr.id,
        turnId: "", // Would be filled in from actual data
        blockId: "", // Would be filled in from actual data
        content: vr.content,
        vectorScore: vr.score,
        lexicalScore: lexical.score,
        combinedScore,
        matchedKeywords: lexical.matchedTerms,
      });
    }
  }

  // Sort by combined score descending
  combined.sort((a, b) => b.combinedScore - a.combinedScore);

  return combined.slice(0, options.topK);
}

// ============================================================================
// Convex Queries
// ============================================================================

export const searchMemories = query({
  args: {
    keywords: v.array(v.string()),
    blockId: v.optional(v.id("bridgeBlocks")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    // Get memories, optionally filtered by block
    let memories;
    if (args.blockId) {
      memories = await ctx.db
        .query("memories")
        .withIndex("by_block", (q) => q.eq("blockId", args.blockId))
        .take(limit * 2); // Get extra to filter
    } else {
      memories = await ctx.db.query("memories").take(limit * 2);
    }

    // Score by lexical match
    const results: Array<{
      memory: typeof memories[0];
      score: number;
      matchedKeywords: string[];
    }> = [];

    for (const memory of memories) {
      const { score, matchedTerms } = calculateLexicalScore(
        memory.content,
        args.keywords
      );
      if (score > 0) {
        results.push({
          memory,
          score,
          matchedKeywords: matchedTerms,
        });
      }
    }

    // Sort by score
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit).map((r) => ({
      turnId: r.memory.turnId,
      blockId: r.memory.blockId,
      content: r.memory.content,
      score: r.score,
      matchedKeywords: r.matchedKeywords,
    }));
  },
});

export const searchChunks = query({
  args: {
    keywords: v.array(v.string()),
    blockId: v.optional(v.id("bridgeBlocks")),
    chunkType: v.optional(v.union(v.literal("sentence"), v.literal("paragraph"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    // Get chunks
    let chunks;
    if (args.blockId) {
      chunks = await ctx.db
        .query("chunks")
        .withIndex("by_block", (q) => q.eq("blockId", args.blockId))
        .take(limit * 3);
    } else {
      chunks = await ctx.db.query("chunks").take(limit * 3);
    }

    // Filter by type if specified
    if (args.chunkType) {
      chunks = chunks.filter((c) => c.chunkType === args.chunkType);
    }

    // Score by lexical match
    const results: Array<{
      chunk: typeof chunks[0];
      score: number;
      matchedKeywords: string[];
    }> = [];

    for (const chunk of chunks) {
      // Check lexicalFilters first (faster)
      const filterMatches = chunk.lexicalFilters.filter((f: string) =>
        args.keywords.some((k) => f.includes(k) || k.includes(f))
      );

      if (filterMatches.length > 0) {
        // Full text search for score
        const { score, matchedTerms } = calculateLexicalScore(
          chunk.textVerbatim,
          args.keywords
        );
        results.push({
          chunk,
          score: Math.max(score, filterMatches.length / args.keywords.length),
          matchedKeywords: [...new Set([...matchedTerms, ...filterMatches])],
        });
      }
    }

    // Sort by score
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit).map((r) => ({
      chunkId: r.chunk.chunkId,
      chunkType: r.chunk.chunkType,
      turnId: r.chunk.turnId,
      blockId: r.chunk.blockId,
      content: r.chunk.textVerbatim,
      score: r.score,
      matchedKeywords: r.matchedKeywords,
    }));
  },
});

export const searchFacts = query({
  args: {
    keywords: v.array(v.string()),
    category: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;

    // Get facts
    let facts;
    if (args.category) {
      facts = await ctx.db
        .query("facts")
        .withIndex("by_category", (q) =>
          q.eq("category", args.category as any)
        )
        .take(limit * 2);
    } else {
      facts = await ctx.db.query("facts").take(limit * 2);
    }

    // Score by keyword match in key or value
    const results: Array<{
      fact: typeof facts[0];
      score: number;
    }> = [];

    for (const fact of facts) {
      const combined = `${fact.key} ${fact.value}`.toLowerCase();
      let matches = 0;
      for (const keyword of args.keywords) {
        if (combined.includes(keyword.toLowerCase())) {
          matches++;
        }
      }
      if (matches > 0) {
        results.push({
          fact,
          score: matches / args.keywords.length,
        });
      }
    }

    // Sort by score
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit).map((r) => ({
      key: r.fact.key,
      value: r.fact.value,
      category: r.fact.category,
      score: r.score,
    }));
  },
});

// ============================================================================
// Vector Search Action
// ============================================================================

// Note: hybridSearch action would need internal queries to work properly.
// For now, use the query-based search functions above, or implement
// vector search at the client level by calling vectorSearch directly.
