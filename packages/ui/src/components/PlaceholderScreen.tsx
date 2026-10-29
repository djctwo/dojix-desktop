import type { ReactNode } from "react";
import { Construction } from "lucide-react";
import { Screen } from "../shell/Screen";
import { EmptyState } from "../states/States";

export interface PlaceholderScreenProps {
  title: string;
  /** Which team builds it, or what it will show. */
  message?: ReactNode | undefined;
  children?: ReactNode | undefined;
}

/** Stand-in for screens that later phases build: the screen frame and an empty state. */
export function PlaceholderScreen({ title, message, children }: PlaceholderScreenProps) {
  return (
    <Screen title={title}>
      {children}
      <EmptyState
        testId="screen-placeholder"
        icon={<Construction size={44} strokeWidth={1.5} />}
        title="Not built yet"
        message={message ?? "This screen arrives in a later build of the Windows and Linux edition."}
      />
    </Screen>
  );
}
