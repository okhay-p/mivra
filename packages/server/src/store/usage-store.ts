import { desc, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { usageRecords } from "../db/schema.js";
import type { UsageRow } from "../usage/accounting.js";

export type UsageRecordInput = typeof usageRecords.$inferInsert;

/** Usage records (issue #70). Like the other stores, the only code here that talks to Drizzle (ADR-007). */
export function createUsageStore(db: Db) {
  return {
    insert(record: UsageRecordInput) {
      // A call is recorded once; the same id again (it can't happen today) is ignored rather than counted twice.
      db.insert(usageRecords).values(record).onConflictDoNothing().run();
    },
    /** Calls that started at or after `from` (every call without it), newest first. */
    list(from?: Date): UsageRow[] {
      return db
        .select({
          id: usageRecords.id,
          kind: usageRecords.kind,
          status: usageRecords.status,
          sessionId: usageRecords.sessionId,
          runId: usageRecords.runId,
          provider: usageRecords.provider,
          providerLabel: usageRecords.providerLabel,
          model: usageRecords.model,
          modelLabel: usageRecords.modelLabel,
          billing: usageRecords.billing,
          inputTokens: usageRecords.inputTokens,
          inputCacheReadTokens: usageRecords.inputCacheReadTokens,
          inputCacheWriteTokens: usageRecords.inputCacheWriteTokens,
          outputTokens: usageRecords.outputTokens,
          outputReasoningTokens: usageRecords.outputReasoningTokens,
          reportedCost: usageRecords.reportedCost,
          estimatedCost: usageRecords.estimatedCost,
          startedAt: usageRecords.startedAt,
        })
        .from(usageRecords)
        .where(from ? gte(usageRecords.startedAt, from) : undefined)
        .orderBy(desc(usageRecords.startedAt), desc(usageRecords.endedAt))
        .all();
    },
    /** The time of the oldest record, so the page can say since when usage has been counted. */
    oldest(): Date | undefined {
      return db.select({ at: usageRecords.startedAt }).from(usageRecords).orderBy(usageRecords.startedAt).limit(1).get()?.at;
    },
    /** Deletes every usage record. Conversations, runs and provider settings are untouched. */
    clear(): number {
      return db.delete(usageRecords).run().changes;
    },
  };
}

export type UsageStore = ReturnType<typeof createUsageStore>;
