import { v } from "convex/values";
import { action, mutation, query, internalMutation } from "./_generated/server.js";
import { internal } from "./_generated/api.js";

/**
 * Memories - Vector embeddings for semantic search
 *
 * Each memory is a chunk of conversation with its embedding vector.
 * Used by the Governor for 2-key filtering (vector similarity + LLM validation).
 *
 * Embedding generation is done externally (via ZeroEntropy API) and passed in.
 */

// ============================================================================
// Queries
// ============================================================================

/**
 * Get all memories for a specific turn
 */
export const getByTurn = query({
  args: { turnId: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("memories"),
      turnId: v.string(),
      blockId: v.id("bridgeBlocks"),
      content: v.string(),
      chunkIndex: v.number(),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const memories = await ctx.db
      .query("memories")
      .withIndex("by_turn", (q) => q.eq("turnId", args.turnId))
      .collect();

    // Return without embedding (it's large and not needed for display)
    return memories.map((m) => ({
      _id: m._id,
      turnId: m.turnId,
      blockId: m.blockId,
      content: m.content,
      chunkIndex: m.chunkIndex,
      createdAt: m.createdAt,
    }));
  },
});

/**
 * Get all memories for a Bridge Block
 */
export const getByBlock = query({
  args: { blockId: v.id("bridgeBlocks") },
  returns: v.array(
    v.object({
      _id: v.id("memories"),
      turnId: v.string(),
      blockId: v.id("bridgeBlocks"),
      content: v.string(),
      chunkIndex: v.number(),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const memories = await ctx.db
      .query("memories")
      .withIndex("by_block", (q) => q.eq("blockId", args.blockId))
      .collect();

    return memories.map((m) => ({
      _id: m._id,
      turnId: m.turnId,
      blockId: m.blockId,
      content: m.content,
      chunkIndex: m.chunkIndex,
      createdAt: m.createdAt,
    }));
  },
});

// ============================================================================
// Mutations
// ============================================================================

/**
 * Store a memory with its embedding
 */
export const store = mutation({
  args: {
    turnId: v.string(),
    blockId: v.id("bridgeBlocks"),
    content: v.string(),
    chunkIndex: v.number(),
    embedding: v.array(v.float64()),
  },
  returns: v.id("memories"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("memories", {
      turnId: args.turnId,
      blockId: args.blockId,
      content: args.content,
      chunkIndex: args.chunkIndex,
      embedding: args.embedding,
      createdAt: Date.now(),
    });
  },
});

/**
 * Store multiple memories at once (batch operation for multi-chunk content)
 */
export const storeBatch = mutation({
  args: {
    memories: v.array(
      v.object({
        turnId: v.string(),
        blockId: v.id("bridgeBlocks"),
        content: v.string(),
        chunkIndex: v.number(),
        embedding: v.array(v.float64()),
      })
    ),
  },
  returns: v.array(v.id("memories")),
  handler: async (ctx, args) => {
    const now = Date.now();
    const ids: string[] = [];

    for (const memory of args.memories) {
      const id = await ctx.db.insert("memories", {
        ...memory,
        createdAt: now,
      });
      ids.push(id);
    }

    return ids as any;
  },
});

/**
 * Delete all memories for a turn (used when re-embedding)
 */
export const deleteByTurn = mutation({
  args: { turnId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const memories = await ctx.db
      .query("memories")
      .withIndex("by_turn", (q) => q.eq("turnId", args.turnId))
      .collect();

    for (const memory of memories) {
      await ctx.db.delete(memory._id);
    }

    return memories.length;
  },
});

// ============================================================================
// Actions (for vector search - must be in action context)
// ============================================================================

/**
 * Search memories by vector similarity
 *
 * This is the core semantic search function.
 * Called from actions (not queries) because vector search requires action context.
 */
export const search = action({
  args: {
    embedding: v.array(v.float64()),
    limit: v.optional(v.number()),
    blockId: v.optional(v.id("bridgeBlocks")),
  },
  returns: v.array(
    v.object({
      _id: v.string(),
      turnId: v.string(),
      blockId: v.string(),
      content: v.string(),
      chunkIndex: v.number(),
      score: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;

    // Perform vector search
    let results;
    if (args.blockId) {
      // Filter by specific block
      results = await ctx.vectorSearch("memories", "by_embedding", {
        vector: args.embedding,
        limit,
        filter: (q) => q.eq("blockId", args.blockId!),
      });
    } else {
      // Search all memories
      results = await ctx.vectorSearch("memories", "by_embedding", {
        vector: args.embedding,
        limit,
      });
    }

    // Fetch full documents for the results
    const memoriesWithContent = await Promise.all(
      results.map(async (result) => {
        const memory = await ctx.runQuery(internal.memories.getById, {
          id: result._id,
        });
        return {
          _id: result._id,
          turnId: memory?.turnId ?? "",
          blockId: memory?.blockId ?? "",
          content: memory?.content ?? "",
          chunkIndex: memory?.chunkIndex ?? 0,
          score: result._score,
        };
      })
    );

    return memoriesWithContent;
  },
});

/**
 * Internal query to get memory by ID (for use within actions)
 */
export const getById = query({
  args: { id: v.id("memories") },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("memories"),
      turnId: v.string(),
      blockId: v.id("bridgeBlocks"),
      content: v.string(),
      chunkIndex: v.number(),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const memory = await ctx.db.get(args.id);
    if (!memory) return null;

    return {
      _id: memory._id,
      turnId: memory.turnId,
      blockId: memory.blockId,
      content: memory.content,
      chunkIndex: memory.chunkIndex,
      createdAt: memory.createdAt,
    };
  },
});

/**
 * Search and retrieve full context for memories
 * Returns memories with their associated turns and blocks
 */
export const searchWithContext = action({
  args: {
    embedding: v.array(v.float64()),
    limit: v.optional(v.number()),
    minScore: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      memory: v.object({
        _id: v.string(),
        content: v.string(),
        score: v.number(),
      }),
      turn: v.optional(
        v.object({
          turnId: v.string(),
          userMessage: v.string(),
          aiResponse: v.string(),
        })
      ),
      block: v.optional(
        v.object({
          blockId: v.string(),
          topicLabel: v.string(),
          dayId: v.string(),
        })
      ),
    })
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    const minScore = args.minScore ?? 0.0;

    // Perform vector search
    const results = await ctx.vectorSearch("memories", "by_embedding", {
      vector: args.embedding,
      limit: limit * 2, // Get more to filter by score
    });

    // Filter by minimum score
    const filteredResults = results.filter((r) => r._score >= minScore).slice(0, limit);

    // Fetch context for each result
    const contextualized = await Promise.all(
      filteredResults.map(async (result) => {
        const memory = await ctx.runQuery(internal.memories.getById, {
          id: result._id,
        });

        if (!memory) {
          return {
            memory: {
              _id: result._id,
              content: "",
              score: result._score,
            },
            turn: undefined,
            block: undefined,
          };
        }

        // Get the associated turn
        const turns = await ctx.runQuery(internal.memories.getTurnByTurnId, {
          turnId: memory.turnId,
        });
        const turn = turns[0];

        // Get the associated block
        const block = await ctx.runQuery(internal.memories.getBlockById, {
          blockId: memory.blockId,
        });

        return {
          memory: {
            _id: result._id,
            content: memory.content,
            score: result._score,
          },
          turn: turn
            ? {
                turnId: turn.turnId,
                userMessage: turn.userMessage,
                aiResponse: turn.aiResponse,
              }
            : undefined,
          block: block
            ? {
                blockId: block._id,
                topicLabel: block.topicLabel,
                dayId: block.dayId,
              }
            : undefined,
        };
      })
    );

    return contextualized;
  },
});

/**
 * Internal helper: Get turn by turnId
 */
export const getTurnByTurnId = query({
  args: { turnId: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("turns"),
      turnId: v.string(),
      userMessage: v.string(),
      aiResponse: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .collect();

    return turns.map((t) => ({
      _id: t._id,
      turnId: t.turnId,
      userMessage: t.userMessage,
      aiResponse: t.aiResponse,
    }));
  },
});

/**
 * Internal helper: Get block by ID
 */
export const getBlockById = query({
  args: { blockId: v.id("bridgeBlocks") },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("bridgeBlocks"),
      topicLabel: v.string(),
      dayId: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const block = await ctx.db.get(args.blockId);
    if (!block) return null;

    return {
      _id: block._id,
      topicLabel: block.topicLabel,
      dayId: block.dayId,
    };
  },
});

