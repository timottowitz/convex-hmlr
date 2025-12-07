/**
 * Context Hydrator - Builds LLM prompts from retrieved context
 *
 * Ported from Python: memory/retrieval/context_hydrator.py
 *
 * Responsibilities:
 * - Combines sliding window + retrieved memories + facts
 * - Manages token budgets
 * - Prioritizes context (tasks > recent > historical)
 * - Formats for LLM injection
 */

import { v } from "convex/values";
import { query, mutation } from "../_generated/server";

// ============================================================================
// Types
// ============================================================================

export interface HydratorConfig {
  maxTokens: number;
  systemTokens: number;
  taskTokens: number;
}

export interface HydratedContext {
  systemPrompt: string;
  conversationContext: string;
  retrievedMemories: string;
  facts: string;
  userProfile: string;
  totalTokens: number;
  tokenBreakdown: {
    system: number;
    conversation: number;
    memories: number;
    facts: number;
    profile: number;
  };
}

export interface Turn {
  turnId: string;
  userMessage: string;
  aiResponse: string;
  timestamp: number;
  keywords?: string[];
  affect?: string;
}

export interface Memory {
  content: string;
  score: number;
  turnId: string;
  blockId: string;
}

export interface Fact {
  key: string;
  value: string;
  category?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: HydratorConfig = {
  maxTokens: 8000,
  systemTokens: 500,
  taskTokens: 500,
};

// Priority-based allocation percentages
// Python: context_hydrator.py lines 50-80
const TOKEN_ALLOCATION = {
  SYSTEM: 0.06,        // 6% - System prompt (fixed)
  TASKS: 0.06,         // 6% - Active tasks (high priority)
  BRIDGE_BLOCK: 0.50,  // 50% - Current topic turns (essential context)
  MEMORIES: 0.25,      // 25% - Retrieved historical memories
  FACTS: 0.08,         // 8% - Exact fact matches
  PROFILE: 0.05,       // 5% - User profile summary
};

/**
 * Calculate token budget allocation with priority-based distribution
 * Python: context_hydrator.py ContextHydrator.__init__()
 * 
 * Priority order:
 * 1. System prompt (always included, fixed budget)
 * 2. Active tasks (highest priority - user's current work)
 * 3. Bridge Block turns (recent conversation - essential context)
 * 4. Retrieved memories (relevant history - fills remaining budget)
 * 5. Facts (exact matches from fact_store)
 * 6. User profile (preferences and patterns)
 */
export function allocateTokenBudget(
  maxTokens: number = 8000,
  systemTokens: number = 500,
  taskTokens: number = 500
): {
  system: number;
  tasks: number;
  bridgeBlock: number;
  memories: number;
  facts: number;
  profile: number;
  total: number;
} {
  // Fixed allocations first
  const remainingAfterFixed = maxTokens - systemTokens - taskTokens;
  
  // Proportional allocation for remaining budget
  const bridgeBlock = Math.floor(remainingAfterFixed * 0.50);
  const memories = Math.floor(remainingAfterFixed * 0.30);
  const facts = Math.floor(remainingAfterFixed * 0.10);
  const profile = Math.floor(remainingAfterFixed * 0.10);

  return {
    system: systemTokens,
    tasks: taskTokens,
    bridgeBlock,
    memories,
    facts,
    profile,
    total: systemTokens + taskTokens + bridgeBlock + memories + facts + profile,
  };
}

/**
 * Dynamically reallocate unused budget
 * If one category uses less than allocated, redistribute to others
 * Python: context_hydrator.py - implicit in the cascading logic
 */
export function reallocateUnusedBudget(
  allocation: ReturnType<typeof allocateTokenBudget>,
  used: {
    system: number;
    tasks: number;
    bridgeBlock: number;
    memories: number;
    facts: number;
    profile: number;
  }
): {
  bridgeBlock: number;
  memories: number;
  facts: number;
  profile: number;
} {
  // Calculate unused from fixed allocations
  const unusedSystem = Math.max(0, allocation.system - used.system);
  const unusedTasks = Math.max(0, allocation.tasks - used.tasks);
  const unusedFixed = unusedSystem + unusedTasks;

  // Distribute to variable allocations (proportionally)
  const variableTotal = allocation.bridgeBlock + allocation.memories + allocation.facts + allocation.profile;
  
  return {
    bridgeBlock: allocation.bridgeBlock + Math.floor(unusedFixed * (allocation.bridgeBlock / variableTotal)),
    memories: allocation.memories + Math.floor(unusedFixed * (allocation.memories / variableTotal)),
    facts: allocation.facts + Math.floor(unusedFixed * (allocation.facts / variableTotal)),
    profile: allocation.profile + Math.floor(unusedFixed * (allocation.profile / variableTotal)),
  };
}

// ============================================================================
// Helper Functions (exported for client use)
// ============================================================================

export function estimateTokens(text: string): number {
  // Rough estimation: ~4 characters per token
  return Math.ceil(text.length / 4);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const estimatedChars = maxTokens * 4;
  if (text.length <= estimatedChars) {
    return text;
  }
  return text.slice(0, estimatedChars - 3) + "...";
}

export function formatTurn(turn: Turn): string {
  const timestamp = new Date(turn.timestamp).toISOString();
  return `[${timestamp}]\nUser: ${turn.userMessage}\nAssistant: ${turn.aiResponse}`;
}

export function formatMemory(memory: Memory, index: number): string {
  return `[Memory ${index + 1}] (relevance: ${(memory.score * 100).toFixed(0)}%)\n${memory.content}`;
}

export function formatFact(fact: Fact): string {
  const category = fact.category ? ` [${fact.category}]` : "";
  return `${fact.key}${category}: ${fact.value}`;
}

// ============================================================================
// Core Hydration Logic
// ============================================================================

export function hydrateBridgeBlock(args: {
  blockTurns: Turn[];
  memories: Memory[];
  facts: Fact[];
  userProfile?: string;
  systemPrompt?: string;
  config?: Partial<HydratorConfig>;
}): HydratedContext {
  const config = { ...DEFAULT_CONFIG, ...args.config };
  const conversationBudget = config.maxTokens - config.systemTokens - config.taskTokens;

  // Build components
  const systemPrompt = args.systemPrompt || getDefaultSystemPrompt();
  const systemTokens = estimateTokens(systemPrompt);

  // Format conversation turns (most recent first, then reverse for chronological)
  const sortedTurns = [...args.blockTurns].sort((a, b) => b.timestamp - a.timestamp);
  let conversationParts: string[] = [];
  let conversationTokens = 0;
  const turnBudget = Math.floor(conversationBudget * 0.5); // 50% for turns

  for (const turn of sortedTurns) {
    const formatted = formatTurn(turn);
    const tokens = estimateTokens(formatted);
    if (conversationTokens + tokens <= turnBudget) {
      conversationParts.push(formatted);
      conversationTokens += tokens;
    } else {
      break;
    }
  }

  // Reverse to get chronological order
  conversationParts.reverse();
  const conversationContext = conversationParts.length > 0
    ? "=== Recent Conversation ===\n" + conversationParts.join("\n\n")
    : "";

  // Format retrieved memories
  const memoryBudget = Math.floor(conversationBudget * 0.3); // 30% for memories
  let memoryParts: string[] = [];
  let memoryTokens = 0;

  // Sort by score descending
  const sortedMemories = [...args.memories].sort((a, b) => b.score - a.score);

  for (let i = 0; i < sortedMemories.length; i++) {
    const formatted = formatMemory(sortedMemories[i], i);
    const tokens = estimateTokens(formatted);
    if (memoryTokens + tokens <= memoryBudget) {
      memoryParts.push(formatted);
      memoryTokens += tokens;
    } else {
      break;
    }
  }

  const retrievedMemories = memoryParts.length > 0
    ? "=== Relevant History ===\n" + memoryParts.join("\n\n")
    : "";

  // Format facts
  const factBudget = Math.floor(conversationBudget * 0.1); // 10% for facts
  let factParts: string[] = [];
  let factTokens = 0;

  for (const fact of args.facts) {
    const formatted = formatFact(fact);
    const tokens = estimateTokens(formatted);
    if (factTokens + tokens <= factBudget) {
      factParts.push(formatted);
      factTokens += tokens;
    } else {
      break;
    }
  }

  const factsSection = factParts.length > 0
    ? "=== Known Facts ===\n" + factParts.join("\n")
    : "";

  // User profile
  const profileBudget = Math.floor(conversationBudget * 0.1); // 10% for profile
  const userProfile = args.userProfile
    ? truncateToTokens("=== User Profile ===\n" + args.userProfile, profileBudget)
    : "";
  const profileTokens = estimateTokens(userProfile);

  return {
    systemPrompt,
    conversationContext,
    retrievedMemories,
    facts: factsSection,
    userProfile,
    totalTokens: systemTokens + conversationTokens + memoryTokens + factTokens + profileTokens,
    tokenBreakdown: {
      system: systemTokens,
      conversation: conversationTokens,
      memories: memoryTokens,
      facts: factTokens,
      profile: profileTokens,
    },
  };
}

export function buildPrompt(context: HydratedContext, userMessage: string): string {
  const parts: string[] = [];

  if (context.userProfile) {
    parts.push(context.userProfile);
  }

  if (context.facts) {
    parts.push(context.facts);
  }

  if (context.conversationContext) {
    parts.push(context.conversationContext);
  }

  if (context.retrievedMemories) {
    parts.push(context.retrievedMemories);
  }

  parts.push(`=== Current Message ===\nUser: ${userMessage}`);

  return parts.join("\n\n");
}

function getDefaultSystemPrompt(): string {
  return `You are a helpful AI assistant with access to conversation history and facts about the user.

Guidelines:
- Use the provided context to give personalized, relevant responses
- Reference past conversations when appropriate
- Be concise but thorough
- If you remember something from a previous conversation, mention it naturally`;
}

// ============================================================================
// Convex Queries
// ============================================================================

export const hydrateContext = query({
  args: {
    blockId: v.id("bridgeBlocks"),
    memoryIds: v.array(v.string()),
    factKeys: v.array(v.string()),
    maxTokens: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const maxTokens = args.maxTokens ?? 8000;

    // Get block turns
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_block", (q) => q.eq("blockId", args.blockId))
      .order("desc")
      .take(20);

    // Get memories by turnId
    const memories: Memory[] = [];
    for (const memId of args.memoryIds.slice(0, 10)) {
      const mem = await ctx.db
        .query("memories")
        .withIndex("by_turn", (q) => q.eq("turnId", memId))
        .first();
      if (mem) {
        memories.push({
          content: mem.content,
          score: 0.8, // Default score when not from vector search
          turnId: mem.turnId,
          blockId: mem.blockId as string,
        });
      }
    }

    // Get facts by key
    const facts: Fact[] = [];
    for (const key of args.factKeys.slice(0, 20)) {
      const fact = await ctx.db
        .query("facts")
        .withIndex("by_key", (q) => q.eq("key", key))
        .first();
      if (fact) {
        facts.push({
          key: fact.key,
          value: fact.value,
          category: fact.category,
        });
      }
    }

    // Get user profile context
    const profileItems = await ctx.db.query("userProfile").take(10);
    const userProfile = profileItems.map((p) => `${p.key}: ${p.value}`).join("\n");

    // Hydrate
    const formattedTurns: Turn[] = turns.map((t) => ({
      turnId: t.turnId,
      userMessage: t.userMessage,
      aiResponse: t.aiResponse,
      timestamp: t.timestamp,
      keywords: t.keywords,
      affect: t.affect,
    }));

    const result = hydrateBridgeBlock({
      blockTurns: formattedTurns,
      memories,
      facts,
      userProfile,
      config: { maxTokens },
    });

    return {
      prompt: buildPrompt(result, ""),
      tokenBreakdown: result.tokenBreakdown,
      totalTokens: result.totalTokens,
    };
  },
});

export const getTokenStats = query({
  args: { blockId: v.id("bridgeBlocks") },
  handler: async (ctx, args) => {
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_block", (q) => q.eq("blockId", args.blockId))
      .collect();

    let totalChars = 0;
    for (const turn of turns) {
      totalChars += turn.userMessage.length + turn.aiResponse.length;
    }

    return {
      turnCount: turns.length,
      totalCharacters: totalChars,
      estimatedTokens: Math.ceil(totalChars / 4),
    };
  },
});
