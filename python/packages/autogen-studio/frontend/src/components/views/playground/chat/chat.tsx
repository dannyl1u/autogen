import * as React from "react";
import { Button, message, Tooltip } from "antd";
import { convertFilesToBase64, getServerUrl } from "../../../utils/utils";
import { IStatus } from "../../../types/app";
import {
  Run,
  Message,
  WebSocketMessage,
  TeamConfig,
  AgentMessageConfig,
  RunStatus,
  TeamResult,
  Session,
  Component,
  ModelClientStreamingChunkEvent,
} from "../../../types/datamodel";
import { appContext } from "../../../../hooks/provider";
import ChatInput from "./chatinput";
import { teamAPI } from "../../teambuilder/api";
import { sessionAPI } from "../api";
import RunView from "./runview";
import { createTimeoutConfig } from "./types";
import {
  ChevronRight,
  MessagesSquare,
  SplitSquareHorizontal,
  X,
} from "lucide-react";
import SessionDropdown from "./sessiondropdown";
import { RcFile } from "antd/es/upload";
import { useSettingsStore } from "../../settings/store";
const logo = require("../../../../images/landing/welcome.svg").default;

interface ChatViewProps {
  session: Session | null;
  isCompareMode?: boolean;
  isSecondaryView?: boolean; // To know if this is the right panel
  onCompareClick?: () => void;
  onExitCompare?: () => void;
  onSessionChange?: (session: Session) => void;
  availableSessions?: Session[];
  showCompareButton?: boolean;
}

