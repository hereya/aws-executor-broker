# aws-executor-broker

Ephemeral remote-executor broker for a Hereya workspace, deployed into the customer's AWS account.

A broker Lambda receives signed webhooks from hereya-cloud for every executor job and either:

- **Resolves env values in-Lambda** (sub-second `resolve-env`, no EC2 cost).
- **Wakes a stopped EC2 executor** for heavyweight jobs (provision, deploy, destroy) and lets it shut itself down on idle.

The EC2 stays in `stopped` state when there's no work, so the workspace pays nothing for compute when idle.

## Resources created

- **OIDC identity provider** — issuer = `hereyaCloudUrl`, audience `sts.amazonaws.com`. Trust anchor for hereya-cloud's federated identity.
- **IAM role `HereyaBrokerInvoker-<workspaceId>`** — assumed by hereya-cloud via `sts:AssumeRoleWithWebIdentity`. Permission: `lambda:InvokeFunctionUrl` on the broker Lambda only.
- **Broker Lambda** (NodejsFunction, esbuild bundling) — Node 22, 512 MB, 25 s timeout, reserved concurrency configurable via `brokerConcurrency`. Handles webhook auth (KMS-signed JWT verification + DynamoDB jti replay block + body-hash binding), then either resolves env values or wakes the EC2.
- **Lambda Function URL** with `AuthType=AWS_IAM`. Only the invoker role can SigV4-sign calls.
- **DynamoDB tables** — `BrokerJtiCache` (jti replay block, TTL on `expiresAt`) and `WorkspaceWakeLock` (per-workspace wake dedup, TTL on `ttl`).
- **EC2 launch template** — Ubuntu 22.04, encrypted gp3 30 GB EBS, IMDSv2 enforced, shutdown-behaviour=`stop`. UserData installs `hereya-cli` and writes a systemd unit that redeems a single-use bootstrap JWT for a workspace token, then runs `hereya executor start`.
- **EC2 instance** — created via a CloudFormation custom resource, then immediately stopped so the first wake is fast (~30 s).
- **Executor instance role** — `AdministratorAccess` + SSM-managed-instance-core (mirrors the existing `hereya/remote-executor-aws`), plus a tightened SSM read/delete on the bootstrap parameter.

## Parameters

| Name | Required | Default | Notes |
|---|---|---|---|
| `workspaceId` | yes | — | Hereya workspace ID. Used in trust-policy `sub` and as a tag on EC2. |
| `workspaceName` | yes | — | Human-readable workspace name passed to `hereya executor start -w <name>`. |
| `hereyaCloudUrl` | yes | — | Hereya Cloud origin (e.g. `https://cloud.hereya.dev`). Used as OIDC issuer and as the API base for the broker Lambda. |
| `brokerConcurrency` | no | `50` | Reserved Lambda concurrency. |
| `ec2InstanceType` | no | `t3.medium` | EC2 instance type. |
| `idleTimeoutSeconds` | no | `600` | Executor idle-shutdown timeout. |

## Install

```bash
hereya add hereya/aws-executor-broker \
  --param workspaceId=<workspace-id> \
  --param workspaceName=<workspace-name> \
  --param hereyaCloudUrl=https://cloud.hereya.dev
```

The CLI's `hereya workspace executor install --mode=ephemeral` wraps this and POSTs the resulting outputs to hereya-cloud's `/api/workspaces/<name>/executor-broker`.

## Outputs

These are returned to hereya-cloud as the `metadata` blob on the `WorkspaceExecutorBroker` row:

| Name | Example |
|---|---|
| `brokerWebhookUrl` | `https://abc123.lambda-url.us-east-1.on.aws/` |
| `brokerVersion` | `0.1.0` |
| `awsAccountId` | `123456789012` |
| `region` | `us-east-1` |
| `ec2LaunchTemplateId` | `lt-abc` |
| `ec2InstanceId` | `i-abc` |
| `invokerRoleArn` | `arn:aws:iam::123456789012:role/HereyaBrokerInvoker-<workspaceId>` |
| `brokerLambdaArn` | `arn:aws:lambda:us-east-1:123456789012:function:...` |

## Coordination point with hereya-cloud (Wave 2a)

For the `resolve-env` job type, the Lambda does **not** call back to hereya-cloud to fetch the job's env-resolution payload — it has no workspace token and the broker JWT it received is scoped to a single jobId. Instead, hereya-cloud must inline the resolve-env payload (`{env, project?, workspace?, markSecret?}`) directly in the webhook body under `payload`:

```json
{
  "jobId": "...",
  "jobType": "resolve-env",
  "payload": { "env": { "DB_URL": "aws:db_url" }, "project": "...", "workspace": "..." }
}
```

If `payload` is missing the Lambda PATCHes the job `failed` and returns 400. Heavyweight job types do not require an inlined payload (the EC2 polls hereya-cloud for the full job spec once it boots).

## hereya-cli dependency

The Lambda imports `resolveEnvValues` from the published `hereya-cli` npm package. The new exports landed in Wave 1 but at the time of writing the new version of `hereya-cli` has not been published to npm yet. Until then:

- The package's `package.json` declares `"hereya-cli": "*"`. For local dev, `npm link hereya-cli` from a checked-out `hereya-platform/hereya-cli` worktree.
- `npm test` works against the in-tree stub at `test/stubs/hereya-cli.ts` (configured via `jest.config.js`).
- For real deploys this package needs to wait for `hereya-cli >= <next published version that exports resolveEnvValues + awsProviderFactory + registerInfrastructureProvider + resetInfrastructureProviders + InfrastructureType + getInfrastructure>`.

## Auth flow (request path)

1. hereya-cloud signs an OIDC ID token with KMS (claims: `sub: workspace:<id>`, `aud: sts.amazonaws.com`).
2. hereya-cloud calls `sts:AssumeRoleWithWebIdentity` against `HereyaBrokerInvoker-<workspaceId>` with `ExternalId = workspaceId` → 15-minute STS creds.
3. hereya-cloud SigV4-signs `POST <brokerWebhookUrl>` with those creds and includes a separate KMS-signed broker JWT in the `X-Hereya-Broker-Token` header.
4. AWS edge rejects unsigned requests at `403`. The Lambda then verifies the broker JWT (audience, jti, body hash, expiry) against hereya-cloud's JWKS.
5. The Lambda branches on `jobType`: resolve-env → resolve in-Lambda + PATCH job; heavyweight → acquire wake lock, mint bootstrap JWT, write to SSM, `StartInstances`.

## Development

```bash
npm install
npm run build
npm test
npx cdk synth -c workspaceId=test-ws -c workspaceName=test -c hereyaCloudUrl=https://cloud.hereya.dev
```
