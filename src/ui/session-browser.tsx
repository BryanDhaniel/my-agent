import { Box, Text } from "ink";
import React from "react";
import type { LoadedSession, SessionStore } from "../session/store.js";
import { Rule } from "./ink.js";
import { INK, MARK, SPACE, label } from "./theme.js";

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
    <Box flexDirection="column" marginY={1}>
      <Rule weight="heavy" />
      <Box marginLeft={SPACE.contentIndent}>
        <Text>
          <Text {...INK.strong}>{label("sessions")} </Text>
          <Text {...INK.ghost}>↑/↓ select · s switch · d delete · esc close</Text>
        </Text>
      </Box>
      {sessions.length === 0 ? (
        <Box marginLeft={SPACE.contentIndent}>
          <Text {...INK.ghost}>no sessions yet</Text>
        </Box>
      ) : (
        sessions.map((session, i) => {
          const isSelected = i === selected;
          const isCurrent = session.meta.id === currentId;
          return (
            <Box key={session.meta.id} marginLeft={SPACE.contentIndent}>
              <Text inverse={isSelected}>
                {isSelected ? "▸ " : "  "}
                <Text {...(isCurrent ? INK.body : INK.faint)}>
                  {isCurrent ? MARK.sessionCurrent : MARK.sessionOther}{" "}
                </Text>
                {session.meta.id}
                <Text {...INK.ghost}>
                  {" "}
                  · {session.meta.provider}/{session.meta.model} ·{" "}
                  {session.messages.length} msgs · {timeAgo(session.meta.createdAt)}
                </Text>
              </Text>
            </Box>
          );
        })
      )}
      <Rule weight="light" />
    </Box>
  );
}

export async function loadSessions(
  store: SessionStore,
): Promise<LoadedSession[]> {
  return store.list();
}
