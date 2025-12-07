import { v } from "convex/values";
import { action, internalAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";

/**
 * Chat - Main Conversation Handler
 *
 * Ported from Python: core/conversation_engine.py
 *
 * This is the primary entry point for the HMLR system.
 * It orchestrates the full conversation flow exactly as Python does:
 *
 * 1. Generate turn_id immediately (for chunking linkage)
 * 2. Chunk the query (hierarchical: turn → paragraph → sentence)
 * 3. Run the Governor (3 parallel tasks: routing, memory retrieval, fact lookup)
 * 4. Execute 1 of 4 routing scenarios:
 *    - Scenario 1: Topic Continuation (same block)
 *    - Scenario 2: Topic Resumption (reactivate old block, pause current)
 *    - Scenario 3: New Topic Creation (first topic today)
 *    - Scenario 4: Topic Shift (pause current, create new)
 * 5. Wait for fact extraction to complete, link to block
 * 6. Hydrate context (block turns + memories + facts + user profile)
 * 7. Call main LLM
 * 8. Parse metadata JSON from response (if present)
 * 9. Update Bridge Block header with metadata
 * 10. Append turn to Bridge Block
 * 11. Store embedding for vector search
 * 12. Schedule Scribe (background user profile update)
 */

// ============================================================================
// Types
// ============================================================================

const chatResponseValidator = v.object({
  response: v.string(),
  blockId: v.string(),
  turnId: v.string(),
  isNewTopic: v.boolean(),
  topicLabel: v.string(),
  memoriesUsed: v.number(),
  factsUsed: v.number(),
  chunksCreated: v.number(),
  factsExtracted: v.number(),
  scenario: v.string(),
});

interface RoutingScenario {
  scenario: 1 | 2 | 3 | 4;
  description: string;
  blockId: string;
  isNewTopic: boolean;
  pausedBlockId?: string;
}

// ============================================================================
// Main Chat Action
// ============================================================================

/**
 * Send a message and get an AI response with full memory context
 *
 * This matches Python's ConversationEngine.process_user_message() + _handle_chat()
 */
export const sendMessage = action({
  args: {
    message: v.string(),
    openaiApiKey: v.string(),
    zeroEntropyApiKey: v.optional(v.string()),
    userId: v.optional(v.string()),
    context: v.optional(
      v.object({
        caseId: v.optional(v.string()),
        clientName: v.optional(v.string()),
        additionalContext: v.optional(v.string()),
      })
    ),
    model: v.optional(v.string()),
    governorModel: v.optional(v.string()),
    embeddingDimensions: v.optional(v.number()),
  },
  returns: chatResponseValidator,
  handler: async (ctx, args) => {
    const model = args.model ?? "gpt-4o";
    const governorModel = args.governorModel ?? "gpt-4o-mini";
    const embeddingDimensions = args.embeddingDimensions ?? 1024;
    const dayId = new Date().toISOString().split("T")[0];

    // =========================================================================
    // STEP 1: Generate turn_id immediately (needed for chunking linkage)
    // Python: turn_id = f"turn_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    // =========================================================================
    const turnId = `turn_${Date.now()}`;
    const startTime = Date.now();

    // Debug: Log query
    await ctx.runMutation(internal.debug.logQuery, {
      turnId,
      userQuery: args.message,
      keywords: extractKeywords(args.message),
    });

    // =========================================================================
    // STEP 2: Chunk the query (hierarchical structure)
    // Python: chunks = self.chunk_engine.chunk_turn(text=user_query, turn_id=turn_id)
    // =========================================================================
    let chunksCreated = 0;
    try {
      const chunkResult = await ctx.runMutation(internal.chunking.chunkTurn, {
        text: args.message,
        turnId,
        blockId: undefined, // Will be updated after routing
      });
      chunksCreated = chunkResult.sentenceCount + chunkResult.paragraphCount;
    } catch (error) {
      console.error("Chunking failed (non-fatal):", error);
    }

    // =========================================================================
    // STEP 3: Generate embedding for the query
    // =========================================================================
    const embedding = await generateEmbedding(
      args.message,
      args.zeroEntropyApiKey ?? args.openaiApiKey,
      embeddingDimensions
    );

    // =========================================================================
    // STEP 4: Run the Governor (3 parallel tasks)
    // Python: routing_decision, filtered_memories, facts = await self.governor.govern()
    // =========================================================================
    const { routing, memories, facts } = await ctx.runAction(
      internal.governor.govern,
      {
        query: args.message,
        queryEmbedding: embedding,
        dayId,
        openaiApiKey: args.openaiApiKey,
        governorModel,
      }
    );

    // Debug: Log Governor decision
    await ctx.runMutation(internal.debug.logGovernor, {
      turnId,
      decision: {
        selectedBlock: routing.matchedBlockId ?? undefined,
        createNewBlock: routing.createNew,
        confidence: routing.confidence,
        reasoning: routing.suggestedLabel,
      },
    });

    // Debug: Log retrieved context
    await ctx.runMutation(internal.debug.logContext, {
      turnId,
      retrievedItems: memories.map((m: any) => m.content?.slice(0, 100) ?? ""),
      totalTokens: memories.reduce((sum: number, m: any) => sum + (m.content?.length ?? 0) / 4, 0),
    });

    // =========================================================================
    // STEP 5: Execute 1 of 4 routing scenarios
    // Python: matched_block_id, is_new, suggested_label, last_active_block logic
    // =========================================================================
    const routingResult = await executeRoutingScenario(
      ctx,
      routing,
      dayId,
      args.message
    );

    const { blockId, isNewTopic, scenario } = routingResult;
    const topicLabel = routing.suggestedLabel ?? "Conversation";

    // =========================================================================
    // STEP 6: Update chunks with block ID (link them to the block)
    // Python: self.storage.update_facts_block_id(turn_id, block_id)
    // =========================================================================
    if (chunksCreated > 0) {
      await ctx.runMutation(internal.chunking.updateBlockId, {
        turnId,
        blockId: blockId as any,
      });
    }

    // =========================================================================
    // STEP 7: Start fact extraction (parallel with context building)
    // Python: fact_extraction_task = asyncio.create_task(self.fact_scrubber.extract_and_save(...))
    // =========================================================================
    const factExtractionPromise = extractFacts(
      args.message,
      "", // Response not yet available
      args.openaiApiKey,
      governorModel
    );

    // =========================================================================
    // STEP 8: Get block facts for context
    // Python: block_facts = self.storage.get_facts_for_block(block_id)
    // =========================================================================
    const blockFacts = await ctx.runQuery(internal.facts.getByBlock, {
      blockId: blockId as any,
    });

    // =========================================================================
    // STEP 9: Get user profile context
    // Python: user_profile_context = self.user_profile_manager.get_user_profile_context(max_tokens=300)
    // =========================================================================
    const userProfileContext = await ctx.runQuery(
      internal.userProfile.getAsContext,
      { maxTokens: 300 }
    );

    // =========================================================================
    // STEP 10: Get block turns for context
    // Python: bridge_block = self.storage.get_bridge_block_full(block_id)
    // =========================================================================
    const blockTurns = await ctx.runQuery(internal.bridgeBlocks.getTurns, {
      blockId: blockId as any,
    });

    // =========================================================================
    // STEP 11: Build full context (Hydrator)
    // Python: full_prompt = self.context_hydrator.hydrate_bridge_block(...)
    // =========================================================================
    const allFacts = [
      ...facts,
      ...blockFacts.map((f: any) => ({
        key: f.key,
        value: f.value,
        category: f.category,
      })),
    ];

    const context = buildFullContext(
      blockTurns,
      memories,
      allFacts,
      userProfileContext,
      args.context,
      routingResult.isNewTopic,
      topicLabel
    );

    // =========================================================================
    // STEP 12: Generate AI response
    // Python: chat_response = self.external_api.query_external_api(full_prompt)
    // =========================================================================
    const systemPrompt = buildSystemPrompt(topicLabel, userProfileContext);
    const response = await generateResponse(
      args.message,
      context,
      systemPrompt,
      args.openaiApiKey,
      model
    );

    // Debug: Log prompt and response
    await ctx.runMutation(internal.debug.logPrompt, {
      turnId,
      prompt: context,
      estimatedTokens: Math.ceil(context.length / 4),
    });

    await ctx.runMutation(internal.debug.logResponse, {
      turnId,
      response: response,
      latencyMs: Date.now() - startTime,
    });

    // =========================================================================
    // STEP 13: Parse metadata JSON from response (if present)
    // Python: json_match = re.search(json_pattern, chat_response, re.DOTALL)
    // =========================================================================
    const { cleanResponse, metadata } = parseResponseMetadata(response);

    // =========================================================================
    // STEP 14: Update Bridge Block header with metadata
    // Python: self.storage.update_bridge_block_metadata(block_id, metadata_json)
    // =========================================================================
    if (metadata) {
      await ctx.runMutation(internal.bridgeBlocks.updateMetadata, {
        blockId: blockId as any,
        metadata,
      });
    }

    // =========================================================================
    // STEP 15: Append turn to Bridge Block
    // Python: self.storage.append_turn_to_block(block_id, turn_data)
    // =========================================================================
    await ctx.runMutation(internal.bridgeBlocks.appendTurn, {
      blockId: blockId as any,
      turnId,
      userMessage: args.message,
      aiResponse: cleanResponse,
      keywords: extractKeywords(args.message + " " + cleanResponse),
      affect: metadata?.affect,
    });

    // =========================================================================
    // STEP 16: Store embedding for vector search
    // =========================================================================
    await ctx.runMutation(internal.memories.store, {
      turnId,
      blockId: blockId as any,
      content: `User: ${args.message}\nAssistant: ${cleanResponse}`,
      chunkIndex: 0,
      embedding,
    });

    // Lineage: Record turn -> memory derivation
    await ctx.runMutation(internal.lineage.recordLineage, {
      itemId: `mem_${turnId}`,
      itemType: "memory",
      derivedFrom: [turnId],
      derivedBy: "chat.sendMessage",
    });

    // Lineage: Record turn -> block relationship
    await ctx.runMutation(internal.lineage.recordLineage, {
      itemId: turnId,
      itemType: "turn",
      derivedFrom: [blockId],
      derivedBy: "chat.sendMessage",
    });

    // =========================================================================
    // STEP 17: Wait for fact extraction and store facts
    // Python: extracted_facts = await fact_extraction_task
    // =========================================================================
    let factsExtracted = 0;
    try {
      const extractedFacts = await factExtractionPromise;
      if (extractedFacts.length > 0) {
        await ctx.runMutation(internal.facts.storeBatch, {
          facts: extractedFacts.map((f) => ({
            key: f.key,
            value: f.value,
            category: f.category as any,
            blockId: blockId as any,
            turnId,
            evidenceSnippet: f.evidence,
          })),
        });
        factsExtracted = extractedFacts.length;
      }

      // Also extract facts from the response (may contain user preferences)
      const responseFacts = await extractFacts(
        args.message,
        cleanResponse,
        args.openaiApiKey,
        governorModel
      );
      if (responseFacts.length > 0) {
        await ctx.runMutation(internal.facts.storeBatch, {
          facts: responseFacts.map((f) => ({
            key: f.key,
            value: f.value,
            category: f.category as any,
            blockId: blockId as any,
            turnId,
            evidenceSnippet: f.evidence,
          })),
        });
        factsExtracted += responseFacts.length;
      }
    } catch (error) {
      console.error("Fact extraction failed (non-fatal):", error);
      await ctx.runMutation(internal.debug.logError, {
        turnId,
        error: `Fact extraction failed: ${String(error)}`,
      });
    }

    // Debug: Log facts extracted
    if (factsExtracted > 0) {
      await ctx.runMutation(internal.debug.logFacts, {
        turnId,
        facts: [], // Will be populated if we add tracking
      });
    }

    // Debug: Log total timing
    await ctx.runMutation(internal.debug.logTiming, {
      turnId,
      operation: "total",
      durationMs: Date.now() - startTime,
    });

    // =========================================================================
    // STEP 18: Schedule Scribe (background user profile update)
    // Python: task = asyncio.create_task(self.scribe.run_scribe_agent(user_query))
    // In Convex, we schedule this as a separate action
    // =========================================================================
    try {
      await ctx.scheduler.runAfter(0, internal.chat.runScribe, {
        userMessage: args.message,
        openaiApiKey: args.openaiApiKey,
      });
    } catch (error) {
      console.error("Scribe scheduling failed (non-fatal):", error);
    }

    return {
      response: cleanResponse,
      blockId,
      turnId,
      isNewTopic,
      topicLabel,
      memoriesUsed: memories.length,
      factsUsed: allFacts.length,
      chunksCreated,
      factsExtracted,
      scenario: getScenarioDescription(scenario),
    };
  },
});

// ============================================================================
// Scribe Background Action
// ============================================================================

/**
 * Run Scribe agent in background to extract user profile updates
 * Python: self.scribe.run_scribe_agent(user_query)
 */
export const runScribe = internalAction({
  args: {
    userMessage: v.string(),
    openaiApiKey: v.string(),
  },
  handler: async (ctx, args) => {
    // Get current profile context
    const currentProfile = await ctx.runQuery(
      internal.userProfile.getAsContext,
      { maxTokens: 500 }
    );

    const prompt = buildScribePrompt(args.userMessage, currentProfile);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are the User Profile Scribe. Extract projects, entities, and constraints. Return ONLY valid JSON.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 500,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      console.error("Scribe LLM call failed:", response.status);
      return;
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content ?? "{}";

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const updates = parsed.updates || [];

        for (const update of updates) {
          if (update.category === "projects") {
            await ctx.runMutation(internal.userProfile.upsertProject, {
              key: update.key,
              domain: update.attributes?.domain,
              description: update.attributes?.description,
              techStack: update.attributes?.tech_stack,
              status: update.attributes?.status ?? "Active",
            });
          } else if (update.category === "entities") {
            await ctx.runMutation(internal.userProfile.upsertEntity, {
              key: update.key,
              entityType: update.attributes?.type ?? "general",
              description: update.attributes?.description,
              relationship: update.attributes?.relationship,
            });
          } else if (update.category === "constraints") {
            await ctx.runMutation(internal.userProfile.upsertConstraint, {
              key: update.key,
              constraintType: update.attributes?.type ?? "preference",
              description: update.attributes?.description,
              severity: update.attributes?.severity ?? "preference",
            });
          }
        }
      }
    } catch (error) {
      console.error("Scribe JSON parsing failed:", error);
    }
  },
});

