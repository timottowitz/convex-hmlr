import { v } from "convex/values";
import { action } from "./_generated/server.js";
import { internal } from "./_generated/api.js";

/**
 * The Governor - HMLR's Routing and Filtering Brain
 *
 * Implements the Phase 11.9.A architecture with 3 parallel tasks:
 * 1. Bridge Block routing (LLM-based topic matching)
 * 2. Memory retrieval + 2-key filtering (Vector + LLM)
 * 3. Fact store lookup (exact key matching)
 *
 * The Governor decides:
 * - Which Bridge Block should handle this query (existing or new)
 * - Which memories are truly relevant (killing false positives)
 * - What facts should be included in context
 */

// ============================================================================
// Types
// ============================================================================

const routingDecisionValidator = v.object({
  matchedBlockId: v.union(v.null(), v.string()),
  isNewTopic: v.boolean(),
  reasoning: v.string(),
  suggestedLabel: v.optional(v.string()),
});

const memoryResultValidator = v.object({
  memoryId: v.string(),
  content: v.string(),
  score: v.number(),
  turnId: v.string(),
  blockId: v.string(),
});

const factResultValidator = v.object({
  key: v.string(),
  value: v.string(),
  category: v.optional(v.string()),
});

// ============================================================================
// Main Governor Action
// ============================================================================

/**
 * Run the Governor's 3 parallel tasks
 *
 * This is the main entry point for the Governor.
 * It runs routing, memory retrieval, and fact lookup in parallel.
 */
export const govern = action({
  args: {
    query: v.string(),
    queryEmbedding: v.array(v.float64()),
    dayId: v.string(),
    // LLM API configuration (passed from app layer)
    openaiApiKey: v.string(),
    governorModel: v.optional(v.string()),
  },
  returns: v.object({
    routing: routingDecisionValidator,
    memories: v.array(memoryResultValidator),
    facts: v.array(factResultValidator),
  }),
  handler: async (ctx, args) => {
    const model = args.governorModel ?? "gpt-4o-mini";

    // Run all 3 tasks in parallel
    const [routing, memories, facts] = await Promise.all([
      routeToBridgeBlock(ctx, args.query, args.dayId, args.openaiApiKey, model),
      retrieveAndFilterMemories(ctx, args.query, args.queryEmbedding, args.openaiApiKey, model),
      lookupFacts(ctx, args.query),
    ]);

    return { routing, memories, facts };
  },
});

// ============================================================================
// Task 1: Bridge Block Routing
// ============================================================================

/**
 * Route query to appropriate Bridge Block using LLM
 */
async function routeToBridgeBlock(
  ctx: any,
  query: string,
  dayId: string,
  openaiApiKey: string,
  model: string
): Promise<{
  matchedBlockId: string | null;
  isNewTopic: boolean;
  reasoning: string;
  suggestedLabel?: string;
}> {
  // Get metadata for all blocks today
  const metadata = await ctx.runQuery(internal.bridgeBlocks.getMetadataByDay, { dayId });

  if (metadata.length === 0) {
    // No blocks exist - this is the first query of the day
    return {
      matchedBlockId: null,
      isNewTopic: true,
      reasoning: "first_query_of_day",
      suggestedLabel: "Initial Conversation",
    };
  }

  // Build routing prompt
  const blocksText = metadata
    .map((m: any, i: number) => {
      const marker = m.isLastActive ? " (LAST ACTIVE)" : "";
      return `${i + 1}. [${m.topicLabel}]${marker} (${m.status})
   ID: ${m.blockId}
   Summary: ${m.summary?.slice(0, 150) ?? "No summary"}...
   Keywords: ${m.keywords.slice(0, 5).join(", ")}
   Turn Count: ${m.turnCount}`;
    })
    .join("\n\n");

  const routingPrompt = `You are an intelligent topic routing assistant for a conversational memory system.

PREVIOUS TOPICS TODAY:
${blocksText}

USER QUERY: "${query}"

YOUR TASK:
Analyze the user's query and determine which topic block it belongs to.

You have 3 possible decisions:
1. **Continue LAST ACTIVE topic** - Query relates to the ongoing conversation
2. **Resume PAUSED topic** - Query clearly relates to a previous topic
3. **Start NEW topic** - Query is genuinely about something new/different

DECISION PRINCIPLES:
- Focus on SEMANTIC CONTEXT, not just keywords
- Subtopic exploration within a domain = SAME topic (e.g., Docker → Docker Compose)
- Only create new topic for COMPLETELY DIFFERENT domains
- When in doubt, prefer CONTINUATION over creating new topics

Return JSON:
{
    "matchedBlockId": "<block_id>" or null,
    "isNewTopic": true/false,
    "reasoning": "<explanation>",
    "suggestedLabel": "<label if new topic>"
}`;

  try {
    const response = await callOpenAI(openaiApiKey, model, routingPrompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const decision = JSON.parse(jsonMatch[0]);
      if ("matchedBlockId" in decision && "isNewTopic" in decision) {
        return {
          matchedBlockId: decision.matchedBlockId,
          isNewTopic: decision.isNewTopic,
          reasoning: decision.reasoning ?? "",
          suggestedLabel: decision.suggestedLabel,
        };
      }
    }

    // Fallback: default to last active block
    const lastActive = metadata.find((m: any) => m.isLastActive) ?? metadata[0];
    return {
      matchedBlockId: lastActive.blockId,
      isNewTopic: false,
      reasoning: "routing_parse_failed_defaulted_to_last_active",
    };
  } catch (error) {
    // Error fallback
    const lastActive = metadata.find((m: any) => m.isLastActive) ?? metadata[0];
    return {
      matchedBlockId: lastActive?.blockId ?? null,
      isNewTopic: !lastActive,
      reasoning: `routing_error: ${error}`,
    };
  }
}

