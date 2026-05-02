import { createHash } from "node:crypto";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { EC2Client, DescribeInstancesCommand, StartInstancesCommand } from "@aws-sdk/client-ec2";
import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";

import { verifyBrokerJwt } from "./verify-jwt";
import { acquireWakeLock } from "./wake-lock";
import { resolveEnvForJob } from "./resolve-env-adapter";

const HEREYA_CLOUD_URL = requireEnv("HEREYA_CLOUD_URL");
const WORKSPACE_ID = requireEnv("WORKSPACE_ID");
const WORKSPACE_NAME = requireEnv("WORKSPACE_NAME");
const JTI_CACHE_TABLE = requireEnv("JTI_CACHE_TABLE");
const WAKE_LOCK_TABLE = requireEnv("WAKE_LOCK_TABLE");
const EC2_INSTANCE_ID = requireEnv("EC2_INSTANCE_ID");
const EXPECTED_BROKER_AUD = requireEnv("EXPECTED_BROKER_AUD");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ec2 = new EC2Client({});
const ssm = new SSMClient({});

interface BrokerWebhookBody {
  jobId?: string;
  jobType?: string;
  payload?: Record<string, unknown>;
}

export async function handler(
  event: LambdaFunctionURLEvent
): Promise<LambdaFunctionURLResult> {
  try {
    const rawBody = readRawBody(event);
    const token = readBrokerToken(event);
    if (!token) {
      return jsonResponse(401, { error: "missing X-Hereya-Broker-Token" });
    }

    const claims = await verifyBrokerJwt(token, {
      jwksUrl: `${HEREYA_CLOUD_URL}/.well-known/jwks.json`,
      expectedAud: EXPECTED_BROKER_AUD,
      rawBody,
    });

    // Replay protection — Dynamo conditional write.
    const replayed = await tryRecordJti(claims.jti, claims.exp);
    if (replayed) {
      return jsonResponse(401, { error: "replay" });
    }

    let body: BrokerWebhookBody = {};
    try {
      body = rawBody ? (JSON.parse(rawBody) as BrokerWebhookBody) : {};
    } catch {
      return jsonResponse(400, { error: "invalid JSON body" });
    }

    const jobId = body.jobId ?? claims.jobId;
    const jobType = body.jobType ?? claims.jobType;
    if (!jobId || !jobType) {
      return jsonResponse(400, { error: "missing jobId/jobType" });
    }

    if (jobType === "resolve-env") {
      return await handleResolveEnv({ jobId, body, token });
    }

    return await handleHeavyweight({ jobId, jobType, token });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("jwt:")) {
      return jsonResponse(401, { error: message });
    }

    console.error("broker.handler.error", { message });
    return jsonResponse(500, { error: "internal" });
  }
}

