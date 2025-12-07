# @timottowitz/convex-hmlr

**HMLR - Hierarchical Memory Lookup & Routing**

A portable, state-aware long-term memory system for AI agents, built as a Convex Component.

## Features

- **Bridge Blocks**: Topic-based conversation containers with automatic routing
- **Semantic Memory**: Vector search with 2-key filtering (similarity + LLM validation)
- **Fact Store**: Key-value pairs extracted from conversations
- **The Governor**: LLM-powered routing that decides where queries belong
- **User Profiling**: Synthesized user preferences and patterns
- **Zero Configuration**: Just install and use - tables are isolated in their own sandbox

## Installation

```bash
npm install @timottowitz/convex-hmlr
```

## Setup

### 1. Add to your Convex config

```typescript
// convex/convex.config.ts
import { defineApp } from "convex/server";
import hmlr from "@timottowitz/convex-hmlr/convex.config.js";

const app = defineApp();
app.use(hmlr);

export default app;
```

### 2. Deploy

```bash
npx convex dev
```

That's it! The HMLR tables are created in their own isolated sandbox.

## Usage

### Basic Chat

```typescript
// convex/chat.ts
import { HMLR } from "@timottowitz/convex-hmlr";
import { components } from "./_generated/api";
import { action } from "./_generated/server";
import { v } from "convex/values";

// Initialize HMLR
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

### With App Context

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
    // Get case context from your tables
    const caseData = await ctx.runQuery(api.cases.get, { id: args.caseId });

    // Chat with context
    const result = await hmlr.chat(ctx, {
      message: args.message,
      context: {
        caseId: args.caseId,
        clientName: caseData.clientName,
      },
    });

    // Log to your tables
    await ctx.runMutation(api.caseMessages.log, {
      caseId: args.caseId,
      message: args.message,
      response: result.response,
      hmlrBlockId: result.blockId,
    });

    return result;
  },
});
```

### Search Memories

```typescript
const results = await hmlr.search(ctx, "API key for production", 10);
// Returns: [{ content, score, topicLabel, dayId }]
```

### Store Facts Explicitly

```typescript
await hmlr.storeFact(ctx, {
  key: "CLIENT_TIMEZONE",
  value: "America/New_York",
  category: "preference",
  blockId: currentBlockId,
});
```

### Get Facts

```typescript
const fact = await hmlr.getFact(ctx, "CLIENT_TIMEZONE");
// Returns: { key, value, category, blockId, createdAt }
```

## API Reference

### HMLR Class

```typescript
const hmlr = new HMLR(components.hmlr, {
  OPENAI_API_KEY: string,           // Required
  ZEROENTROPY_API_KEY?: string,     // Optional (falls back to OpenAI)
  defaultModel?: string,            // Default: "gpt-4o"
  governorModel?: string,           // Default: "gpt-4o-mini"
  embeddingDimensions?: number,     // Default: 1024
});
```

### Methods

#### Chat
- `chat(ctx, options)` - Send message and get response with memory context
- `search(ctx, query, limit?)` - Search all conversations semantically
- `getHistory(ctx, blockId, limit?)` - Get conversation history

#### Facts
- `storeFact(ctx, { key, value, category, blockId })` - Store a fact
- `getFact(ctx, key)` - Get fact by key
- `getFactsByBlock(ctx, blockId)` - Get all facts for a block
- `getFactsByCategory(ctx, category)` - Get facts by category
- `searchFacts(ctx, prefix)` - Search facts by key prefix
- `removeFact(ctx, factId)` - Remove a fact

#### Bridge Blocks
- `getActiveBlock(ctx)` - Get currently active block
- `getBlocksByDay(ctx, dayId)` - Get all blocks for a day
- `getBlock(ctx, blockId)` - Get a specific block
- `getTurns(ctx, blockId)` - Get turns for a block
- `createBlock(ctx, { dayId, topicLabel, keywords })` - Create block manually
- `updateBlockStatus(ctx, blockId, status)` - Update block status

#### Advanced
- `runGovernor(ctx, { query, queryEmbedding, dayId })` - Run Governor directly
- `route(ctx, query, dayId)` - Route query without memory retrieval

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Convex App                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                    HMLR Component                     │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │   │
│  │  │   Chat     │  │  Governor  │  │    Memories    │  │   │
│  │  │  (entry)   │──│  (router)  │──│ (vector search)│  │   │
│  │  └────────────┘  └────────────┘  └────────────────┘  │   │
│  │         │               │               │            │   │
│  │         ▼               ▼               ▼            │   │
│  │  ┌─────────────────────────────────────────────────┐ │   │
│  │  │              Isolated Tables                     │ │   │
│  │  │  bridgeBlocks | turns | facts | memories | ...  │ │   │
│  │  └─────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Your App's Tables                        │   │
│  │         cases | clients | documents | ...             │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Testing

```typescript
import hmlrTest from "@timottowitz/convex-hmlr/test";
import { convexTest } from "convex-test";

const t = convexTest();
hmlrTest.register(t);

// Use mock embeddings for testing
const embedding = hmlrTest.mockEmbedding(1024);
```

## License

MIT
