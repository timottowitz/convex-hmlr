import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Daily Synthesis - Run at end of day (11:59 PM UTC)
 * Generates day synthesis for the previous day's conversations
 */
crons.daily(
  "daily-synthesis",
  { hourUTC: 23, minuteUTC: 59 },
  internal.synthesis.triggerDaySynthesis
);

/**
 * Weekly Synthesis - Run on Sundays (11:00 PM UTC)
 * Generates week synthesis aggregating daily patterns
 */
crons.weekly(
  "weekly-synthesis",
  { dayOfWeek: "sunday", hourUTC: 23, minuteUTC: 0 },
  internal.synthesis.triggerWeekSynthesis
);

export default crons;