// ============================================================================
// Routing Scenario Execution
// ============================================================================

/**
 * Execute one of 4 routing scenarios
 * Python: Scenarios 1-4 in _handle_chat()
 */
async function executeRoutingScenario(
  ctx: any,
  routing: {
    isNewTopic: boolean;
    matchedBlockId?: string;
    suggestedLabel?: string;
  },
  dayId: string,
  userMessage: string
): Promise<RoutingScenario> {
  // Get current active block
  const activeBlocks = await ctx.runQuery(internal.bridgeBlocks.getActive, {
    dayId,
  });
  const lastActiveBlock = activeBlocks[0] ?? null;

  const matchedBlockId = routing.matchedBlockId;
  const isNew = routing.isNewTopic;
  const suggestedLabel = routing.suggestedLabel ?? "General Discussion";
  const keywords = extractKeywords(userMessage);

  // SCENARIO 1: Topic Continuation
  if (
    matchedBlockId &&
    lastActiveBlock &&
    matchedBlockId === lastActiveBlock._id
  ) {
    return {
      scenario: 1,
      description: "Topic Continuation",
      blockId: matchedBlockId,
      isNewTopic: false,
    };
  }

  // SCENARIO 2: Topic Resumption
  if (matchedBlockId && !isNew) {
    // Pause current active block if exists
    if (lastActiveBlock) {
      await ctx.runMutation(internal.bridgeBlocks.pauseWithSummary, {
        blockId: lastActiveBlock._id,
      });
    }

    // Reactivate matched block
    await ctx.runMutation(internal.bridgeBlocks.updateStatus, {
      blockId: matchedBlockId as any,
      status: "ACTIVE",
    });

    return {
      scenario: 2,
      description: "Topic Resumption",
      blockId: matchedBlockId,
      isNewTopic: false,
      pausedBlockId: lastActiveBlock?._id,
    };
  }

  // SCENARIO 3: New Topic Creation (no active blocks)
  if (isNew && !lastActiveBlock) {
    const blockId = await ctx.runMutation(internal.bridgeBlocks.create, {
      dayId,
      topicLabel: suggestedLabel,
      keywords,
    });

    return {
      scenario: 3,
      description: "New Topic Creation",
      blockId,
      isNewTopic: true,
    };
  }

  // SCENARIO 4: Topic Shift to New
  if (isNew && lastActiveBlock) {
    // Pause current active block with summary
    await ctx.runMutation(internal.bridgeBlocks.pauseWithSummary, {
      blockId: lastActiveBlock._id,
    });

    // Create new block
    const blockId = await ctx.runMutation(internal.bridgeBlocks.create, {
      dayId,
      topicLabel: suggestedLabel,
      keywords,
    });

    return {
      scenario: 4,
      description: "Topic Shift",
      blockId,
      isNewTopic: true,
      pausedBlockId: lastActiveBlock._id,
    };
  }

  // FALLBACK: Create new block
  const blockId = await ctx.runMutation(internal.bridgeBlocks.create, {
    dayId,
    topicLabel: suggestedLabel,
    keywords,
  });

  return {
    scenario: 3,
    description: "Fallback - New Topic",
    blockId,
    isNewTopic: true,
  };
}