// ============================================================================
// Task 2: Memory Retrieval + 2-Key Filtering
// ============================================================================

/**
 * Retrieve memories via vector search and filter with LLM
 */
async function retrieveAndFilterMemories(
  ctx: any,
  query: string,
  queryEmbedding: number[],
  openaiApiKey: string,
  model: string
): Promise<
  Array<{
    memoryId: string;
    content: string;
    score: number;
    turnId: string;
    blockId: string;
  }>
> {
  // Step 1: Vector search to get candidates
  const candidates = await ctx.runAction(internal.memories.search, {
    embedding: queryEmbedding,
    limit: 20,
  });

  if (candidates.length === 0) {
    return [];
  }

  // Step 2: 2-key filtering with LLM
  const candidatesText = candidates
    .map((c: any, i: number) => {
      return `[${i}] Similarity: ${c.score.toFixed(2)}
   Content: ${c.content.slice(0, 300)}...`;
    })
    .join("\n\n");

  const filterPrompt = `You are a memory filter using 2-key validation.

CURRENT QUERY: "${query}"

MEMORY CANDIDATES:
${candidatesText}

TASK: Select ONLY memories that are truly relevant to the current query.

IMPORTANT: High similarity does NOT guarantee relevance!
Example:
- "I love Python" vs "I hate Python" = 95% similarity but OPPOSITE meaning
- Use BOTH semantic similarity AND actual content meaning

Return JSON:
{
    "relevantIndices": [0, 2, 5],
    "reasoning": "<brief explanation>"
}`;

  try {
    const response = await callOpenAI(openaiApiKey, model, filterPrompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      const relevantIndices = data.relevantIndices ?? [];

      return relevantIndices
        .filter((idx: number) => idx >= 0 && idx < candidates.length)
        .map((idx: number) => candidates[idx]);
    }

    // Fallback: return top 5 by score
    return candidates.slice(0, 5);
  } catch (error) {
    // Error fallback: return top 5 by score
    return candidates.slice(0, 5);
  }
}

// ============================================================================
// Task 3: Fact Store Lookup
// ============================================================================

/**
 * Look up facts that might be relevant to the query
 */
async function lookupFacts(
  ctx: any,
  query: string
): Promise<
  Array<{
    key: string;
    value: string;
    category?: string;
  }>
> {
  // Extract potential fact keys from query
  // Look for capitalized words, quoted strings, and common patterns
  const words = query.match(/\b[A-Z][A-Z0-9_]+\b|\b\w+\b/g) ?? [];
  const uniqueWords = [...new Set(words)].slice(0, 10);

  const facts: Array<{ key: string; value: string; category?: string }> = [];

  for (const word of uniqueWords) {
    const fact = await ctx.runQuery(internal.facts.get, { key: word });
    if (fact && fact.value !== "[DELETED]") {
      facts.push({
        key: fact.key,
        value: fact.value,
        category: fact.category ?? undefined,
      });
    }
  }

  return facts;
}

// ============================================================================
// OpenAI Helper
// ============================================================================

/**
 * Call OpenAI API for LLM completions
 */
async function callOpenAI(
  apiKey: string,
  model: string,
  prompt: string
): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You are a precise assistant that always responds with valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 1000,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content ?? "";
}

// ============================================================================
// Standalone Routing Action (for testing/direct use)
// ============================================================================

/**
 * Route a query to a Bridge Block (standalone action)
 */
export const route = action({
  args: {
    query: v.string(),
    dayId: v.string(),
    openaiApiKey: v.string(),
    model: v.optional(v.string()),
  },
  returns: routingDecisionValidator,
  handler: async (ctx, args) => {
    return await routeToBridgeBlock(
      ctx,
      args.query,
      args.dayId,
      args.openaiApiKey,
      args.model ?? "gpt-4o-mini"
    );
  },
});

/**
 * Filter memories by relevance (standalone action)
 */
export const filterMemories = action({
  args: {
    query: v.string(),
    queryEmbedding: v.array(v.float64()),
    openaiApiKey: v.string(),
    model: v.optional(v.string()),
  },
  returns: v.array(memoryResultValidator),
  handler: async (ctx, args) => {
    return await retrieveAndFilterMemories(
      ctx,
      args.query,
      args.queryEmbedding,
      args.openaiApiKey,
      args.model ?? "gpt-4o-mini"
    );
  },
});
