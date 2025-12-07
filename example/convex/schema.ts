import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Example app schema - your app's tables go here
export default defineSchema({
  // Example: Legal firm tables
  cases: defineTable({
    title: v.string(),
    clientName: v.string(),
    status: v.string(),
  }),
});
