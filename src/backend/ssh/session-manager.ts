import { WebSocket } from "ws";
import { Client, type ClientChannel } from "ssh2";
import { randomUUID } from "crypto";
import { getDb } from "../database/db/index.js";
import { terminalSessions } from "../database/db/schema.js";
import { eq, and } from "drizzle-orm";
import { sshLogger } from "../utils/logger.js";

interface HostConfig {
  id?: number;
  ip: string;
  port: number;
  username: string;
  password?: string;
  key?: string;
  keyPassword?: string;
  keyType?: string;
  authType?: string;
  credentialId?: number;
  userId?: string;
  forceKeyboardInteractive?: boolean;
  [key: string]: unknown;
}

interface TerminalSession {
  id: string;
  userId: string;
  hostConfig: HostConfig;
  sessionName?: string;
  sshConnection: Client | null;
  sshStream: ClientChannel | null;
  scrollbackBuffer: string[];
  connectedClients: Set<WebSocket>;
  createdAt: Date;
  lastAccessedAt: Date;
  status: "active" | "terminated";
  currentDirectory?: string;
  pendingData: Buffer[];
  keyboardInteractiveCallback: ((responses: string[]) => void) | null;
}

const MAX_SCROLLBACK_LINES = 10000;

export class SessionManager {
  private static instance: SessionManager;
  private sessions: Map<string, TerminalSession> = new Map();
  private savePending: Set<string> = new Set();
  private saveTimer: NodeJS.Timeout | null = null;

  private constructor() {
    this.startPeriodicSave();
  }

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * Create a new terminal session
   */
  async createSession(
    userId: string,
    hostConfig: HostConfig,
    sessionName?: string,
  ): Promise<string> {
    const sessionId = randomUUID();
    const now = new Date();

    const session: TerminalSession = {
      id: sessionId,
      userId,
      hostConfig,
      sessionName,
      sshConnection: null,
      sshStream: null,
      scrollbackBuffer: [],
      connectedClients: new Set(),
      createdAt: now,
      lastAccessedAt: now,
      status: "active",
      pendingData: [],
      keyboardInteractiveCallback: null,
    };

    this.sessions.set(sessionId, session);

    try {
      const db = getDb();
      await db.insert(terminalSessions).values({
        id: sessionId,
        userId,
        hostId: hostConfig.id,
        hostConfig: JSON.stringify(hostConfig),
        sessionName,
        createdAt: now.toISOString(),
        lastAccessedAt: now.toISOString(),
        status: "active",
        connectedClients: 0,
      });

      sshLogger.info("Created new terminal session", {
        operation: "session_create",
        sessionId,
        userId,
        hostId: hostConfig.id,
      });
    } catch (error) {
      sshLogger.error("Failed to save session to database", error, {
        operation: "session_create_db_error",
        sessionId,
        userId,
      });
    }

    return sessionId;
  }

  /**
   * Get all sessions for a user
   */
  async getUserSessions(userId: string): Promise<
    Array<{
      id: string;
      sessionName?: string;
      hostConfig: HostConfig;
      createdAt: string;
      lastAccessedAt: string;
      connectedClients: number;
      status: string;
    }>
  > {
    const db = getDb();
    const dbSessions = await db
      .select()
      .from(terminalSessions)
      .where(
        and(
          eq(terminalSessions.userId, userId),
          eq(terminalSessions.status, "active"),
        ),
      );

    return dbSessions.map((s) => ({
      id: s.id,
      sessionName: s.sessionName || undefined,
      hostConfig: JSON.parse(s.hostConfig) as HostConfig,
      createdAt: s.createdAt,
      lastAccessedAt: s.lastAccessedAt,
      connectedClients: this.sessions.get(s.id)?.connectedClients.size || 0,
      status: s.status,
    }));
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Attach a WebSocket client to a session
   */
  async attachClient(
    sessionId: string,
    ws: WebSocket,
    userId: string,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      const dbSession = await this.loadSessionFromDB(sessionId, userId);
      if (!dbSession) {
        return false;
      }
    }

    const loadedSession = this.sessions.get(sessionId)!;

    if (loadedSession.userId !== userId) {
      sshLogger.warn("Unauthorized session access attempt", {
        operation: "session_attach_unauthorized",
        sessionId,
        userId,
        sessionOwner: loadedSession.userId,
      });
      return false;
    }

    loadedSession.connectedClients.add(ws);
    loadedSession.lastAccessedAt = new Date();

    this.scheduleSessionSave(sessionId);

    sshLogger.info("Client attached to session", {
      operation: "session_attach",
      sessionId,
      userId,
      totalClients: loadedSession.connectedClients.size,
    });

    return true;
  }

  /**
   * Detach a WebSocket client from a session
   */
  detachClient(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.connectedClients.delete(ws);

    sshLogger.info("Client detached from session", {
      operation: "session_detach",
      sessionId,
      remainingClients: session.connectedClients.size,
    });

    this.scheduleSessionSave(sessionId);
  }

  /**
   * Set SSH connection for a session
   */
  setSSHConnection(
    sessionId: string,
    connection: Client,
    stream: ClientChannel,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.sshConnection = connection;
    session.sshStream = stream;

    sshLogger.info("SSH connection established for session", {
      operation: "session_ssh_connected",
      sessionId,
    });
  }

  /**
   * Add data to scrollback buffer
   */
  addToScrollback(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.scrollbackBuffer.push(data);

    if (session.scrollbackBuffer.length > MAX_SCROLLBACK_LINES) {
      session.scrollbackBuffer = session.scrollbackBuffer.slice(
        -MAX_SCROLLBACK_LINES,
      );
    }

    this.scheduleSessionSave(sessionId);
  }

