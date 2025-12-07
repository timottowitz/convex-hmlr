# @timottowitz/convex-hmlr

HMLR (Hierarchical Memory Lookup and Routing) is a portable, state-aware long-term memory system for AI agents, built as a Convex Component.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
- [Portability](#portability)
- [Architecture](#architecture)
- [Testing](#testing)
- [License](#license)

## Overview

HMLR provides persistent memory for AI chat applications. It automatically:

1. Detects topic shifts and organizes conversations into Bridge Blocks
2. Extracts and stores facts from conversations for instant recall
3. Routes queries to the right memory source using The Governor
4. Manages token budgets for context injection
5. Synthesizes user profiles from conversation patterns

### Key Features

- **Bridge Blocks**: Topic-based conversation containers that automatically segment discussions
- **Fact Store**: Key-value store for extracted information (credentials, preferences, decisions)
- **The Governor**: LLM-powered router that decides query routing priority (fact store > daily ledger > vector search)
- **Hybrid Search**: Combined vector similarity and lexical matching
- **User Profiling**: Automatic synthesis of user preferences and patterns
- **Isolated Tables**: All HMLR data lives in its own sandbox, separate from your app tables

## Installation

```bash
npm install @timottowitz/convex-hmlr
```

Requirements:
- Convex 1.17.0 or higher
- Node.js 18 or higher
- OpenAI API key (for embeddings and LLM calls)

## Quick Start

### Step 1: Add HMLR to your Convex configuration

Create or update `convex/convex.config.ts`:

```typescript
import { defineApp } from "convex/server";
import hmlr from "@timottowitz/convex-hmlr/convex.config.js";

const app = defineApp();
app.use(hmlr);

export default app;
```

### Step 2: Deploy to create the HMLR tables

```bash
npx convex dev
```

This creates all HMLR tables in an isolated namespace. Your existing tables are not affected.

### Step 3: Create a chat endpoint

```typescript
// convex/chat.ts
import { HMLR } from "@timottowitz/convex-hmlr";
import { components } from "./_generated/api";
import { action } from "./_generated/server";
import { v } from "convex/values";

const hmlr = new HMLR(components.hmlr, {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
});

export const sendMessage = action({
  args: { message: v.string() },
  handler: async (ctx, args) => {
    const result = await hmlr.chat(ctx, {
      message: args.message,
    });
    return result;
  },
});
```

### Step 4: Use from your frontend

```typescript
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";

function Chat() {
  const sendMessage = useAction(api.chat.sendMessage);
  
  const handleSend = async (message: string) => {
    const response = await sendMessage({ message });
    console.log(response.response);
    console.log(response.blockId);  // Current topic block
    console.log(response.factsUsed); // Facts retrieved
  };
}
```

## Core Concepts

### Bridge Blocks

Bridge Blocks are topic-based containers for conversation turns. When HMLR detects a topic shift, it:

1. Pauses the current block with a summary
2. Creates a new block for the new topic
3. Stores keywords for later retrieval

```typescript
// Get the active block
const block = await hmlr.getActiveBlock(ctx);
// { blockId, topicLabel, keywords, status, turnCount }

// Get all blocks from today
const todayBlocks = await hmlr.getBlocksByDay(ctx, "2024-01-15");
```

### Fact Store

Facts are key-value pairs extracted from conversations. They provide instant recall without vector search.

Categories:
- `credential` - API keys, passwords, tokens
- `preference` - User preferences (timezone, communication style)
- `policy` - Business rules, constraints
- `decision` - Approved choices, selected options
- `contact` - Emails, phone numbers
- `date` - Important dates, deadlines
- `general` - Other facts

```typescript
// Store a fact
await hmlr.storeFact(ctx, {
  key: "client_timezone",
  value: "America/New_York",
  category: "preference",
  blockId: currentBlockId,
});

// Retrieve a fact (instant, no vector search)
const fact = await hmlr.getFact(ctx, "client_timezone");

// Search facts by category
const preferences = await hmlr.getFactsByCategory(ctx, "preference");
```

### The Governor

The Governor routes queries using a priority system:

1. **Fact Store** (Priority 1): Exact keyword match returns instantly
2. **Daily Ledger** (Priority 2): Same-day Bridge Blocks checked for topic relevance
3. **Vector Search** (Priority 3): Semantic search across all memories

```typescript
// Run the Governor directly
const routing = await hmlr.runGovernor(ctx, {
  query: "What is my API key?",
  queryEmbedding: embedding,
  dayId: "2024-01-15",
});
// { source: "fact_store", factKey: "api_key", confidence: 1.0 }
```

### Hybrid Search

Combines vector similarity with lexical (keyword) matching:

```typescript
const results = await hmlr.search(ctx, "contract liability terms", 10);
// Returns ranked results with combined scores
```

## API Reference

### Constructor

```typescript
const hmlr = new HMLR(components.hmlr, {
  OPENAI_API_KEY: string,           // Required: OpenAI API key
  ZEROENTROPY_API_KEY?: string,     // Optional: Falls back to OpenAI
  defaultModel?: string,            // Default: "gpt-4o"
  governorModel?: string,           // Default: "gpt-4o-mini"
  embeddingDimensions?: number,     // Default: 1024
});
```

### Chat Methods

```typescript
// Send a message with full memory context
const result = await hmlr.chat(ctx, {
  message: string,
  context?: Record<string, any>,  // Additional context from your app
});
// Returns: { response, blockId, factsUsed, memoriesUsed, tokenStats }

// Search all conversations
const results = await hmlr.search(ctx, query: string, limit?: number);
// Returns: [{ content, score, topicLabel, dayId, turnId }]

// Get conversation history for a block
const history = await hmlr.getHistory(ctx, blockId: string, limit?: number);
// Returns: [{ turnId, userMessage, aiResponse, timestamp }]
```

### Fact Methods

```typescript
// Store a fact
await hmlr.storeFact(ctx, {
  key: string,
  value: string,
  category: "credential" | "preference" | "policy" | "decision" | "contact" | "date" | "general",
  blockId: string,
  turnId?: string,
  evidenceSnippet?: string,
});

// Get a fact by exact key
const fact = await hmlr.getFact(ctx, key: string);

// Get facts by block
const facts = await hmlr.getFactsByBlock(ctx, blockId: string);

// Get facts by category
const facts = await hmlr.getFactsByCategory(ctx, category: string);

// Search facts by key prefix
const facts = await hmlr.searchFacts(ctx, prefix: string);

// Remove a fact
await hmlr.removeFact(ctx, factId: string);
```

### Bridge Block Methods

```typescript
// Get the currently active block
const block = await hmlr.getActiveBlock(ctx);

// Get all blocks for a specific day
const blocks = await hmlr.getBlocksByDay(ctx, dayId: string);

// Get a specific block
const block = await hmlr.getBlock(ctx, blockId: string);

// Get turns for a block
const turns = await hmlr.getTurns(ctx, blockId: string);

// Create a block manually
const blockId = await hmlr.createBlock(ctx, {
  dayId: string,
  topicLabel: string,
  keywords: string[],
});

// Update block status
await hmlr.updateBlockStatus(ctx, blockId: string, status: "ACTIVE" | "PAUSED" | "CLOSED");
```

### Advanced Methods

```typescript
// Run the Governor routing logic directly
const routing = await hmlr.runGovernor(ctx, {
  query: string,
  queryEmbedding: number[],
  dayId: string,
});

// Route a query without full memory retrieval
const route = await hmlr.route(ctx, query: string, dayId: string);

// Get synthesis context (user profile summary)
const profile = await hmlr.getSynthesisContext(ctx, maxTokens?: number);

// Get token statistics for a block
const stats = await hmlr.getTokenStats(ctx, blockId: string);
```

## Portability

HMLR is designed as a portable Convex Component. This means:

### Isolated Data

All HMLR tables exist in their own namespace. They do not conflict with your application tables. The tables created are:

- `bridgeBlocks` - Topic containers
- `turns` - Conversation turns
- `facts` - Extracted facts
- `memories` - Vector embeddings
- `userPreferences` - User profile data
- `daySynthesis` - Daily summaries
- `weekSynthesis` - Weekly summaries
- `debugLogs` - Debug information
- `usageTracking` - Usage statistics
- `lineage` - Data provenance tracking
- `topicAffinity` - Topic relationship scores
- `planSessions` - Planning sessions
- `plans` - Active plans
- `planItems` - Plan items

### Moving Between Environments

To move HMLR to a different Convex project:

1. Install the package in the new project:
```bash
npm install @timottowitz/convex-hmlr
```

2. Add to the new project's Convex config:
```typescript
// convex/convex.config.ts
import { defineApp } from "convex/server";
import hmlr from "@timottowitz/convex-hmlr/convex.config.js";

const app = defineApp();
app.use(hmlr);
export default app;
```

3. Deploy:
```bash
npx convex dev
```

The HMLR tables are created fresh. To migrate data between environments, you would need to export from the source and import to the destination using Convex's data export/import tools.

### Multiple HMLR Instances

You can use multiple HMLR instances in the same app for different purposes:

```typescript
// convex/convex.config.ts
import { defineApp } from "convex/server";
import hmlr from "@timottowitz/convex-hmlr/convex.config.js";

const app = defineApp();
app.use(hmlr, { name: "customerSupport" });
app.use(hmlr, { name: "internalDocs" });
export default app;
```

```typescript
// convex/support.ts
const supportMemory = new HMLR(components.customerSupport, config);

// convex/docs.ts
const docsMemory = new HMLR(components.internalDocs, config);
```

### Integration with Your App

HMLR is designed to work alongside your existing tables:

```typescript
// convex/legalChat.ts
import { HMLR } from "@timottowitz/convex-hmlr";
import { components, api } from "./_generated/api";
import { action } from "./_generated/server";
import { v } from "convex/values";

const hmlr = new HMLR(components.hmlr, {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
});

export const sendCaseMessage = action({
  args: {
    caseId: v.id("cases"),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    // Query YOUR tables for context
    const caseData = await ctx.runQuery(api.cases.get, { id: args.caseId });
    const client = await ctx.runQuery(api.clients.get, { id: caseData.clientId });

    // Send to HMLR with your app context
    const result = await hmlr.chat(ctx, {
      message: args.message,
      context: {
        caseNumber: caseData.caseNumber,
        clientName: client.name,
        caseType: caseData.type,
      },
    });

    // Log to YOUR tables
    await ctx.runMutation(api.caseMessages.create, {
      caseId: args.caseId,
      userMessage: args.message,
      aiResponse: result.response,
      hmlrBlockId: result.blockId,
    });

    return result;
  },
});
```

## Architecture

```
+-------------------------------------------------------------+
|                     Your Convex App                          |
|                                                              |
|  +-------------------------------------------------------+  |
|  |                   HMLR Component                       |  |
|  |                                                        |  |
|  |  +-------------+  +-------------+  +----------------+  |  |
|  |  |    Chat     |  |  Governor   |  |   Retrieval    |  |  |
|  |  |   (entry)   |->|  (router)   |->|  (hydrator)    |  |  |
|  |  +-------------+  +-------------+  +----------------+  |  |
|  |        |               |                  |            |  |
|  |        v               v                  v            |  |
|  |  +-------------+  +-------------+  +----------------+  |  |
|  |  | TabulaRasa  |  | Fact Store  |  |   Memories     |  |  |
|  |  | (topics)    |  | (key-value) |  | (vector search)|  |  |
|  |  +-------------+  +-------------+  +----------------+  |  |
|  |        |               |                  |            |  |
|  |        v               v                  v            |  |
|  |  +--------------------------------------------------+  |  |
|  |  |              Isolated HMLR Tables                 |  |  |
|  |  |  bridgeBlocks | turns | facts | memories | ...   |  |  |
|  |  +--------------------------------------------------+  |  |
|  +-------------------------------------------------------+  |
|                                                              |
|  +-------------------------------------------------------+  |
|  |               Your Application Tables                  |  |
|  |          cases | clients | documents | users           |  |
|  +-------------------------------------------------------+  |
+-------------------------------------------------------------+
```

### Data Flow

1. **User sends message** -> `chat.sendMessage`
2. **Topic detection** -> TabulaRasa checks for topic shift
3. **Block management** -> Create new block or continue existing
4. **Governor routing** -> Determine memory source priority
5. **Context hydration** -> Build prompt with retrieved context
6. **LLM call** -> Generate response
7. **Fact extraction** -> Extract and store new facts
8. **Memory storage** -> Store turn with embedding

## Testing

HMLR includes 80+ tests covering all modules. To run tests:

```bash
npm test
```

For integration testing in your app:

```typescript
import hmlrTest from "@timottowitz/convex-hmlr/test";
import { convexTest } from "convex-test";

const t = convexTest();
hmlrTest.register(t);

// Use mock embeddings for deterministic tests
const embedding = hmlrTest.mockEmbedding(1024);
```

## License

MIT