// ============================================================================
// Gardened Memory Search
// Python: crawler.py _search_gardened_memory()
// ============================================================================

/**
 * Search gardened (long-term) memory with hierarchical awareness
 * 
 * Python: LatticeCrawler._search_gardened_memory()
 * 
 * This searches across all memories with:
 * - Vector similarity for semantic matching
 * - Chunk hierarchy awareness (sentence → paragraph → block)
 * - Global meta-tag propagation from blocks
 * - Excludes current day (those are in sliding window)
 */
export const searchGardenedMemory = action({
  args: {
    embedding: v.array(v.float64()),
    query: v.string(),
    currentDayId: v.string(),
    topK: v.optional(v.number()),
    minSimilarity: v.optional(v.number()),
  },
  returns: v.array(v.object({
    memoryId: v.string(),
    content: v.string(),
    score: v.number(),
    turnId: v.string(),
    blockId: v.string(),
    topicLabel: v.string(),
    dayId: v.string(),
    chunkType: v.string(),
    keywords: v.array(v.string()),
  })),
  handler: async (ctx, args) => {
    const topK = args.topK ?? 20;
    const minSimilarity = args.minSimilarity ?? 0.4;

    // Perform vector search across all memories
    const results = await ctx.vectorSearch("memories", "by_embedding", {
      vector: args.embedding,
      limit: topK * 2, // Get extra to filter
    });

    // Filter and enrich results
    const enrichedResults = [];

    for (const result of results) {
      if (result._score < minSimilarity) continue;

      // Get the full memory
      const memory = await ctx.runQuery(internal.memories.getById, {
        id: result._id,
      });

      if (!memory) continue;

      // Get the block for this memory
      const block = await ctx.runQuery(internal.memories.getBlockById, {
        blockId: memory.blockId,
      });

      if (!block) continue;

      // Exclude current day memories (those are in sliding window)
      if (block.dayId === args.currentDayId) continue;

      // Determine chunk type based on content length
      const chunkType = memory.content.length < 200 
        ? "sentence" 
        : memory.content.length < 500 
          ? "paragraph" 
          : "turn";

      // Get block keywords for global meta-tags
      const fullBlock = await ctx.runQuery(internal.bridgeBlocks.get, {
        blockId: memory.blockId,
      });

      enrichedResults.push({
        memoryId: memory._id,
        content: memory.content,
        score: result._score,
        turnId: memory.turnId,
        blockId: memory.blockId,
        topicLabel: block.topicLabel,
        dayId: block.dayId,
        chunkType,
        keywords: fullBlock?.keywords ?? [],
      });

      if (enrichedResults.length >= topK) break;
    }

    // Sort by score descending
    enrichedResults.sort((a, b) => b.score - a.score);

    return enrichedResults;
  },
});

