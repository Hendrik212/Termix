import React, { useRef, useEffect } from "react";
import { Terminal } from "./Terminal";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

interface SplitViewSession {
  sessionId: string;
  hostConfig: any;
  title?: string;
}

interface SplitViewLayoutProps {
  layout: "horizontal" | "vertical" | "grid";
  sessions: SplitViewSession[];
  onSessionClose?: (sessionId: string) => void;
  onSessionCreated?: (sessionId: string, index: number) => void;
}

export function SplitViewLayout({
  layout,
  sessions,
  onSessionClose,
  onSessionCreated,
}: SplitViewLayoutProps) {
  const terminalRefs = useRef<Map<string, any>>(new Map());

  useEffect(() => {
    const handleResize = () => {
      terminalRefs.current.forEach((ref) => {
        if (ref?.notifyResize) {
          ref.notifyResize();
        }
      });
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const renderTerminal = (session: SplitViewSession, index: number) => (
    <div className="h-full w-full relative" key={session.sessionId || `new-${index}`}>
      <Terminal
        ref={(ref) => {
          if (ref && session.sessionId) {
            terminalRefs.current.set(session.sessionId, ref);
          }
        }}
        hostConfig={session.hostConfig}
        isVisible={true}
        splitScreen={true}
        sessionId={session.sessionId}
        onSessionCreated={(newSessionId) => {
          if (onSessionCreated) {
            onSessionCreated(newSessionId, index);
          }
        }}
        onClose={() => {
          if (onSessionClose && session.sessionId) {
            onSessionClose(session.sessionId);
          }
        }}
        title={session.title}
      />
    </div>
  );

  if (layout === "grid" && sessions.length === 4) {
    return (
      <div className="h-full w-full">
        <ResizablePanelGroup direction="vertical">
          <ResizablePanel defaultSize={50}>
            <ResizablePanelGroup direction="horizontal">
              <ResizablePanel defaultSize={50}>
                {renderTerminal(sessions[0], 0)}
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize={50}>
                {renderTerminal(sessions[1], 1)}
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={50}>
            <ResizablePanelGroup direction="horizontal">
              <ResizablePanel defaultSize={50}>
                {renderTerminal(sessions[2], 2)}
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize={50}>
                {renderTerminal(sessions[3], 3)}
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    );
  }

  if (layout === "horizontal" && sessions.length === 2) {
    return (
      <div className="h-full w-full">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={50}>
            {renderTerminal(sessions[0], 0)}
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={50}>
            {renderTerminal(sessions[1], 1)}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    );
  }

  if (layout === "vertical" && sessions.length === 2) {
    return (
      <div className="h-full w-full">
        <ResizablePanelGroup direction="vertical">
          <ResizablePanel defaultSize={50}>
            {renderTerminal(sessions[0], 0)}
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={50}>
            {renderTerminal(sessions[1], 1)}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      {sessions[0] && renderTerminal(sessions[0], 0)}
    </div>
  );
}
