export interface CliFlags {
  provider?: string;
  model?: string;
  sessionId?: string;
  continueLast: boolean;
  yolo: boolean;
  debug: boolean;
  help: boolean;
}

const USAGE = `my-agent — a hand-rolled terminal coding agent

Usage: my-agent [flags]

Flags:
  --provider <name>   LLM provider: openai | anthropic | gemini | glm (default: openai)
  --model <id>        Model id override (default depends on provider)
  --continue          Resume the most recent session
  --session <id>      Resume a specific session by id
  --yolo              Auto-approve mutating tools (no permission prompts)
  --debug              Verbose execution logs (run ids, timings, retries)
  --help              Show this help
`;

export function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    continueLast: false,
    yolo: false,
    debug: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--provider": {
        const value = argv[++i];
        if (!value) throw new Error("--provider requires a value");
        flags.provider = value;
        break;
      }
      case "--model": {
        const value = argv[++i];
        if (!value) throw new Error("--model requires a value");
        flags.model = value;
        break;
      }
      case "--session": {
        const value = argv[++i];
        if (!value) throw new Error("--session requires a value");
        flags.sessionId = value;
        break;
      }
      case "--continue":
        flags.continueLast = true;
        break;
      case "--yolo":
        flags.yolo = true;
        break;
      case "--debug":
        flags.debug = true;
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}\n\n${USAGE}`);
    }
  }

  return flags;
}

export { USAGE };