  /**
   * Get scrollback buffer for a session
   */
  getScrollback(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return session?.scrollbackBuffer || [];
  }

  /**
   * Broadcast data to all connected clients of a session
   */
  broadcastToSession(sessionId: string, message: any): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const messageStr =
      typeof message === "string" ? message : JSON.stringify(message);

    session.connectedClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    });
  }

  /**
   * Terminate a session
   */
  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.sshStream) {
      try {
        session.sshStream.end();
      } catch (e) {
        sshLogger.error("Error closing SSH stream", e, {
          operation: "session_terminate",
          sessionId,
        });
      }
    }

    if (session.sshConnection) {
      try {
        session.sshConnection.end();
      } catch (e) {
        sshLogger.error("Error closing SSH connection", e, {
          operation: "session_terminate",
          sessionId,
        });
      }
    }

    session.connectedClients.forEach((ws) => {
      try {
        ws.send(
          JSON.stringify({
            type: "session_terminated",
            message: "Session has been terminated",
          }),
        );
        ws.close();
      } catch (e) {}
    });

    session.status = "terminated";

    try {
      const db = getDb();
      await db
        .update(terminalSessions)
        .set({ status: "terminated" })
        .where(eq(terminalSessions.id, sessionId));
    } catch (error) {
      sshLogger.error("Failed to update session status in database", error, {
        operation: "session_terminate_db_error",
        sessionId,
      });
    }

    this.sessions.delete(sessionId);

    sshLogger.info("Session terminated", {
      operation: "session_terminate",
      sessionId,
    });
  }

  /**
   * Load a session from database
   */
  private async loadSessionFromDB(
    sessionId: string,
    userId: string,
  ): Promise<TerminalSession | null> {
    try {
      const db = getDb();
      const dbSessions = await db
        .select()
        .from(terminalSessions)
        .where(
          and(
            eq(terminalSessions.id, sessionId),
            eq(terminalSessions.userId, userId),
            eq(terminalSessions.status, "active"),
          ),
        )
        .limit(1);

      if (dbSessions.length === 0) {
        return null;
      }

      const dbSession = dbSessions[0];
      const hostConfig = JSON.parse(dbSession.hostConfig) as HostConfig;

      let scrollbackBuffer: string[] = [];
      if (dbSession.scrollbackBuffer) {
        try {
          scrollbackBuffer = JSON.parse(dbSession.scrollbackBuffer);
        } catch (e) {
          sshLogger.warn("Failed to parse scrollback buffer", {
            operation: "session_load",
            sessionId,
          });
        }
      }

      const session: TerminalSession = {
        id: sessionId,
        userId,
        hostConfig,
        sessionName: dbSession.sessionName || undefined,
        sshConnection: null,
        sshStream: null,
        scrollbackBuffer,
        connectedClients: new Set(),
        createdAt: new Date(dbSession.createdAt),
        lastAccessedAt: new Date(dbSession.lastAccessedAt),
        status: "active",
        currentDirectory: dbSession.currentDirectory || undefined,
        pendingData: [],
        keyboardInteractiveCallback: null,
      };

      this.sessions.set(sessionId, session);

      sshLogger.info("Session loaded from database", {
        operation: "session_load",
        sessionId,
        userId,
      });

      return session;
    } catch (error) {
      sshLogger.error("Failed to load session from database", error, {
        operation: "session_load_error",
        sessionId,
        userId,
      });
      return null;
    }
  }

  /**
   * Schedule a session save to database (debounced)
   */
  private scheduleSessionSave(sessionId: string): void {
    this.savePending.add(sessionId);

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveAllPendingSessions();
    }, 2000);
  }

  /**
   * Save all pending sessions to database
   */
  private async saveAllPendingSessions(): Promise<void> {
    const sessionIds = Array.from(this.savePending);
    this.savePending.clear();

    for (const sessionId of sessionIds) {
      await this.saveSessionToDB(sessionId);
    }
  }

  /**
   * Save a session to database
   */
  private async saveSessionToDB(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      const db = getDb();
      await db
        .update(terminalSessions)
        .set({
          lastAccessedAt: session.lastAccessedAt.toISOString(),
          scrollbackBuffer: JSON.stringify(session.scrollbackBuffer),
          connectedClients: session.connectedClients.size,
          currentDirectory: session.currentDirectory,
        })
        .where(eq(terminalSessions.id, sessionId));
    } catch (error) {
      sshLogger.error("Failed to save session to database", error, {
        operation: "session_save_error",
        sessionId,
      });
    }
  }

  /**
   * Start periodic save (every 30 seconds)
   */
  private startPeriodicSave(): void {
    setInterval(() => {
      this.saveAllActiveSessions();
    }, 30000);
  }

  /**
   * Save all active sessions to database
   */
  private async saveAllActiveSessions(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.saveSessionToDB(sessionId);
    }
  }

  /**
   * Set keyboard interactive callback for a session
   */
  setKeyboardInteractiveCallback(
    sessionId: string,
    callback: ((responses: string[]) => void) | null,
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.keyboardInteractiveCallback = callback;
    }
  }

  /**
   * Get keyboard interactive callback for a session
   */
  getKeyboardInteractiveCallback(
    sessionId: string,
  ): ((responses: string[]) => void) | null {
    const session = this.sessions.get(sessionId);
    return session?.keyboardInteractiveCallback || null;
  }
}
