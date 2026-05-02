// Test-time stub for the published `hereya-cli` package. The real package is
// not bundled into the test environment — we only exercise the adapter
// boundary, not the resolver internals.
export const InfrastructureType = {
  aws: "aws",
  local: "local",
} as const;

export type InfrastructureTypeT = (typeof InfrastructureType)[keyof typeof InfrastructureType];

export const awsProviderFactory = () => ({});

export function registerInfrastructureProvider(
  _type: string,
  _factory: () => unknown
): void {}

export function resetInfrastructureProviders(): void {}

export function getInfrastructure(_input: { type: string }): {
  supported: false;
} {
  return { supported: false };
}

export type ResolveEnvValuesInput = {
  env: Record<string, string>;
  markSecret?: boolean;
  project?: string;
  workspace?: string;
};

export type ResolveEnvValuesOutput = Record<string, string>;

export async function resolveEnvValues(
  input: ResolveEnvValuesInput
): Promise<ResolveEnvValuesOutput> {
  // Trivial pass-through: a colon-prefixed `aws:foo` value becomes `RESOLVED:foo`.
  // Plain values are returned unchanged. This is enough to assert the handler
  // does the right thing without exercising AWS SDKs.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env)) {
    out[k] = v.startsWith("aws:") ? `RESOLVED:${v.slice(4)}` : v;
  }

  return out;
}

export async function resolveGithubAppMarkers<T>(resolved: T): Promise<T> {
  return resolved;
}