function getScenarioDescription(scenario: number): string {
  switch (scenario) {
    case 1:
      return "continuation";
    case 2:
      return "resumption";
    case 3:
      return "new_topic";
    case 4:
      return "topic_shift";
    default:
      return "unknown";
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate embedding using OpenAI
 */
async function generateEmbedding(
  text: string,
  apiKey: string,
  dimensions: number
): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
      dimensions,
    }),
  });

  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

/**
 * Build system prompt with user profile
 * Python: system_prompt in _handle_chat()
 */
function buildSystemPrompt(
  topicLabel: string,
  userProfileContext: string
): string {
  return `You are CognitiveLattice, an AI assistant with long-term memory.
You maintain Bridge Blocks to organize conversations by topic.
You are currently discussing: ${topicLabel}

Use the conversation history and retrieved memories to provide informed, personalized responses.
Reference relevant past conversations and known facts when appropriate.
Be concise but thorough.

${userProfileContext ? `\n[User Profile]\n${userProfileContext}` : ""}`;
}

/**
 * Build full context with block turns, memories, facts, and metadata instructions
 * Python: context_hydrator.hydrate_bridge_block()
 */
function buildFullContext(
  blockTurns: Array<{
    turnId: string;
    userMessage: string;
    aiResponse: string;
    timestamp: number;
  }>,
  memories: Array<{ content: string; score: number }>,
  facts: Array<{ key: string; value: string; category?: string }>,
  userProfile: string,
  appContext?: {
    caseId?: string;
    clientName?: string;
    additionalContext?: string;
  },
  isNewTopic: boolean = false,
  topicLabel: string = "Conversation"
): string {
  const sections: string[] = [];

  // 1. User Profile
  if (userProfile) {
    sections.push(`=== USER PROFILE ===\n${userProfile}`);
  }

  // 2. App Context
  if (appContext) {
    const contextParts: string[] = [];
    if (appContext.clientName)
      contextParts.push(`Client: ${appContext.clientName}`);
    if (appContext.caseId) contextParts.push(`Case ID: ${appContext.caseId}`);
    if (appContext.additionalContext)
      contextParts.push(appContext.additionalContext);

    if (contextParts.length > 0) {
      sections.push(`=== CURRENT CONTEXT ===\n${contextParts.join("\n")}`);
    }
  }

  // 3. Known Facts
  if (facts.length > 0) {
    const factsText = facts.map((f) => `[${f.category ?? "general"}] ${f.key}: ${f.value}`).join("\n");
    sections.push(`=== KNOWN FACTS ===\n${factsText}`);
  }

  // 4. Current Topic Conversation History (Block Turns)
  if (blockTurns.length > 0) {
    const turnsText = blockTurns
      .slice(-10) // Last 10 turns
      .map((t, i) => {
        const ts = new Date(t.timestamp).toISOString();
        return `[Turn ${i + 1}] ${ts}\nUser: ${t.userMessage}\nAssistant: ${t.aiResponse}`;
      })
      .join("\n\n");
    sections.push(`=== CURRENT TOPIC: ${topicLabel} ===\nConversation History (${blockTurns.length} turns):\n\n${turnsText}`);
  }

  // 5. Retrieved Memories (from other topics/days)
  if (memories.length > 0) {
    const memoriesText = memories
      .slice(0, 5)
      .map((m, i) => `${i + 1}. (relevance: ${(m.score * 100).toFixed(0)}%)\n   ${m.content}`)
      .join("\n\n");
    sections.push(`=== RELEVANT PAST MEMORIES ===\n(From previous topics/days)\n\n${memoriesText}`);
  }

  // 6. Bridge Block Metadata Instructions (CRITICAL for Python parity)
  sections.push(buildMetadataInstructions(isNewTopic, topicLabel));

  return sections.join("\n\n");
}

