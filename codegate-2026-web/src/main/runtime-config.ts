export const RUNTIME_CONFIG_NAMES = [
  'CODEGATE_AUTH_MODE',
  'CODEGATE_CLOUD_API_URL',
  'CODEGATE_BACKEND_URL',
] as const;

export type RuntimeConfigName = (typeof RUNTIME_CONFIG_NAMES)[number];
export type EmbeddedRuntimeConfig = Partial<Record<RuntimeConfigName, string>>;

declare const __CODEGATE_RUNTIME_CONFIG__: EmbeddedRuntimeConfig | undefined;

const embeddedRuntimeConfig: EmbeddedRuntimeConfig =
  typeof __CODEGATE_RUNTIME_CONFIG__ === 'undefined' ? {} : __CODEGATE_RUNTIME_CONFIG__;

export function runtimeConfig(
  name: RuntimeConfigName,
  environment: NodeJS.ProcessEnv = process.env,
  embedded: EmbeddedRuntimeConfig = embeddedRuntimeConfig,
): string | undefined {
  return environment[name] || embedded[name];
}
