import { v } from "convex/values";
import { mutation, query, internalAction } from "./_generated/server.js";
import { Doc, Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";

/**
 * Bridge Blocks - Topic-based conversation containers
 *
 * These functions manage the lifecycle of Bridge Blocks:
 * - Create new blocks when topics shift
 * - Update block metadata (summary, keywords, status)
 * - Append turns to blocks
 * - Query blocks by day, status, or recency
 */

// ============================================================================
// Queries
// ============================================================================

/**
 * Get a single Bridge Block by ID
 */
export const get = query({
  args: { blockId: v.id("bridgeBlocks") },
  returns: v.union(v.null(), v.object({
    _id: v.id("bridgeBlocks"),
    _creationTime: v.number(),
    dayId: v.string(),
    topicLabel: v.string(),
    summary: v.optional(v.string()),
    keywords: v.array(v.string()),
    status: v.union(v.literal("ACTIVE"), v.literal("PAUSED"), v.literal("CLOSED")),
    prevBlockId: v.optional(v.id("bridgeBlocks")),
    openLoops: v.array(v.string()),
    decisionsMade: v.array(v.string()),
    turnCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.blockId);
  },
});

/**
 * Get all Bridge Blocks for a specific day
 */
export const getByDay = query({
  args: { dayId: v.string() },
  returns: v.array(v.object({
    _id: v.id("bridgeBlocks"),
    _creationTime: v.number(),
    dayId: v.string(),
    topicLabel: v.string(),
    summary: v.optional(v.string()),
    keywords: v.array(v.string()),
    status: v.union(v.literal("ACTIVE"), v.literal("PAUSED"), v.literal("CLOSED")),
    prevBlockId: v.optional(v.id("bridgeBlocks")),
    openLoops: v.array(v.string()),
    decisionsMade: v.array(v.string()),
    turnCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bridgeBlocks")
      .withIndex("by_day", (q) => q.eq("dayId", args.dayId))
      .collect();
  },
});

/**
 * Get the currently active Bridge Block(s) for a day
 * Python: active_blocks = self.storage.get_active_bridge_blocks()
 */
export const getActive = query({
  args: { dayId: v.optional(v.string()) },
  returns: v.array(v.object({
    _id: v.id("bridgeBlocks"),
    _creationTime: v.number(),
    dayId: v.string(),
    topicLabel: v.string(),
    summary: v.optional(v.string()),
    keywords: v.array(v.string()),
    status: v.union(v.literal("ACTIVE"), v.literal("PAUSED"), v.literal("CLOSED")),
    prevBlockId: v.optional(v.id("bridgeBlocks")),
    openLoops: v.array(v.string()),
    decisionsMade: v.array(v.string()),
    turnCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })),
  handler: async (ctx, args) => {
    let query = ctx.db
      .query("bridgeBlocks")
      .withIndex("by_status", (q) => q.eq("status", "ACTIVE"));

    const blocks = await query.collect();

    // Filter by dayId if provided
    if (args.dayId) {
      return blocks.filter((b) => b.dayId === args.dayId);
    }

    return blocks;
  },
});

/**
 * Get metadata for all blocks on a day (for Governor routing)
 * Returns lightweight metadata without full content
 */
export const getMetadataByDay = query({
  args: { dayId: v.string() },
  returns: v.array(v.object({
    blockId: v.string(),
    topicLabel: v.string(),
    summary: v.optional(v.string()),
    keywords: v.array(v.string()),
    status: v.union(v.literal("ACTIVE"), v.literal("PAUSED"), v.literal("CLOSED")),
    openLoops: v.array(v.string()),
    decisionsMade: v.array(v.string()),
    turnCount: v.number(),
    updatedAt: v.number(),
    isLastActive: v.boolean(),
  })),
  handler: async (ctx, args) => {
    const blocks = await ctx.db
      .query("bridgeBlocks")
      .withIndex("by_day", (q) => q.eq("dayId", args.dayId))
      .collect();

    // Find the most recently updated block
    const lastActive = blocks.reduce((latest, block) => {
      if (!latest || block.updatedAt > latest.updatedAt) {
        return block;
      }
      return latest;
    }, null as Doc<"bridgeBlocks"> | null);

    return blocks.map((block) => ({
      blockId: block._id,
      topicLabel: block.topicLabel,
      summary: block.summary,
      keywords: block.keywords,
      status: block.status,
      openLoops: block.openLoops,
      decisionsMade: block.decisionsMade,
      turnCount: block.turnCount,
      updatedAt: block.updatedAt,
      isLastActive: block._id === lastActive?._id,
    }));
  },
});

/**
 * Get aggregated keywords for a day
 * Python: storage.get_day_keywords(day_id)
 */
export const getDayKeywords = query({
  args: { dayId: v.string() },
  returns: v.array(v.object({
    keyword: v.string(),
    frequency: v.number(),
    blocks: v.array(v.string()),
  })),
  handler: async (ctx, args) => {
    const blocks = await ctx.db
      .query("bridgeBlocks")
      .withIndex("by_day", (q) => q.eq("dayId", args.dayId))
      .collect();

    // Aggregate keywords across all blocks
    const keywordMap = new Map<string, { frequency: number; blocks: string[] }>();

    for (const block of blocks) {
      for (const keyword of block.keywords) {
        const normalized = keyword.toLowerCase();
        const existing = keywordMap.get(normalized);
        if (existing) {
          existing.frequency++;
          if (!existing.blocks.includes(block._id)) {
            existing.blocks.push(block._id);
          }
        } else {
          keywordMap.set(normalized, { frequency: 1, blocks: [block._id] });
        }
      }
    }

    return Array.from(keywordMap.entries())
      .map(([keyword, data]) => ({
        keyword,
        frequency: data.frequency,
        blocks: data.blocks,
      }))
      .sort((a, b) => b.frequency - a.frequency);
  },
});

/**
 * Get aggregated affect patterns for a day
 * Python: storage.get_day_affect(day_id)
 */
export const getDayAffect = query({
  args: { dayId: v.string() },
  returns: v.array(v.object({
    affect: v.string(),
    count: v.number(),
    percentage: v.number(),
  })),
  handler: async (ctx, args) => {
    const blocks = await ctx.db
      .query("bridgeBlocks")
      .withIndex("by_day", (q) => q.eq("dayId", args.dayId))
      .collect();

    // Get all turns for these blocks
    const affectCounts = new Map<string, number>();
    let totalTurns = 0;

    for (const block of blocks) {
      const turns = await ctx.db
        .query("turns")
        .withIndex("by_block", (q) => q.eq("blockId", block._id))
        .collect();

      for (const turn of turns) {
        const affect = turn.affect ?? "neutral";
        affectCounts.set(affect, (affectCounts.get(affect) ?? 0) + 1);
        totalTurns++;
      }
    }

    return Array.from(affectCounts.entries())
      .map(([affect, count]) => ({
        affect,
        count,
        percentage: totalTurns > 0 ? Math.round((count / totalTurns) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);
  },
});

/**
 * Get turns by span ID (for legacy compatibility)
 * Python: storage.get_turns_by_span(span_id)
 * Note: In TypeScript, spans are merged into blocks, so this queries by block
 */
export const getTurnsBySpan = query({
  args: { blockId: v.id("bridgeBlocks") },
  returns: v.array(v.object({
    turnId: v.string(),
    userMessage: v.string(),
    aiResponse: v.string(),
    keywords: v.optional(v.array(v.string())),
    affect: v.optional(v.string()),
    timestamp: v.number(),
  })),
  handler: async (ctx, args) => {
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_block", (q) => q.eq("blockId", args.blockId))
      .order("asc")
      .collect();

    return turns.map((t) => ({
      turnId: t.turnId,
      userMessage: t.userMessage,
      aiResponse: t.aiResponse,
      keywords: t.keywords,
      affect: t.affect,
      timestamp: t.timestamp,
    }));
  },
});

/**
 * Get all turns for a Bridge Block
 */
export const getTurns = query({
  args: { blockId: v.id("bridgeBlocks") },
  returns: v.array(v.object({
    _id: v.id("turns"),
    _creationTime: v.number(),
    blockId: v.id("bridgeBlocks"),
    turnId: v.string(),
    userMessage: v.string(),
    aiResponse: v.string(),
    keywords: v.optional(v.array(v.string())),
    affect: v.optional(v.string()),
    timestamp: v.number(),
  })),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("turns")
      .withIndex("by_block", (q) => q.eq("blockId", args.blockId))
      .collect();
  },
});

// ============================================================================
// Mutations
// ============================================================================

/**
 * Create a new Bridge Block
 */
export const create = mutation({
  args: {
    dayId: v.string(),
    topicLabel: v.string(),
    keywords: v.array(v.string()),
    prevBlockId: v.optional(v.id("bridgeBlocks")),
  },
  returns: v.id("bridgeBlocks"),
  handler: async (ctx, args) => {
    const now = Date.now();

    // Pause any currently active blocks
    const activeBlocks = await ctx.db
      .query("bridgeBlocks")
      .withIndex("by_status", (q) => q.eq("status", "ACTIVE"))
      .collect();

    for (const block of activeBlocks) {
      await ctx.db.patch(block._id, {
        status: "PAUSED",
        updatedAt: now,
      });
    }

    // Create new active block
    const blockId = await ctx.db.insert("bridgeBlocks", {
      dayId: args.dayId,
      topicLabel: args.topicLabel,
      keywords: args.keywords,
      status: "ACTIVE",
      prevBlockId: args.prevBlockId,
      openLoops: [],
      decisionsMade: [],
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    return blockId;
  },
});

/**
 * Update Bridge Block status
 */
export const updateStatus = mutation({
  args: {
    blockId: v.id("bridgeBlocks"),
    status: v.union(v.literal("ACTIVE"), v.literal("PAUSED"), v.literal("CLOSED")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();

    // If activating this block, pause all others
    if (args.status === "ACTIVE") {
      const activeBlocks = await ctx.db
        .query("bridgeBlocks")
        .withIndex("by_status", (q) => q.eq("status", "ACTIVE"))
        .collect();

      for (const block of activeBlocks) {
        if (block._id !== args.blockId) {
          await ctx.db.patch(block._id, {
            status: "PAUSED",
            updatedAt: now,
          });
        }
      }
    }

    await ctx.db.patch(args.blockId, {
      status: args.status,
      updatedAt: now,
    });

    return null;
  },
});

/**
 * Update Bridge Block metadata (summary, keywords, etc.)
 */
export const updateMetadata = mutation({
  args: {
    blockId: v.id("bridgeBlocks"),
    summary: v.optional(v.string()),
    keywords: v.optional(v.array(v.string())),
    openLoops: v.optional(v.array(v.string())),
    decisionsMade: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const updates: Partial<Doc<"bridgeBlocks">> = {
      updatedAt: Date.now(),
    };

    if (args.summary !== undefined) updates.summary = args.summary;
    if (args.keywords !== undefined) updates.keywords = args.keywords;
    if (args.openLoops !== undefined) updates.openLoops = args.openLoops;
    if (args.decisionsMade !== undefined) updates.decisionsMade = args.decisionsMade;

    await ctx.db.patch(args.blockId, updates);
    return null;
  },
});

/**
 * Append a turn to a Bridge Block
 * Python: self.storage.append_turn_to_block(block_id, turn_data)
 */
export const appendTurn = mutation({
  args: {
    blockId: v.id("bridgeBlocks"),
    turnId: v.optional(v.string()), // Can be pre-generated for chunking linkage
    userMessage: v.string(),
    aiResponse: v.string(),
    keywords: v.optional(v.array(v.string())),
    affect: v.optional(v.string()),
  },
  returns: v.string(), // Returns turnId
  handler: async (ctx, args) => {
    const now = Date.now();
    const turnId = args.turnId ?? `turn_${now}`;

    // Insert the turn
    await ctx.db.insert("turns", {
      blockId: args.blockId,
      turnId,
      userMessage: args.userMessage,
      aiResponse: args.aiResponse,
      keywords: args.keywords,
      affect: args.affect,
      timestamp: now,
    });

    // Update block turn count and timestamp
    const block = await ctx.db.get(args.blockId);
    if (block) {
      await ctx.db.patch(args.blockId, {
        turnCount: block.turnCount + 1,
        updatedAt: now,
      });
    }

    return turnId;
  },
});

/**
 * Pause a block and generate summary
 * Python: self.storage.update_bridge_block_status(old_active_id, 'PAUSED')
 *         self.storage.generate_block_summary(old_active_id)
 */
export const pauseWithSummary = mutation({
  args: {
    blockId: v.id("bridgeBlocks"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const block = await ctx.db.get(args.blockId);

    if (!block) {
      return null;
    }

    // Get all turns for this block to generate summary
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_block", (q) => q.eq("blockId", args.blockId))
      .collect();

    // Generate a simple summary from the turns
    let summary = block.summary;
    if (!summary && turns.length > 0) {
      // Create summary from first and last messages
      const firstTurn = turns[0];
      const lastTurn = turns[turns.length - 1];

      if (turns.length === 1) {
        summary = `Discussion about: ${firstTurn.userMessage.slice(0, 100)}...`;
      } else {
        summary = `${turns.length} exchanges. Started with: "${firstTurn.userMessage.slice(0, 50)}..." Ended with: "${lastTurn.userMessage.slice(0, 50)}..."`;
      }
    }

    // Update block status and summary
    await ctx.db.patch(args.blockId, {
      status: "PAUSED",
      summary: summary ?? `Block with ${block.turnCount} turns`,
      updatedAt: now,
    });

    return null;
  },
});

/**
 * Update block metadata from LLM response
 * Python: self.storage.update_bridge_block_metadata(block_id, metadata_json)
 */
export const updateMetadataFromResponse = mutation({
  args: {
    blockId: v.id("bridgeBlocks"),
    metadata: v.object({
      affect: v.optional(v.string()),
      topics: v.optional(v.array(v.string())),
      keywords: v.optional(v.array(v.string())),
      summary: v.optional(v.string()),
      openLoops: v.optional(v.array(v.string())),
      decisionsMade: v.optional(v.array(v.string())),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const block = await ctx.db.get(args.blockId);
    if (!block) return null;

    const updates: Record<string, any> = { updatedAt: Date.now() };

    // Merge keywords
    if (args.metadata.keywords) {
      const existingKeywords = new Set(block.keywords);
      for (const kw of args.metadata.keywords) {
        existingKeywords.add(kw);
      }
      updates.keywords = [...existingKeywords].slice(0, 20);
    }

    // Merge topics into keywords
    if (args.metadata.topics) {
      const allKeywords = new Set(updates.keywords ?? block.keywords);
      for (const topic of args.metadata.topics) {
        allKeywords.add(topic.toLowerCase());
      }
      updates.keywords = [...allKeywords].slice(0, 20);
    }

    // Update summary if provided
    if (args.metadata.summary) {
      updates.summary = args.metadata.summary;
    }

    // Merge open loops
    if (args.metadata.openLoops) {
      const existingLoops = new Set(block.openLoops);
      for (const loop of args.metadata.openLoops) {
        existingLoops.add(loop);
      }
      updates.openLoops = [...existingLoops].slice(0, 10);
    }

    // Merge decisions
    if (args.metadata.decisionsMade) {
      const existingDecisions = new Set(block.decisionsMade);
      for (const decision of args.metadata.decisionsMade) {
        existingDecisions.add(decision);
      }
      updates.decisionsMade = [...existingDecisions].slice(0, 10);
    }

    await ctx.db.patch(args.blockId, updates);
    return null;
  },
});

/**
 * Generate summary for a Bridge Block (called after several turns)
 */
export const generateSummary = mutation({
  args: {
    blockId: v.id("bridgeBlocks"),
    summary: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.blockId, {
      summary: args.summary,
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ============================================================================
// LLM-Based Block Synthesis
// Python: bridge_block_generator.py - _llm_synthesize()
// ============================================================================

/**
 * Generate rich metadata for a Bridge Block using LLM
 * Called when closing/pausing a block to create a comprehensive summary
 * 
 * Python Reference: memory/bridge_block_generator.py lines 120-180
 * - Extracts topic_label, summary, user_affect, bot_persona
 * - Identifies open_loops and decisions_made
 * - Generates keywords for retrieval
 */
export const synthesizeBlockWithLLM = internalAction({
  args: {
    blockId: v.string(),
    openaiApiKey: v.string(),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const model = args.model ?? "gpt-4o-mini";

    // Get block and turns
    const block = await ctx.runQuery(internal.bridgeBlocks.get, {
      blockId: args.blockId as any,
    });

    if (!block) {
      return { success: false, error: "Block not found" };
    }

    const turns = await ctx.runQuery(internal.bridgeBlocks.getTurns, {
      blockId: args.blockId as any,
    });

    if (turns.length === 0) {
      return { success: false, error: "No turns to synthesize" };
    }

    // Build context from turns (limit to last 20 for token budget)
    // Python: bridge_block_generator.py lines 140-145
    const turnTexts = turns.slice(-20).map((t: any) => 
      `User: ${t.userMessage}\nAssistant: ${t.aiResponse}`
    ).join("\n\n");

    // LLM Prompt - matches Python bridge_block_generator.py lines 150-170
    const prompt = `Analyze this conversation and extract a multi-dimensional save state.

Current Topic: ${block.topicLabel}
Number of Turns: ${turns.length}

Conversation:
${turnTexts}

Extract the following in JSON format:
1. topic_label: Concise topic name (2-5 words)
2. summary: Key points discussed (80-150 words)
3. user_affect: User's emotional tone/state (e.g., "Focused, Technical, Cautious")
4. open_loops: Array of unfinished tasks/questions (e.g., ["Implement X", "Test Y"])
5. decisions_made: Array of key decisions (e.g., ["Use SQLite for V1"])
6. keywords: Array of 5-10 keywords for retrieval

Return ONLY valid JSON, no other text.`;

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
              content: "You are a conversation analyzer. Always return valid JSON.",
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 500,
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        return { success: false, error: `OpenAI API error: ${response.status}` };
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content ?? "{}";

      // Parse JSON response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { success: false, error: "No JSON in response" };
      }

      const synthesis = JSON.parse(jsonMatch[0]);

      // Update block with synthesized metadata
      // Python: bridge_block_generator.py lines 95-105
      await ctx.runMutation(internal.bridgeBlocks.updateMetadata, {
        blockId: args.blockId as any,
        summary: synthesis.summary,
        keywords: synthesis.keywords,
        openLoops: synthesis.open_loops,
        decisionsMade: synthesis.decisions_made,
      });

      return {
        success: true,
        synthesis: {
          topicLabel: synthesis.topic_label,
          summary: synthesis.summary,
          affect: synthesis.user_affect,
          openLoops: synthesis.open_loops,
          decisionsMade: synthesis.decisions_made,
          keywords: synthesis.keywords,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});