export default function ChatView({
  session,
  isCompareMode = false,
  isSecondaryView = false,
  onCompareClick,
  onExitCompare,
  onSessionChange,
  availableSessions = [],
  showCompareButton = true,
}: ChatViewProps) {
  const serverUrl = getServerUrl();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<IStatus | null>({
    status: true,
    message: "All good",
  });

  // Core state
  const [existingRuns, setExistingRuns] = React.useState<Run[]>([]);
  const [currentRun, setCurrentRun] = React.useState<Run | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const chatContainerRef = React.useRef<HTMLDivElement | null>(null);
  const [streamingContent, setStreamingContent] = React.useState<{
    runId: number;
    content: string;
    source: string;
  } | null>(null);

  // Context and config
  const { user } = React.useContext(appContext);
  // const { session, sessions } = useConfigStore();
  const [activeSocket, setActiveSocket] = React.useState<WebSocket | null>(
    null
  );
  const [teamConfig, setTeamConfig] =
    React.useState<Component<TeamConfig> | null>(null);

  // Get settings for timeout configuration
  const { uiSettings } = useSettingsStore();
  const timeoutConfig = React.useMemo(
    () => createTimeoutConfig(uiSettings.human_input_timeout_minutes || 3),
    [uiSettings.human_input_timeout_minutes]
  );

  const inputTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const activeSocketRef = React.useRef<WebSocket | null>(null);

  // Create a Message object from AgentMessageConfig
  const createMessage = (
    config: AgentMessageConfig,
    runId: number,
    sessionId: number
  ): Message => ({
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    config,
    session_id: sessionId,
    run_id: runId,
    user_id: user?.id || undefined,
  });

  // Load existing runs when session changes
  const loadSessionRuns = async () => {
    if (!session?.id || !user?.id) return;

    try {
      const response = await sessionAPI.getSessionRuns(session.id, user.id);
      setExistingRuns(response.runs);
    } catch (error) {
      console.error("Error loading session runs:", error);
      messageApi.error("Failed to load chat history");
    }
  };

  React.useEffect(() => {
    if (session?.id) {
      loadSessionRuns();
      setCurrentRun(null);
    } else {
      setExistingRuns([]);
      setCurrentRun(null);
    }
  }, [session?.id]);

  // Load team config
  React.useEffect(() => {
    if (session?.team_id && user?.id) {
      teamAPI
        .getTeam(session.team_id, user.id)
        .then((team) => {
          setTeamConfig(team.component);
        })
        .catch((error) => {
          console.error("Error loading team config:", error);
          // messageApi.error("Failed to load team config");
          setTeamConfig(null);
        });
    }
  }, [session]);

  React.useEffect(() => {
    setTimeout(() => {
      if (chatContainerRef.current && existingRuns.length > 0) {
        // Scroll to bottom to show latest run
        chatContainerRef.current.scrollTo({
          top: chatContainerRef.current.scrollHeight,
          behavior: "auto", // Use 'auto' instead of 'smooth' for initial load
        });
      }
    }, 450);
  }, [existingRuns.length, currentRun?.messages]);

  // Cleanup socket on unmount
  React.useEffect(() => {
    return () => {
      if (inputTimeoutRef.current) {
        clearTimeout(inputTimeoutRef.current);
      }
      activeSocket?.close();
    };
  }, [activeSocket]);

  const createRun = async (sessionId: number): Promise<number> => {
    return await sessionAPI.createRun(sessionId, user?.id || "");
  };

  const handleWebSocketMessage = (message: WebSocketMessage) => {
    setCurrentRun((current) => {
      if (!current || !session?.id) return null;
      // console.log("WebSocket message:", message);

      switch (message.type) {
        case "error":
          if (inputTimeoutRef.current) {
            clearTimeout(inputTimeoutRef.current);
            inputTimeoutRef.current = null;
          }
          if (activeSocket) {
            activeSocket.close();
            setActiveSocket(null);
            activeSocketRef.current = null;
          }
          console.log("Error: ", message.error);

          const updatedErrorRun = {
            ...current,
            status: "error" as RunStatus,
            error_message: message.error || "An error occurred",
          };

          // Add to existing runs
          setExistingRuns((prev) => [...prev, updatedErrorRun]);
          return null; // Clear current run

        case "message_chunk":
          if (!message.data) return current;

          // Update streaming content
          try {
            const chunk = message.data as ModelClientStreamingChunkEvent;
            setStreamingContent((prev) => ({
              runId: current.id,
              content: (prev?.content || "") + (chunk.content || ""),
              source: chunk.source || "assistant",
            }));
          } catch (error) {
            console.error("Error parsing message chunk:", error);
          }

          return current; // Keep current run unchanged

        case "message":
          setStreamingContent(null);
          if (!message.data) return current;

          // Create new Message object from websocket data
          const newMessage = createMessage(
            message.data as AgentMessageConfig,
            current.id,
            session.id
          );

          return {
            ...current,
            messages: [...current.messages, newMessage],
          };

        case "input_request":
          if (inputTimeoutRef.current) {
            clearTimeout(inputTimeoutRef.current);
          }

          inputTimeoutRef.current = setTimeout(() => {
            const socket = activeSocketRef.current;
            console.log("Input timeout", socket);

            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: "stop",
                  reason: timeoutConfig.DEFAULT_MESSAGE,
                  code: timeoutConfig.WEBSOCKET_CODE,
                })
              );
              setCurrentRun((prev) =>
                prev
                  ? {
                      ...prev,
                      status: "stopped",
                      error_message: timeoutConfig.DEFAULT_MESSAGE,
                    }
                  : null
              );
            }
          }, timeoutConfig.DURATION_MS);

          return {
            ...current,
            status: "awaiting_input",
          };
        case "result":
        case "completion":
          // When run completes, move it to existingRuns
          const status: RunStatus =
            message.status === "complete"
              ? "complete"
              : message.status === "error"
              ? "error"
              : "stopped";

          const isTeamResult = (data: any): data is TeamResult => {
            return (
              data &&
              "task_result" in data &&
              "usage" in data &&
              "duration" in data
            );
          };

          const updatedRun = {
            ...current,
            status,
            team_result:
              message.data && isTeamResult(message.data) ? message.data : null,
          };

          // Add to existing runs if complete
          if (status === "complete") {
            if (inputTimeoutRef.current) {
              clearTimeout(inputTimeoutRef.current);
              inputTimeoutRef.current = null;
            }
            if (activeSocket) {
              activeSocket.close();
              setActiveSocket(null);
              activeSocketRef.current = null;
            }
            setExistingRuns((prev) => [...prev, updatedRun]);
            return null;
          }

          return updatedRun;

        default:
          return current;
      }
    });
  };

  const handleError = (error: any) => {
    console.error("Error:", error);
    message.error("Error during request processing");

    setCurrentRun((current) => {
      if (!current) return null;

      const errorRun = {
        ...current,
        status: "error" as const,
        error_message:
          error instanceof Error ? error.message : "Unknown error occurred",
      };

      // Add failed run to existing runs
      setExistingRuns((prev) => [...prev, errorRun]);
      return null; // Clear current run
    });

    setError({
      status: false,
      message:
        error instanceof Error ? error.message : "Unknown error occurred",
    });
  };

  const handleInputResponse = async (response: string) => {
    if (!activeSocketRef.current || !currentRun) return;

    if (activeSocketRef.current.readyState !== WebSocket.OPEN) {
      console.error(
        "Socket not in OPEN state:",
        activeSocketRef.current.readyState
      );
      handleError(new Error("WebSocket connection not available"));
      return;
    }

    // Clear timeout when response received
    if (inputTimeoutRef.current) {
      clearTimeout(inputTimeoutRef.current);
      inputTimeoutRef.current = null;
    }

    try {
      activeSocketRef.current.send(
        JSON.stringify({
          type: "input_response",
          response: response,
        })
      );

      setCurrentRun((current) => {
        if (!current) return null;
        return {
          ...current,
          status: "active",
        };
      });
    } catch (error) {
      handleError(error);
    }
  };

  const handleCancel = async () => {
    if (!activeSocketRef.current || !currentRun) return;

    // Clear timeout when manually cancelled
    if (inputTimeoutRef.current) {
      clearTimeout(inputTimeoutRef.current);
      inputTimeoutRef.current = null;
    }
    try {
      activeSocketRef.current.send(
        JSON.stringify({
          type: "stop",
          reason: "Cancelled by user",
        })
      );

      setCurrentRun((current) => {
        if (!current) return null;
        return {
          ...current,
          status: "stopped",
        };
      });
    } catch (error) {
      handleError(error);
    }
  };

  const runTask = async (query: string, files: RcFile[] = []) => {
    setError(null);
    setLoading(true);

    // Add explicit cleanup
    if (activeSocket) {
      activeSocket.close();
      setActiveSocket(null);
      activeSocketRef.current = null;
    }

    if (inputTimeoutRef.current) {
      clearTimeout(inputTimeoutRef.current);
      inputTimeoutRef.current = null;
    }

    if (!session?.id || !teamConfig) {
      setLoading(false);
      return;
    }

    try {
      const runId = await createRun(session.id);

      // Process files using the extracted function
      const processedFiles = await convertFilesToBase64(files);

      // Initialize run state BEFORE websocket connection
      setCurrentRun({
        id: runId,
        created_at: new Date().toISOString(),
        status: "created", // Start with created status
        messages: [],
        task: [
          {
            content: query,
            source: "user",
          },
        ],
        team_result: null,
        error_message: undefined,
      });

      // Setup WebSocket with files
      const socket = setupWebSocket(runId, query, processedFiles);
      setActiveSocket(socket);
      activeSocketRef.current = socket;
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  };

  const setupWebSocket = (
    runId: number,
    query: string,
    files: { name: string; type: string; content: string }[]
  ): WebSocket => {
    if (!session || !session.id) {
      throw new Error("Invalid session configuration");
    }
    // Close existing socket if any
    if (activeSocket?.readyState === WebSocket.OPEN) {
      activeSocket.close();
    }

    const baseUrl = getBaseUrl(serverUrl);
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const auth_token = localStorage.getItem("auth_token");
    const wsUrl = `${wsProtocol}//${baseUrl}/api/ws/runs/${runId}?token=${auth_token}`;

    const socket = new WebSocket(wsUrl);

    // Initialize current run
    setCurrentRun({
      id: runId,
      created_at: new Date().toISOString(),
      status: "active",

      task: [
        createMessage(
          { content: query, source: "user" },
          runId,
          session.id || 0
        ).config,
      ],
      team_result: null,
      messages: [],
      error_message: undefined,
    });

    socket.onopen = () => {
      // Send start message with teamConfig
      socket.send(
        JSON.stringify({
          type: "start",
          task: query,
          files: files,
          team_config: teamConfig,
        })
      );
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
      } catch (error) {
        console.error("WebSocket message parsing error:", error);
      }
    };

    socket.onclose = () => {
      activeSocketRef.current = null;
      setActiveSocket(null);
    };

    socket.onerror = (error) => {
      handleError(error);
    };

    return socket;
  };

  // Helper for WebSocket URL
  const getBaseUrl = (url: string): string => {
    try {
      let baseUrl = url.replace(/(^\w+:|^)\/\//, "");
      if (baseUrl.startsWith("localhost")) {
        baseUrl = baseUrl.replace("/api", "");
      } else if (baseUrl === "/api") {
        baseUrl = window.location.host;
      } else {
        baseUrl = baseUrl.replace("/api", "").replace(/\/$/, "");
      }
      return baseUrl;
    } catch (error) {
      console.error("Error processing server URL:", error);
      throw new Error("Invalid server URL configuration");
    }
  };

  return (
    <div className="text-primary h-[calc(100vh-165px)] bg-primary relative rounded flex-1 scroll">
      {contextHolder}
      <div className="flex pt-2 items-center justify-between text-sm h-10">
        <div className="flex items-center gap-2 min-w-0 overflow-hidden flex-1 pr-4">
          {isCompareMode ? (
            <SessionDropdown
              session={session}
              availableSessions={availableSessions}
              onSessionChange={onSessionChange || (() => {})}
              className="w-full"
            />
          ) : (
            <>
              <span className="text-primary font-medium whitespace-nowrap flex-shrink-0">
                Sessions
              </span>
              {session && (
                <>
                  <ChevronRight className="w-4 h-4 text-secondary flex-shrink-0" />
                  <Tooltip title={session.name}>
                    <span className="text-secondary truncate overflow-hidden">
                      {session.name}
                    </span>
                  </Tooltip>
                </>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0 whitespace-nowrap">
          {!isCompareMode && !isSecondaryView && showCompareButton && (
            <Button
              type="text"
              onClick={onCompareClick}
              icon={<SplitSquareHorizontal className="w-4 h-4" />}
            >
              Compare
            </Button>
          )}
          {isCompareMode && isSecondaryView && (
            <Button
              type="text"
              onClick={onExitCompare}
              icon={<X className="w-4 h-4" />}
            >
              Exit Compare
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-col h-full">
        <div
          ref={chatContainerRef}
          className="flex-1 overflow-y-auto scroll mt-2 min-h-0 relative"
        >
          <div id="scroll-gradient" className="scroll-gradient h-8 top-0">
            {" "}
            <span className="  inline-block h-6"></span>{" "}
          </div>
          <>
            {teamConfig && (
              <>
                {/* Existing Runs */}
                {existingRuns.map((run, index) => (
                  <RunView
                    teamConfig={teamConfig}
                    key={run.id + "-review-" + index}
                    run={run}
                    isFirstRun={index === 0}
                  />
                ))}

                {/* Current Run */}
                {currentRun && (
                  <RunView
                    run={currentRun}
                    teamConfig={teamConfig}
                    onInputResponse={handleInputResponse}
                    onCancel={handleCancel}
                    isFirstRun={existingRuns.length === 0}
                    streamingContent={streamingContent}
                  />
                )}

                {/* No existing runs */}

                {!currentRun && existingRuns.length === 0 && (
                  <div className="flex items-center justify-center h-[80%]">
                    <div className="text-center">
                      <MessagesSquare
                        strokeWidth={1}
                        className="w-64 h-64 mb-4 inline-block"
                      />
                      <div className="  font-medium mb-2">Start a new task</div>
                      <div className="text-secondary text-sm">
                        Enter a task to get started
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* No team config */}
            {!teamConfig && (
              <div className="flex items-center justify-center h-[80%]">
                <div className="text-center  ">
                  <MessagesSquare
                    strokeWidth={1}
                    className="w-64 h-64 mb-4 inline-block"
                  />
                  <div className="  font-medium mb-2">
                    No team configuration found for this session (may have been
                    deleted).{" "}
                  </div>
                  <div className="text-secondary text-sm">
                    Add a team to the session to get started.
                  </div>
                </div>
              </div>
            )}
          </>
        </div>

        {session && teamConfig && (
          <div className="flex-shrink-0">
            <ChatInput
              onSubmit={runTask}
              loading={loading}
              error={error}
              disabled={
                currentRun?.status === "awaiting_input" ||
                currentRun?.status === "active"
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
