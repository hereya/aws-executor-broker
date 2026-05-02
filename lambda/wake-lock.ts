import {
  type DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

interface AcquireOpts {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  workspaceId: string;
  ttlSeconds: number;
}

/**
 * Acquire the per-workspace wake lock. Returns true if this caller won the
 * race, false if another in-flight Lambda already holds it. We use a
 * conditional PutItem so contention is resolved atomically by Dynamo —
 * no scans, no read-then-write windows.
 */
export async function acquireWakeLock(opts: AcquireOpts): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = now + opts.ttlSeconds;
  try {
    await opts.ddb.send(
      new PutCommand({
        TableName: opts.tableName,
        Item: { workspaceId: opts.workspaceId, ttl, acquiredAt: now },
        // Acquire iff the row is missing OR its ttl has expired (a previous
        // Lambda crashed mid-wake without cleaning up).
        ConditionExpression:
          "attribute_not_exists(workspaceId) OR #t < :now",
        ExpressionAttributeNames: { "#t": "ttl" },
        ExpressionAttributeValues: { ":now": now },
      })
    );
    return true;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "ConditionalCheckFailedException") {
      return false;
    }

    throw err;
  }
}