async function handleResolveEnv(input: {
  jobId: string;
  body: BrokerWebhookBody;
  token: string;
}): Promise<LambdaFunctionURLResult> {
  // The handler expects hereya-cloud to inline the resolve-env payload in the
  // webhook body (see README "Coordination point with Wave 2a"). The Lambda
  // does not call back to hereya-cloud to fetch it because it has no workspace
  // token — only the broker JWT, which is scoped to a single jobId.
  if (!input.body.payload) {
    await patchJobFailed(
      input.jobId,
      "resolve-env webhook missing payload (hereya-cloud must inline it)",
      input.token
    );
    return jsonResponse(400, {
      error: "resolve-env webhook missing payload",
    });
  }

  try {
    const env = await resolveEnvForJob(input.body.payload);
    await patchJobCompleted(input.jobId, { env }, input.token);
    return jsonResponse(200, { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await patchJobFailed(input.jobId, message, input.token);
    return jsonResponse(500, { error: message });
  }
}

async function handleHeavyweight(input: {
  jobId: string;
  jobType: string;
  token: string;
}): Promise<LambdaFunctionURLResult> {
  const acquired = await acquireWakeLock({
    ddb,
    tableName: WAKE_LOCK_TABLE,
    workspaceId: WORKSPACE_ID,
    ttlSeconds: 180,
  });
  if (!acquired) {
    return jsonResponse(202, { status: "wake-in-progress" });
  }

  // Check current EC2 state. If running/pending we just no-op — the executor
  // will pick up the queued job on its next poll.
  const desc = await ec2.send(
    new DescribeInstancesCommand({ InstanceIds: [EC2_INSTANCE_ID] })
  );
  const reservation = desc.Reservations?.[0];
  const instance = reservation?.Instances?.[0];
  const stateName = instance?.State?.Name ?? "unknown";
  if (stateName === "running" || stateName === "pending") {
    return jsonResponse(202, { status: "running" });
  }

  // Mint a single-use bootstrap JWT via hereya-cloud, then drop it in SSM
  // SecureString at /hereya/bootstrap/<instanceId>.
  const bootstrapResp = await fetch(
    `${HEREYA_CLOUD_URL}/api/workspaces/${encodeURIComponent(
      WORKSPACE_NAME
    )}/executor-token/bootstrap`,
    {
      method: "POST",
      headers: {
        "X-Hereya-Broker-Token": input.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jobId: input.jobId, jobType: input.jobType }),
    }
  );
  if (!bootstrapResp.ok) {
    const text = await bootstrapResp.text();
    throw new Error(
      `bootstrap mint failed (${bootstrapResp.status}): ${text}`
    );
  }
  const bootstrap = (await bootstrapResp.json()) as { token: string };

  await ssm.send(
    new PutParameterCommand({
      Name: `/hereya/bootstrap/${EC2_INSTANCE_ID}`,
      Value: bootstrap.token,
      Type: "SecureString",
      Overwrite: true,
    })
  );

  await ec2.send(
    new StartInstancesCommand({ InstanceIds: [EC2_INSTANCE_ID] })
  );

  return jsonResponse(202, { status: "starting" });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} environment variable is required`);
  }
  return v;
}

function readRawBody(event: LambdaFunctionURLEvent): string {
  if (!event.body) return "";
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, "base64").toString("utf8");
  }
  return event.body;
}

function readBrokerToken(event: LambdaFunctionURLEvent): string | undefined {
  const headers = event.headers ?? {};
  // Lambda Function URL events always lower-case header keys.
  return (
    headers["x-hereya-broker-token"] ??
    headers["X-Hereya-Broker-Token"] ??
    undefined
  );
}

function jsonResponse(
  statusCode: number,
  body: unknown
): LambdaFunctionURLResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function tryRecordJti(jti: string, exp: number): Promise<boolean> {
  // returns true if it's a replay (already recorded), false if first-seen
  const expiresAt = exp + 60; // 60 s slack past JWT exp
  try {
    await ddb.send(
      new PutCommand({
        TableName: JTI_CACHE_TABLE,
        Item: { jti, expiresAt },
        ConditionExpression: "attribute_not_exists(jti)",
      })
    );
    return false;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "ConditionalCheckFailedException") {
      return true;
    }

    throw err;
  }
}

async function patchJobCompleted(
  jobId: string,
  result: Record<string, unknown>,
  token: string
): Promise<void> {
  const resp = await fetch(
    `${HEREYA_CLOUD_URL}/api/executor/jobs/${encodeURIComponent(jobId)}`,
    {
      method: "PATCH",
      headers: {
        "X-Hereya-Broker-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "completed", result }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`patch completed failed (${resp.status}): ${text}`);
  }
}

async function patchJobFailed(
  jobId: string,
  message: string,
  token: string
): Promise<void> {
  try {
    await fetch(
      `${HEREYA_CLOUD_URL}/api/executor/jobs/${encodeURIComponent(jobId)}`,
      {
        method: "PATCH",
        headers: {
          "X-Hereya-Broker-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "failed", error: message }),
      }
    );
  } catch (err) {
    console.error("broker.patch_failed.error", err);
  }
}

// `createHash` is referenced through verify-jwt.ts; importing here keeps
// node:crypto resolved when the bundler tree-shakes.
void createHash;