/**
 * Build metadata instructions for LLM to update Bridge Block header
 * Python: context_hydrator.py lines 220-270
 */
function buildMetadataInstructions(isNewTopic: boolean, currentLabel: string): string {
  if (isNewTopic) {
    return `=== BRIDGE BLOCK METADATA INSTRUCTIONS ===
NEW TOPIC DETECTED

After providing your response, you MUST generate the Bridge Block header metadata.
Analyze the conversation and return a JSON object with:

\`\`\`json
{
  "topic_label": "Concise topic name (3-7 words)",
  "keywords": ["key", "terms", "for", "routing"],
  "summary": "One sentence summary of what we're discussing",
  "open_loops": ["Things to follow up on"],
  "decisions_made": ["Key decisions or conclusions"],
  "affect": "neutral|curious|frustrated|excited|etc"
}
\`\`\`

Return this JSON in a clearly marked code block after your response.`;
  } else {
    return `=== BRIDGE BLOCK METADATA INSTRUCTIONS ===
TOPIC CONTINUATION

After providing your response, if any metadata needs updating (new keywords, resolved open loops, etc.),
return an UPDATED JSON object:

\`\`\`json
{
  "topic_label": "${currentLabel}",
  "keywords": ["updated", "keywords"],
  "summary": "Updated summary if needed",
  "affect": "current emotional tone"
}
\`\`\`

Only return this JSON if you made changes. If no updates needed, omit it.`;
  }
}