/**
 * Hybrid search combining vector + lexical matching
 * Python: hybrid_search.py HybridSearchEngine.search()
 */
export const hybridSearch = action({
  args: {
    embedding: v.array(v.float64()),
    queryKeywords: v.array(v.string()),
    currentDayId: v.string(),
    topK: v.optional(v.number()),
    vectorWeight: v.optional(v.number()),
    lexicalWeight: v.optional(v.number()),
  },
  returns: v.array(v.object({
    memoryId: v.string(),
    content: v.string(),
    vectorScore: v.number(),
    lexicalScore: v.number(),
    combinedScore: v.number(),
    turnId: v.string(),
    blockId: v.string(),
    matchedKeywords: v.array(v.string()),
  })),
  handler: async (ctx, args) => {
    const topK = args.topK ?? 10;
    const vectorWeight = args.vectorWeight ?? 0.7;
    const lexicalWeight = args.lexicalWeight ?? 0.3;

    // Get vector search results
    const vectorResults = await ctx.vectorSearch("memories", "by_embedding", {
      vector: args.embedding,
      limit: topK * 3,
    });

    // Score and rank with hybrid approach
    const scoredResults = [];

    for (const result of vectorResults) {
      const memory = await ctx.runQuery(internal.memories.getById, {
        id: result._id,
      });

      if (!memory) continue;

      // Get block to check day
      const block = await ctx.runQuery(internal.memories.getBlockById, {
        blockId: memory.blockId,
      });

      if (!block || block.dayId === args.currentDayId) continue;

      // Calculate lexical score
      const contentLower = memory.content.toLowerCase();
      const matchedKeywords = args.queryKeywords.filter(
        (kw) => contentLower.includes(kw.toLowerCase())
      );
      const lexicalScore = args.queryKeywords.length > 0
        ? matchedKeywords.length / args.queryKeywords.length
        : 0;

      // Combined score
      const combinedScore = 
        (result._score * vectorWeight) + 
        (lexicalScore * lexicalWeight);

      scoredResults.push({
        memoryId: memory._id,
        content: memory.content,
        vectorScore: result._score,
        lexicalScore,
        combinedScore,
        turnId: memory.turnId,
        blockId: memory.blockId,
        matchedKeywords,
      });
    }

    // Sort by combined score and take top K
    scoredResults.sort((a, b) => b.combinedScore - a.combinedScore);
    return scoredResults.slice(0, topK);
  },
});
