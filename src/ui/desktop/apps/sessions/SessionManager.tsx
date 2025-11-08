import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import axios from "axios";
import { toast } from "sonner";
import { Terminal, Trash2, RefreshCw, Users, Clock } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Session {
  id: string;
  sessionName?: string;
  hostConfig: {
    id?: number;
    ip: string;
    port: number;
    username: string;
    name?: string;
  };
  createdAt: string;
  lastAccessedAt: string;
  connectedClients: number;
  status: string;
}

interface SessionManagerProps {
  onSessionSelect?: (sessionId: string, hostConfig: any) => void;
}

export function SessionManager({ onSessionSelect }: SessionManagerProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchSessions = async () => {
    try {
      setRefreshing(true);
      const response = await axios.get("/sessions");
      setSessions(response.data);
    } catch (error) {
      console.error("Failed to fetch sessions:", error);
      toast.error(t("sessions.fetchError"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleTerminateSession = async (sessionId: string) => {
    try {
      await axios.delete(`/sessions/${sessionId}`);
      toast.success(t("sessions.terminated"));
      fetchSessions();
    } catch (error) {
      console.error("Failed to terminate session:", error);
      toast.error(t("sessions.terminateError"));
    }
  };

  const handleConnectToSession = (session: Session) => {
    if (onSessionSelect) {
      onSessionSelect(session.id, session.hostConfig);
    } else {
      const hostname =
        session.hostConfig.name ||
        `${session.hostConfig.username}@${session.hostConfig.ip}`;
      navigate(`/session/${session.id}?host=${encodeURIComponent(hostname)}`);
    }
  };

  const formatRelativeTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">Loading sessions...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Active Sessions</h2>
          <p className="text-sm text-muted-foreground">
            {sessions.length} active session{sessions.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchSessions}
          disabled={refreshing}
        >
          <RefreshCw
            className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-4">
          {sessions.length === 0 ? (
            <Card className="p-8 text-center">
              <Terminal className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
              <h3 className="text-lg font-semibold mb-2">No Active Sessions</h3>
              <p className="text-sm text-muted-foreground">
                Create a new terminal session to get started
              </p>
            </Card>
          ) : (
            sessions.map((session) => (
              <Card
                key={session.id}
                className="p-4 hover:bg-accent/50 transition-colors cursor-pointer"
                onClick={() => handleConnectToSession(session)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <Terminal className="w-5 h-5 text-primary" />
                      <h3 className="font-semibold">
                        {session.sessionName ||
                          session.hostConfig.name ||
                          `${session.hostConfig.username}@${session.hostConfig.ip}`}
                      </h3>
                    </div>

                    <div className="space-y-1 text-sm text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">
                          {session.hostConfig.ip}:{session.hostConfig.port}
                        </span>
                      </div>

                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-1">
                          <Users className="w-4 h-4" />
                          <span>
                            {session.connectedClients} client
                            {session.connectedClients !== 1 ? "s" : ""}
                          </span>
                        </div>

                        <div className="flex items-center gap-1">
                          <Clock className="w-4 h-4" />
                          <span>{formatRelativeTime(session.lastAccessedAt)}</span>
                        </div>
                      </div>

                      <div className="text-xs">
                        <span className="text-muted-foreground">Session ID:</span>{" "}
                        <span className="font-mono">{session.id.slice(0, 8)}...</span>
                      </div>
                    </div>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTerminateSession(session.id);
                    }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </Card>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
