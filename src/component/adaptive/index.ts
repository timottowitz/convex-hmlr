/**
 * Adaptive Compressor - Graduated compression for sliding window
 *
 * Implements intelligent compression based on topic shifts and time:
 * - Calculate semantic distance between queries
 * - Graduated thresholds (0.6, 0.8)
 * - Time as modifier (1hr, 12hr thresholds)
 * - Explicit reference detection
 * - Bridge turn preservation
 */

import { v } from "convex/values";
import { query, mutation } from "../_generated/server";

// ============================================================================
// Types
// ============================================================================

export type CompressionLevel =
  | "NO_COMPRESSION"
  | "COMPRESS_PARTIAL"
  | "COMPRESS_ALL";

export interface CompressionDecision {
  level: CompressionLevel;
  reason: string;
  semanticDistance: number;
  timeGapHours: number;
  hasExplicitReference: boolean;
  keepVerbatimCount: number;
}

// ============================================================================
// Constants
// ============================================================================

const VERY_DIFFERENT_THRESHOLD = 0.8;
const SOMEWHAT_DIFFERENT_THRESHOLD = 0.6;
const SHORT_GAP_HOURS = 1;
const LONG_GAP_HOURS = 12;
const MAX_VERBATIM_HARD_LIMIT = 15;
const COMPRESS_ALL_KEEP = 5;
const COMPRESS_PARTIAL_KEEP = 10;

const REFERENCE_PATTERNS = [
  /\bwe discussed\b/i,
  /\byou mentioned\b/i,
  /\byou said\b/i,
  /\bas I said\b/i,
  /\bearlier you\b/i,
  /\bpreviously\b/i,
  /\bgoing back to\b/i,
];

// ============================================================================
// Helper Functions (exported for client use)
// ============================================================================

export function detectExplicitReference(query: string): boolean {
  return REFERENCE_PATTERNS.some((pattern) => pattern.test(query));
}

