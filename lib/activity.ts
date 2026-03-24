export type ActivityEntryPayload =
  | {
      kind: "skill";
      message: string;
      name: string;
    }
  | {
      kind: "summary";
      message: string;
    };

const SKILL_ACTIVITY_PATTERN =
  /^<activity type="skill" name="([^"]+)">([\s\S]*?)<\/activity>$/i;
const SUMMARY_ACTIVITY_PATTERN = /^<activity type="summary">([\s\S]*?)<\/activity>$/i;

export function parseActivityMarker(line: string): ActivityEntryPayload | null {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  const skillMatch = trimmed.match(SKILL_ACTIVITY_PATTERN);

  if (skillMatch) {
    return {
      kind: "skill",
      name: skillMatch[1].trim(),
      message: skillMatch[2].trim(),
    };
  }

  const summaryMatch = trimmed.match(SUMMARY_ACTIVITY_PATTERN);

  if (summaryMatch) {
    return {
      kind: "summary",
      message: summaryMatch[1].trim(),
    };
  }

  return null;
}

export function stripActivityMarkers(text: string) {
  const lines = text.split(/\r?\n/);
  const visibleLines: string[] = [];

  for (const line of lines) {
    if (parseActivityMarker(line)) {
      continue;
    }

    visibleLines.push(line);
  }

  return visibleLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function summarizeCommand(commands: string[]) {
  const command = commands.join(" && ").trim();

  if (!command) {
    return "Running shell command";
  }

  if (command.length <= 120) {
    return command;
  }

  return `${command.slice(0, 117)}...`;
}