/**
 * Generate AI response using OpenAI
 */
async function generateResponse(
  message: string,
  context: string,
  systemPrompt: string,
  apiKey: string,
  model: string
): Promise<string> {
  const userPrompt = context ? `${context}\n\n---\n\nUser: ${message}` : message;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  return (
    data.choices[0]?.message?.content ??
    "I apologize, but I couldn't generate a response."
  );
}

/**
 * Parse metadata JSON from LLM response
 * Python: json_match = re.search(json_pattern, chat_response, re.DOTALL)
 */
function parseResponseMetadata(response: string): {
  cleanResponse: string;
  metadata: { affect?: string; topics?: string[]; keywords?: string[] } | null;
} {
  const jsonPattern = /```json\s*(\{[^`]+\})\s*```/s;
  const match = response.match(jsonPattern);

  if (match) {
    try {
      const metadata = JSON.parse(match[1]);
      const cleanResponse = response.replace(jsonPattern, "").trim();
      return { cleanResponse, metadata };
    } catch {
      return { cleanResponse: response, metadata: null };
    }
  }

  return { cleanResponse: response, metadata: null };
}

/**
 * Extract facts from conversation using LLM
 */
async function extractFacts(
  userMessage: string,
  aiResponse: string,
  apiKey: string,
  model: string
): Promise<
  Array<{
    key: string;
    value: string;
    category: string;
    evidence: string;
  }>
> {
  const messageToAnalyze = aiResponse
    ? `User: ${userMessage}\nAssistant: ${aiResponse}`
    : `User: ${userMessage}`;

  const prompt = `Extract ONLY hard facts from this conversation. Categories:
