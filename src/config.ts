function getEnvVar(name: string, required = true): string {
  const value = process.env[name];
  if (required && !value) {
    throw new Error(`${name} environment variable is required but not set`);
  }
  return value || "";
}

type SharedConfig = {
  mintUrl: string;
  relayUrl: string;
};

function getSharedConfig(): SharedConfig {
  return {
    mintUrl: getEnvVar("MINT_URL"),
    relayUrl: getEnvVar("RELAY_URL"),
  };
}

export type AliceConfig = SharedConfig & {
  mnemonic: string;
};

export function getAliceConfig(): AliceConfig {
  return {
    ...getSharedConfig(),
    mnemonic: getEnvVar("ALICE_MNEMONIC"),
  };
}

export type GatewayConfig = SharedConfig & {
  mnemonic: string;
  nwcUri: string;
};

export function getGatewayConfig(): GatewayConfig {
  return {
    ...getSharedConfig(),
    mnemonic: getEnvVar("GATEWAY_MNEMONIC"),
    nwcUri: getEnvVar("NWC_URI"),
  };
}

export type DealerConfig = SharedConfig & {
  mnemonic: string;
};

export function getDealerConfig(): DealerConfig {
  return {
    ...getSharedConfig(),
    mnemonic: getEnvVar("DEALER_MNEMONIC"),
  };
}

export type LoggerConfig = {
  logLevel?: string;
};

export function getLoggerConfig(): LoggerConfig {
  return {
    logLevel: getEnvVar("LOG_LEVEL", false) || undefined,
  };
}
