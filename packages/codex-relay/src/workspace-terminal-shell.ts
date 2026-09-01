export type WorkspaceTerminalShell = {
  readonly args: readonly string[];
  readonly command: string;
};

export function resolveWorkspaceTerminalShell(input?: {
  readonly env?: Partial<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform;
}): WorkspaceTerminalShell {
  const env = input?.env ?? process.env;
  const platform = input?.platform ?? process.platform;

  if (platform === "win32") {
    const command = shellEnvValue(env.COMSPEC);
    return {
      args: [],
      command: command || "powershell.exe",
    };
  }

  const command = shellEnvValue(env.SHELL);
  return {
    args: ["-l"],
    command: command || "/bin/sh",
  };
}

function shellEnvValue(value: string | undefined) {
  return value?.trim() ?? "";
}