1. Definition - Definitions of terms or concepts
2. Acronym - Acronym expansions
3. credential - API keys, passwords, tokens
4. contact - Emails, phone numbers
5. preference - User preferences
6. decision - Chosen options
7. date - Deadlines, appointments

MESSAGE:
${messageToAnalyze}

Return JSON (empty array if no facts):
[{"key": "identifier", "value": "the fact", "category": "category", "evidence": "source quote"}]`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You extract structured facts from conversations. Always return valid JSON array.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 500,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content ?? "[]";

  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // Parse error
  }

  return [];
}

/**
 * Extract keywords from text
 */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "shall", "can", "to", "of", "in",
    "for", "on", "with", "at", "by", "from", "as", "into", "through",
    "during", "before", "after", "above", "below", "between", "under",
    "again", "further", "then", "once", "here", "there", "when", "where",
    "why", "how", "all", "each", "few", "more", "most", "other", "some",
    "such", "no", "nor", "not", "only", "own", "same", "so", "than",
    "too", "very", "just", "and", "but", "if", "or", "because", "until",
    "while", "about", "against", "i", "me", "my", "myself", "we", "our",
    "you", "your", "he", "him", "his", "she", "her", "it", "its",
    "they", "them", "their", "what", "which", "who", "this", "that",
  ]);

  const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
  const keywords = words.filter((word) => !stopWords.has(word));

  const freq = new Map<string, number>();
  for (const word of keywords) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

/**
 * Build Scribe prompt
 * Python: SCRIBE_SYSTEM_PROMPT in memory/synthesis/scribe.py
 */
function buildScribePrompt(userMessage: string, currentProfile: string): string {
  return `### ROLE
