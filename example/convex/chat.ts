/**
 * Example: Using HMLR in your Convex app
 */

import { action, query } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";

// Note: In production, you'd import from the npm package:
// import { HMLR } from "@timottowitz/convex-hmlr";

// For now, we reference the component directly
export const sendMessage = action({
  args: {
    message: v.string(),
  },
  handler: async (ctx, args) => {
    // Call the HMLR component's chat action
    const result = await ctx.runAction(components.hmlr.chat.sendMessage, {
      message: args.message,
      openaiApiKey: process.env.OPENAI_API_KEY!,
    });

    return result;
  },
});

export const searchMemories = action({
  args: {
    query: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.runAction(components.hmlr.chat.searchConversations, {
      query: args.query,
      openaiApiKey: process.env.OPENAI_API_KEY!,
      limit: 10,
    });
  },
});