export function calculateSimpleDistance(query1: string, query2: string): number {
  const words1 = new Set(
    query1.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
  );
  const words2 = new Set(
    query2.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
  );

  if (words1.size === 0 || words2.size === 0) return 0.5;

  const intersection = new Set([...words1].filter((x) => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return 1 - intersection.size / union.size;
}

export function decideCompression(
  currentQuery: string,
  recentQueries: string[],
  lastTurnTimestamp: number
): CompressionDecision {
  if (recentQueries.length === 0) {
    return {
      level: "NO_COMPRESSION",
      reason: "No recent turns to compress",
      semanticDistance: 0,
      timeGapHours: 0,
      hasExplicitReference: false,
      keepVerbatimCount: 0,
    };
  }

  const hasExplicitReference = detectExplicitReference(currentQuery);
  if (hasExplicitReference) {
    return {
      level: "NO_COMPRESSION",
      reason: "Explicit reference to previous conversation detected",
      semanticDistance: 0,
      timeGapHours: 0,
      hasExplicitReference: true,
      keepVerbatimCount: recentQueries.length,
    };
  }

  const combinedRecent = recentQueries.slice(-3).join(" ");
  const semanticDistance = calculateSimpleDistance(currentQuery, combinedRecent);

  const now = Date.now();
  const timeGapHours = (now - lastTurnTimestamp) / (1000 * 60 * 60);

  let level: CompressionLevel;
  let reason: string;
  let keepVerbatimCount: number;

  if (semanticDistance > VERY_DIFFERENT_THRESHOLD) {
    if (timeGapHours > LONG_GAP_HOURS) {
      level = "COMPRESS_ALL";
      reason = "Very different topic + long time gap";
      keepVerbatimCount = COMPRESS_ALL_KEEP;
    } else {
      level = "COMPRESS_PARTIAL";
      reason = "Very different topic";
      keepVerbatimCount = COMPRESS_PARTIAL_KEEP;
    }
  } else if (semanticDistance > SOMEWHAT_DIFFERENT_THRESHOLD) {
    if (timeGapHours > LONG_GAP_HOURS) {
      level = "COMPRESS_PARTIAL";
      reason = "Somewhat different topic + long time gap";
      keepVerbatimCount = COMPRESS_PARTIAL_KEEP;
    } else {
      level = "NO_COMPRESSION";
      reason = "Similar enough topic and recent";
      keepVerbatimCount = recentQueries.length;
    }
  } else {
    level = "NO_COMPRESSION";
    reason = "Similar topic";
    keepVerbatimCount = recentQueries.length;
  }

  return {
    level,
    reason,
    semanticDistance,
    timeGapHours,
    hasExplicitReference: false,
    keepVerbatimCount: Math.min(keepVerbatimCount, MAX_VERBATIM_HARD_LIMIT),
  };
}

// ============================================================================
// Vector-Based Semantic Distance
// Python: compressor.py AdaptiveCompressor.calc_semantic_distance()
// ============================================================================

/**
 * Calculate cosine similarity between two embedding vectors
 */
export function cosineSimilarity(vec1: number[], vec2: number[]): number {
  if (vec1.length !== vec2.length) return 0;
  
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;
  
  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }
  
  if (norm1 === 0 || norm2 === 0) return 0;
  
  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

/**
 * Calculate semantic distance using embeddings
 * Returns value between 0 (identical) and 1 (completely different)
 * Python: compressor.py calc_semantic_distance()
 */
export function calcSemanticDistanceWithEmbeddings(
  queryEmbedding: number[],
  contextEmbeddings: number[][]
): number {
  if (contextEmbeddings.length === 0) return 0.5; // Default to middle ground
  
  // Calculate average similarity to all context embeddings
  let totalSimilarity = 0;
  for (const contextEmb of contextEmbeddings) {
    totalSimilarity += cosineSimilarity(queryEmbedding, contextEmb);
  }
  
  const avgSimilarity = totalSimilarity / contextEmbeddings.length;
  
  // Convert similarity (0-1, higher = more similar) to distance (0-1, higher = more different)
  return 1 - avgSimilarity;
}

/**
 * Decide compression with embedding-based semantic distance
 * Enhanced version that uses actual embeddings if provided
 */
export function decideCompressionWithEmbeddings(
  currentQuery: string,
  recentQueries: string[],
  lastTurnTimestamp: number,
  queryEmbedding?: number[],
  recentEmbeddings?: number[][]
): CompressionDecision {
  if (recentQueries.length === 0) {
    return {
      level: "NO_COMPRESSION",
      reason: "No recent turns to compress",
      semanticDistance: 0,
      timeGapHours: 0,
      hasExplicitReference: false,
      keepVerbatimCount: 0,
    };
  }

  const hasExplicitReference = detectExplicitReference(currentQuery);
  if (hasExplicitReference) {
    return {
      level: "NO_COMPRESSION",
      reason: "Explicit reference to previous conversation detected",
      semanticDistance: 0,
      timeGapHours: 0,
      hasExplicitReference: true,
      keepVerbatimCount: recentQueries.length,
    };
  }

  // Use embedding-based distance if available, otherwise fall back to word overlap
  let semanticDistance: number;
  if (queryEmbedding && recentEmbeddings && recentEmbeddings.length > 0) {
    semanticDistance = calcSemanticDistanceWithEmbeddings(queryEmbedding, recentEmbeddings);
  } else {
    const combinedRecent = recentQueries.slice(-3).join(" ");
    semanticDistance = calculateSimpleDistance(currentQuery, combinedRecent);
  }

  const now = Date.now();
  const timeGapHours = (now - lastTurnTimestamp) / (1000 * 60 * 60);

  let level: CompressionLevel;
  let reason: string;
  let keepVerbatimCount: number;

  if (semanticDistance > VERY_DIFFERENT_THRESHOLD) {
    if (timeGapHours > LONG_GAP_HOURS) {
      level = "COMPRESS_ALL";
      reason = "Very different topic + long time gap (embedding-based)";
      keepVerbatimCount = COMPRESS_ALL_KEEP;
    } else {
      level = "COMPRESS_PARTIAL";
      reason = "Very different topic (embedding-based)";
      keepVerbatimCount = COMPRESS_PARTIAL_KEEP;
    }
  } else if (semanticDistance > SOMEWHAT_DIFFERENT_THRESHOLD) {
    if (timeGapHours > LONG_GAP_HOURS) {
      level = "COMPRESS_PARTIAL";
      reason = "Somewhat different topic + long time gap (embedding-based)";
      keepVerbatimCount = COMPRESS_PARTIAL_KEEP;
    } else {
      level = "NO_COMPRESSION";
      reason = "Similar enough topic and recent (embedding-based)";
      keepVerbatimCount = recentQueries.length;
    }
  } else {
    level = "NO_COMPRESSION";
    reason = "Similar topic (embedding-based)";
    keepVerbatimCount = recentQueries.length;
  }

  return {
    level,
    reason,
    semanticDistance,
    timeGapHours,
    hasExplicitReference: false,
    keepVerbatimCount: Math.min(keepVerbatimCount, MAX_VERBATIM_HARD_LIMIT),
  };
}

// ============================================================================
// Queries
// ============================================================================

export const getCompressionStats = query({
  args: { blockId: v.id("bridgeBlocks") },
  handler: async (ctx, args) => {
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_block", (q) => q.eq("blockId", args.blockId))
      .collect();

    if (turns.length === 0) {
      return {
        totalTurns: 0,
        oldestTimestamp: null,
        newestTimestamp: null,
        averageMessageLength: 0,
      };
    }

    const timestamps = turns.map((t) => t.timestamp);
    const totalLength = turns.reduce((sum, t) => sum + t.userMessage.length, 0);

    return {
      totalTurns: turns.length,
      oldestTimestamp: Math.min(...timestamps),
      newestTimestamp: Math.max(...timestamps),
      averageMessageLength: Math.round(totalLength / turns.length),
    };
  },
});
