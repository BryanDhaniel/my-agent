import { Box, Text } from "ink";
import React from "react";
import type { LoadedSession, SessionStore } from "../session/store.js";

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function SessionBrowser({
  sessions,
  currentId,
  selected,
}: {
  sessions: LoadedSession[];
  currentId: string;
  selected: number;
}): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column">
      <Text bold color="blue">
        sessions{" "}
        <Text dimColor>↑/↓ select · s switch · d delete · esc close</Text>
      </Text>
      {sessions.length === 0 ? (
        <Text dimColor> no sessions yet</Text>
      ) : (
        sessions.map((session, i) => (
          <Box key={session.meta.id}>
            <Text
              color={i === selected ? "blue" : undefined}
              inverse={i === selected}
            >
              {i === selected ? "▸ " : "  "}
              {session.meta.id === currentId ? "● " : "  "}
              {session.meta.id} · {session.meta.provider}/{session.meta.model} ·{" "}
              {session.messages.length} msgs · {timeAgo(session.meta.createdAt)}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}

export async function loadSessions(
  store: SessionStore,
): Promise<LoadedSession[]> {
  return store.list();
}
