import {
  awsProviderFactory,
  registerInfrastructureProvider,
  resetInfrastructureProviders,
  resolveEnvValues,
  getInfrastructure,
  InfrastructureType,
  type ResolveEnvValuesInput,
  type ResolveEnvValuesOutput,
} from "hereya-cli";

let registered = false;

/**
 * Lazily wire only the AWS infrastructure provider into the registry — we do
 * NOT want the `local` provider (filesystem, exec) inside a Lambda. Idempotent
 * across warm invocations.
 */
function ensureProvidersRegistered(): void {
  if (registered) return;
  resetInfrastructureProviders();
  registerInfrastructureProvider(InfrastructureType.aws, awsProviderFactory);
  registered = true;
}

/**
 * Adapter between the broker webhook payload and the published `resolveEnvValues`
 * helper from `hereya-cli`. The webhook payload mirrors what hereya-cloud
 * stores on the ExecutorJob row — shape:
 *   { env: {[k]: string}, project?: string, workspace?: string, markSecret?: boolean }
 *
 * Returns the resolved env map. GitHub-app marker support is intentionally not
 * wired here (the Lambda has no PersonalToken to call hereya-cloud's workspace
 * env API) — those values pass through unresolved if any sneak in. The plan
 * notes this as future work; for v1 the cloud only routes pure resolve-env
 * jobs (no github-app markers) to the broker path.
 */
export async function resolveEnvForJob(
  payload: Record<string, unknown>
): Promise<ResolveEnvValuesOutput> {
  ensureProvidersRegistered();

  const env = (payload.env ?? {}) as Record<string, string>;
  if (typeof env !== "object" || env === null) {
    throw new Error("payload.env must be an object");
  }

  const input: ResolveEnvValuesInput = {
    env,
    markSecret: Boolean(payload.markSecret),
    project:
      typeof payload.project === "string" ? payload.project : undefined,
    workspace:
      typeof payload.workspace === "string" ? payload.workspace : undefined,
  };

  return resolveEnvValues(input, {
    getInfrastructure,
  });
}