You are the **User Profile Scribe**.
Your goal is to maintain a "Glossary" of the user's life by extracting **Projects**, **Entities**, and **Hard Constraints** from the conversation.

### DEFINITIONS
**PROJECT**: Named endeavor (proper noun), persistent (weeks/months), user-owned.
**ENTITY**: Business, person (family), or major asset.
**CONSTRAINT**: Permanent preference/restriction (allergies, work rules, etc.)

### WHAT TO IGNORE
- Opinions/mood
- One-off tasks
- General topics without user ownership

### OUTPUT SCHEMA
Return JSON:
{
  "updates": [
    {
      "category": "projects",
      "key": "PROJECT_NAME",
      "action": "UPSERT",
      "attributes": {
        "domain": "...",
        "description": "...",
        "tech_stack": "...",
        "status": "Active"
      }
    }
  ]
}

If no updates, return: {"updates": []}

CURRENT PROFILE:
${currentProfile}

USER INPUT: "${userMessage}"`;
}

// ============================================================================
// Additional Chat Utilities
// ============================================================================

/**
 * Get conversation history for a topic
 */
export const getHistory = action({
  args: {
    blockId: v.id("bridgeBlocks"),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      turnId: v.string(),
      userMessage: v.string(),
      aiResponse: v.string(),
      timestamp: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const turns = await ctx.runQuery(internal.bridgeBlocks.getTurns, {
      blockId: args.blockId,
    });

    const sorted = turns.sort((a: any, b: any) => a.timestamp - b.timestamp);
    const limited = args.limit ? sorted.slice(-args.limit) : sorted;

    return limited.map((t: any) => ({
      turnId: t.turnId,
      userMessage: t.userMessage,
      aiResponse: t.aiResponse,
      timestamp: t.timestamp,
    }));
  },
});

/**
 * Search across all conversations
 */
export const searchConversations = action({
  args: {
    query: v.string(),
    openaiApiKey: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      content: v.string(),
      score: v.number(),
      topicLabel: v.string(),
      dayId: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const embedding = await generateEmbedding(args.query, args.openaiApiKey, 1024);

    const results = await ctx.runAction(internal.memories.searchWithContext, {
      embedding,
      limit: args.limit ?? 10,
      minScore: 0.5,
    });

    return results.map((r: any) => ({
      content: r.memory.content,
      score: r.memory.score,
      topicLabel: r.block?.topicLabel ?? "Unknown",
      dayId: r.block?.dayId ?? "Unknown",
    }));
  },
});
